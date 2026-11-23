// Empaquetado real: compila con bun e instala en un HOME temporal. Se corre con
// `npm run test:packaging` porque tarda y genera 75 MB.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import pkg from "../package.json" with { type: "json" };
import bundledTools from "../scripts/bundled-tools.json" with { type: "json" };
import { assetNames, currentPlatform } from "../src/upgrade/release.ts";
import { FOREIGN, OWN, PI_MARKS, requestSeenByModel, seedConfig, seedPi } from "./helpers/foreign-config.ts";
import { installerEnv, newShell } from "./helpers/installer.ts";
import { tempDir } from "./helpers/io.ts";
import { SENTINEL_CONNECT, pathWithout, startupNetwork } from "./helpers/startup-network.ts";
import { exerciseWorkspace, plainTerminal } from "./helpers/workspace-pty.ts";
import { exerciseSubagentRuntime } from "./helpers/subagent-runtime.ts";
import { exerciseSubagentBackgroundRuntime } from "./helpers/subagent-background-runtime.ts";
import { exerciseClaudeBridgeRuntime } from "./helpers/claude-bridge-runtime.ts";

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
	// bash existe en todos los hosts: el instalador configura su archivo de inicio dentro del HOME temporal.
	const installed = spawnSync("sh", ["install.sh"], { cwd: root, encoding: "utf8", env: installerEnv(home, release, { OMI_HOME: installRoot, SHELL: "/bin/bash" }) });
	assert.equal(installed.status, 0, installed.stderr);
	return { home, release, installRoot, binary: join(installRoot, "bin/omi") };
}

