// Empaquetado real: compila con bun e instala en un HOME temporal. Se corre con
// `npm run test:packaging` porque tarda y genera 75 MB.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import pkg from "../package.json" with { type: "json" };
import { assetNames, currentPlatform } from "../src/upgrade/release.ts";
import { FOREIGN, OWN, requestSeenByModel, seedConfig } from "./helpers/foreign-config.ts";
import { tempDir } from "./helpers/io.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const enabled = process.env.OMI_PACKAGING_SMOKE === "1";

interface Install {
	home: string;
	binary: string;
	release: string;
	installRoot: string;
}

async function buildAndInstall(t: TestContext, custom = false): Promise<Install> {
	const release = await tempDir(t, "omi-release-");
	const home = await tempDir(t, "omi-home-");
	execFileSync(process.execPath, ["scripts/build-release.ts", "--targets", currentPlatform(), "--out", release], { cwd: root, stdio: "pipe" });
	const installRoot = custom ? join(home, "custom omi") : join(home, ".omi");
	const installed = spawnSync("sh", ["install.sh"], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, OMI_HOME: installRoot, OMI_INSTALL_BASE: `file://${release}` } });
	assert.equal(installed.status, 0, installed.stderr);
	return { home, release, installRoot, binary: join(installRoot, "bin/omi") };
}

function rpc(binary: string, home: string, command: unknown, extraArgs: string[] = []): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["--mode", "rpc", "--no-session", ...extraArgs], { env: { ...process.env, HOME: home, OMI_HOME: "" }, stdio: ["pipe", "pipe", "ignore"] });
		let output = "";
		const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("RPC no respondió")); }, 10000);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			for (const line of output.split("\n").slice(0, -1)) {
				if (!line.startsWith("{")) continue;
				const message = JSON.parse(line) as { id?: unknown; type?: string };
				if (message.type === "response" && message.id === (command as { id?: unknown }).id && !child.stdin.writableEnded) child.stdin.end();
			}
		});
		child.on("error", (error) => { clearTimeout(timeout); reject(error); });
		child.on("close", () => { clearTimeout(timeout); resolve(output.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>)); });
		child.stdin.write(`${JSON.stringify(command)}\n`);
	});
}

test("release real_compila, instala y arranca sin Node ni repo", { skip: !enabled }, async (t) => {
	const { home, binary, release, installRoot } = await buildAndInstall(t, true);
	const names = assetNames(currentPlatform());
	assert.deepEqual((await readdir(release)).sort(), [names.binary, names.runtime, "checksums.txt", "install.sh"].sort());

	const version = spawnSync(binary, ["--version"], { encoding: "utf8", cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" } });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), pkg.version);
	assert.equal((await stat(join(installRoot, "runtime/skills/ship/SKILL.md"))).isFile(), true);
	assert.equal((await stat(join(installRoot, "runtime/theme/dark.json"))).isFile(), true);

	const probe = join(home, "runtime-probe.ts");
	await writeFile(probe, `import { VERSION, getPackageDir, getExamplesPath } from "@earendil-works/pi-coding-agent";\nimport { existsSync } from "node:fs";\nexport default function (pi) { pi.registerCommand("runtime-probe", { description: JSON.stringify({ version: VERSION, packageDir: getPackageDir(), examples: existsSync(getExamplesPath()) }), handler: async () => {} }); }\n`);
	const agent = join(installRoot, "agent");
	const seededCwd = await seedConfig(home, agent);
	const responses = await rpc(binary, home, { id: "1", type: "get_commands" }, ["--extension", probe]);
	const response = responses.find((line) => line.id === "1");
	const commands = (response?.data as { commands: { name: string; source: string }[] }).commands;
	const skills = commands.filter((command) => command.source === "skill").map((command) => command.name.replace("skill:", "")).sort();
	assert.deepEqual(skills, ["code-review", "coding-policies", "design-system", "grill", "init", "issue-triage", "land", "propio", "run", "ship", "spec", "tdd"]);
	const metadata = commands.find((command) => command.name === "runtime-probe") as { description?: string } | undefined;
	const observed = JSON.parse(metadata?.description ?? "null");
	assert.deepEqual(observed, { version: pkg.dependencies["@earendil-works/pi-coding-agent"], packageDir: await realpath(join(installRoot, "runtime")), examples: true });
	const shell = await rpc(binary, home, { id: "env", type: "bash", command: 'printf "%s|%s|%s" "${PI_PACKAGE_DIR-unset}" "${OMI_RUNTIME_DIR-unset}" "${OMI_AGENT_SESSION-unset}"' });
	const shellResponse = shell.find((line) => line.id === "env" && line.type === "response");
	assert.ok(shellResponse?.data, JSON.stringify(shell));
	assert.equal((shellResponse.data as { output: string }).output, "unset|unset|1");
	const body = await requestSeenByModel({ command: binary, cwd: seededCwd, agent, env: { HOME: home, PATH: "/usr/bin:/bin", OMI_HOME: "" } });
	assert.ok(body.length > 0, "el proveedor no recibió nada");
	for (const mark of Object.values(FOREIGN)) assert.ok(!body.includes(mark), `llegó al modelo: ${mark}`);
	for (const mark of Object.values(OWN)) assert.ok(body.includes(mark), `no llegó al modelo: ${mark}`);
});

test("omi upgrade --check_corre desde el binario instalado", { skip: !enabled }, async (t) => {
	const { home, binary } = await buildAndInstall(t);
	const server = createServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ tag_name: "v99.0.0", assets: [] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;
	const check = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
		const child = spawn(binary, ["upgrade", "--check", "--json"], { env: { HOME: home, OMI_RELEASES_URL: url }, stdio: ["ignore", "pipe", "inherit"] });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
	});
	assert.equal(check.code, 0);
	assert.deepEqual(JSON.parse(check.stdout), { current: pkg.version, latest: "99.0.0", updateAvailable: true });
});

// Sólo con un pty aparece el prompt, y Node y Bun cierran readline distinto: con Node esto no se reproduce.
const CANCEL_PROMPT_IN_PTY = `
import os, pty, select, signal, sys, time
key, binary = bytes([int(sys.argv[1])]), sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv(binary, [binary])
output, sent_at, start = b"", None, time.time()
while time.time() - (sent_at or start) < 10:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    if sent_at is None and b"/N]" in output:
        os.write(fd, key)
        sent_at = time.time()
if sent_at is None:
    sys.exit("no apareció el prompt")
for _ in range(20):
    if os.waitpid(pid, os.WNOHANG)[0] != 0:
        sys.exit(0)
    time.sleep(0.1)
os.kill(pid, signal.SIGKILL)
sys.exit("el prompt quedó colgado")
`;

test("el binario termina al cancelar el prompt de Pi y no copia nada", { skip: !enabled }, async (t) => {
	const { home, binary } = await buildAndInstall(t);
	await mkdir(join(home, ".pi/agent"), { recursive: true });
	await writeFile(join(home, ".pi/agent/auth.json"), '{"anthropic":{"key":"falsa"}}');
	for (const [name, key] of [["Ctrl+C", "3"], ["Ctrl+D", "4"]] as const) {
		const driven = spawnSync("python3", ["-I", "-c", CANCEL_PROMPT_IN_PTY, key, binary], { encoding: "utf8", env: { ...process.env, HOME: home, OMI_HOME: "" } });
		assert.equal(driven.status, 0, `${name}: ${driven.stderr}`);
	}
	await assert.rejects(stat(join(home, ".omi/agent/auth.json")));
	await assert.rejects(stat(join(home, ".omi/onboarding.json")));
});
