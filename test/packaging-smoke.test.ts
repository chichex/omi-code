// Empaquetado real: compila con bun e instala en un HOME temporal. Se corre con
// `npm run test:packaging` porque tarda y genera 75 MB.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import pkg from "../package.json" with { type: "json" };
import { assetNames, currentPlatform } from "../src/upgrade/release.ts";
import { tempDir } from "./helpers/io.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const enabled = process.env.OMI_PACKAGING_SMOKE === "1";

interface Install {
	home: string;
	binary: string;
	release: string;
}

async function buildAndInstall(t: TestContext): Promise<Install> {
	const release = await tempDir(t, "omi-release-");
	const home = await tempDir(t, "omi-home-");
	execFileSync(process.execPath, ["scripts/build-release.ts", "--targets", currentPlatform(), "--out", release], { cwd: root, stdio: "pipe" });
	const installed = spawnSync("sh", ["install.sh"], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, OMI_INSTALL_BASE: `file://${release}` } });
	assert.equal(installed.status, 0, installed.stderr);
	return { home, release, binary: join(home, ".omi/bin/omi") };
}

function rpc(binary: string, home: string, command: unknown): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["--mode", "rpc", "--no-session"], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", () => resolve(output.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>)));
		child.stdin.end(`${JSON.stringify(command)}\n`);
	});
}

test("release real_compila, instala y arranca sin Node ni repo", { skip: !enabled }, async (t) => {
	const { home, binary, release } = await buildAndInstall(t);
	const names = assetNames(currentPlatform());
	assert.deepEqual((await readdir(release)).sort(), [names.binary, names.runtime, "checksums.txt", "install.sh"].sort());

	const version = spawnSync(binary, ["--version"], { encoding: "utf8", cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" } });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), pkg.version);
	assert.equal((await stat(join(home, ".omi/runtime/skills/ship/SKILL.md"))).isFile(), true);
	assert.equal((await stat(join(home, ".omi/runtime/theme/dark.json"))).isFile(), true);

	const [response] = await rpc(binary, home, { id: "1", type: "get_commands" });
	const commands = (response?.data as { commands: { name: string; source: string }[] }).commands;
	const skills = commands.filter((command) => command.source === "skill").map((command) => command.name.replace("skill:", "")).sort();
	assert.deepEqual(skills, ["code-review", "coding-policies", "design-system", "grill", "init", "issue-triage", "land", "run", "ship", "spec", "tdd"]);
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