function rpc(binary: string, home: string, command: unknown, extraArgs: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		// --offline: un test no sale a la red (ni a la KB real ni a catálogos remotos).
		const child = spawn(binary, ["--mode", "rpc", "--no-session", "--offline", ...extraArgs], { env: { ...process.env, HOME: home, OMI_HOME: "", ...env }, stdio: ["pipe", "pipe", "ignore"] });
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
	// Una terminal nueva encuentra el binario real sin editar nada a mano (issue #23).
	const opened = newShell("/bin/bash", process.platform === "darwin" ? ["-l", "-c"] : ["-i", "-c"], home);
	assert.equal(opened.status, 0, opened.stderr);
	assert.equal(opened.stdout, `${binary}\n${pkg.version}\n`);
	await assert.rejects(stat(join(installRoot, "runtime/skills")));
	assert.equal((await stat(join(installRoot, "runtime/theme/dark.json"))).isFile(), true);
	assert.equal((await stat(join(installRoot, "runtime/claude-bridge/src/index.js"))).isFile(), true, "el bundle se distribuye aunque no haya ejecutable externo");

	// Primer arranque interactivo: es el que Pi reporta como instalación nueva. El fetch de bun sólo
	// deja ver el destino del CONNECT; sin credenciales, el único a pi.dev es la telemetría.
	// Sin fd ni rg en el PATH, Pi los bajaría de GitHub: tiene que usar los del runtime.
	const noTools = await pathWithout(["fd", "fdfind", "rg"], "/usr/bin:/bin", await tempDir(t, "omi-path-"));
	const seen = await startupNetwork(binary, ["--no-mcp", "--no-context-files", "--no-skills"], home, { HOME: home, PATH: noTools, OMI_HOME: installRoot });
	assert.ok(seen.connects.includes(SENTINEL_CONNECT), `la sonda no llegó a la sesión:\n${plainTerminal(seen.output)}`);
	assert.ok(!seen.connects.includes("pi.dev:443"), `conexiones: ${seen.connects.join(", ")}`);
	assert.deepEqual(seen.connects.filter((target) => target.includes("github")), [], "Pi intentó bajar fd o rg");
	assert.doesNotMatch(plainTerminal(seen.output), /not found\. Downloading|Failed to download/);
	for (const [name, label] of [["fd", "fd"], ["rg", "ripgrep"]] as const) {
		const found = seen.tools[name];
		const managed = join(installRoot, "agent/bin", name);
		assert.equal(found?.path, managed, `${name}: ${JSON.stringify(seen.tools)}`);
		assert.equal((await lstat(managed)).isSymbolicLink(), true, `Pi bajó ${name} en vez de usar el del runtime`);
		assert.equal(await realpath(managed), await realpath(join(installRoot, "runtime/bin", name)));
		assert.ok(found.version.startsWith(`${label} ${bundledTools[name].version}`), `${name} no corre: ${found.version}`);
		for (const license of bundledTools[name].licenses) assert.equal((await stat(join(installRoot, "runtime/licenses", name, license))).isFile(), true, license);
	}

	// El workspace también debe funcionar compilado, sin Node ni el repo en PATH.
	const terminal = await exerciseWorkspace(binary, ["--no-extensions", "--no-context-files", "--no-skills", "--offline"], home, { HOME: home, PATH: "/usr/bin:/bin", OMI_HOME: installRoot });
	assert.equal(terminal.code, 0, terminal.output);
	const terminalText = plainTerminal(terminal.output);
	assert.ok(terminalText.includes(`omi code v${version.stdout.trim()}`), "la cabecera coincide con --version del binario instalado");
	for (const label of ["omi code", "¿Qué hacemos en", "SUBAGENTES", "SESIÓN", "Modelo:", "○".repeat(10), "Elegir modelo · OMI", "Cambios locales", "Ubicación de trabajo", "Recursos · equipo donde corre OMI"]) assert.ok(terminalText.includes(label), label);
	assert.doesNotMatch(terminalText, /Extension error|TypeError|no compatible|exceeds terminal width|\[Extensions\]|<inline:omi-|Update Available|pi update/);

	const probe = join(home, "runtime-probe.ts");
	await writeFile(probe, `import { VERSION, getPackageDir, getExamplesPath } from "@earendil-works/pi-coding-agent";\nimport { existsSync } from "node:fs";\nexport default function (pi) { pi.registerCommand("runtime-probe", { description: JSON.stringify({ version: VERSION, packageDir: getPackageDir(), examples: existsSync(getExamplesPath()) }), handler: async () => {} }); }\n`);
	const responses = await rpc(binary, home, { id: "1", type: "get_commands" }, ["--extension", probe]);
	const response = responses.find((line) => line.id === "1");
	const commands = (response?.data as { commands: { name: string; source: string }[] }).commands;
	const skills = commands.filter((command) => command.source === "skill").map((command) => command.name.replace("skill:", "")).sort();
	assert.deepEqual(skills, []);
	const metadata = commands.find((command) => command.name === "runtime-probe") as { description?: string } | undefined;
	const observed = JSON.parse(metadata?.description ?? "null");
	assert.deepEqual(observed, { version: pkg.dependencies["@earendil-works/pi-coding-agent"], packageDir: await realpath(join(installRoot, "runtime")), examples: true });
	const models = await rpc(binary, home, { id: "models", type: "get_available_models" }, [], { PATH: "/usr/bin:/bin", GEMINI_API_KEY: "del-shell" });
	const available = (models.find((line) => line.id === "models")?.data as { models: { provider: string }[] }).models;
	assert.deepEqual(available, [], "sin Claude Code no anuncia el bridge disponible; la API key del shell tampoco habilita otros proveedores");
	const missingBridge = spawnSync(binary, ["--offline", "--no-session", "--model", "claude-bridge/claude-opus-5-5", "-p", "bridge missing"], { cwd: home, env: { HOME: home, OMI_HOME: "", PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15000 });
	assert.equal(missingBridge.status, 1, missingBridge.stderr);
	assert.match(missingBridge.stdout + missingBridge.stderr, /claude auth login/);
	assert.match(missingBridge.stdout + missingBridge.stderr, /provider\.pathToClaudeCodeExecutable/);
	const disabled = await rpc(binary, home, { id: "disabled", type: "get_available_models" }, ["--no-extensions"], { GEMINI_API_KEY: "del-shell" });
	assert.deepEqual((disabled.find((line) => line.id === "disabled")?.data as { models: unknown[] }).models, []);
	const shell = await rpc(binary, home, { id: "env", type: "bash", command: 'printf "%s|%s|%s" "${PI_PACKAGE_DIR-unset}" "${GEMINI_API_KEY-unset}" "${OMI_AGENT_SESSION-unset}"' }, [], { GEMINI_API_KEY: "del-shell" });
	const shellResponse = shell.find((line) => line.id === "env" && line.type === "response");
	assert.ok(shellResponse?.data, JSON.stringify(shell));
	assert.equal((shellResponse.data as { output: string }).output, "unset|del-shell|1");
	// El bash del agente también los encuentra, como los que bajaba Pi.
	const tools = await rpc(binary, home, { id: "tools", type: "bash", command: "fd --version; rg --version | head -n 1" }, [], { PATH: noTools });
	const toolsOutput = (tools.find((line) => line.id === "tools" && line.type === "response")?.data as { output?: string } | undefined)?.output ?? JSON.stringify(tools);
	assert.ok(toolsOutput.startsWith(`fd ${bundledTools.fd.version}\nripgrep ${bundledTools.rg.version} `), toolsOutput);
	const agent = join(installRoot, "agent");
	await exerciseClaudeBridgeRuntime({ command: binary, cwd: home, agent, env: { HOME: home, OMI_HOME: "" } });
	await exerciseClaudeBridgeRuntime({ command: binary, cwd: home, agent, env: { HOME: home, OMI_HOME: "" } }, true);
	await exerciseSubagentRuntime({ command: binary, cwd: home, agent, env: { HOME: home, PATH: "/usr/bin:/bin", OMI_HOME: "" } });
	await exerciseSubagentBackgroundRuntime({ command: binary, cwd: home, agent, env: { HOME: home, PATH: "/usr/bin:/bin", OMI_HOME: "" } });
	const seededCwd = await seedConfig(home, agent);
	const body = await requestSeenByModel({ command: binary, args: ["--offline"], cwd: seededCwd, agent, env: { HOME: home, PATH: "/usr/bin:/bin", OMI_HOME: "" } });
	assert.ok(body.length > 0, "el proveedor no recibió nada");
	for (const mark of Object.values(FOREIGN)) assert.ok(!body.includes(mark), `llegó al modelo: ${mark}`);
	for (const mark of Object.values(OWN)) assert.ok(body.includes(mark), `no llegó al modelo: ${mark}`);
});

const ACCEPT_IMPORT_IN_PTY = `
import os, pty, re, select, sys
binary = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execv(binary, [binary, "import", "pi"])
output, answered = b"", 0
while True:
    if not select.select([fd], [], [], 60)[0]:
        sys.exit("la importación se colgó")
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    prompts = len(re.findall(rb"\\[[sS]/[nN]\\]", output))
    while answered < prompts:
        os.write(fd, b"s\\n")
        answered += 1
status = os.waitpid(pid, 0)[1]
sys.exit(0 if answered > 0 and os.waitstatus_to_exitcode(status) == 0 else f"salió mal: {answered} respuestas")
`;

test("el binario duplica lo que importa: borrás ~/.pi y sigue igual", { skip: !enabled }, async (t) => {
	const { home, binary } = await buildAndInstall(t);
	await seedPi(home);
	const driven = spawnSync("python3", ["-I", "-c", ACCEPT_IMPORT_IN_PTY, binary], { encoding: "utf8", env: { ...process.env, HOME: home, OMI_HOME: "" } });
	assert.equal(driven.status, 0, driven.stderr);
	await rm(join(home, ".pi"), { recursive: true });
	const body = await requestSeenByModel({ command: binary, cwd: home, agent: join(home, ".omi/agent"), env: { HOME: home, PATH: "/usr/bin:/bin", OMI_HOME: "", PI_OFFLINE: "1" } });
	for (const mark of PI_MARKS) assert.ok(body.includes(mark), `no llegó al modelo: ${mark}`);
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
