// install.sh contra una release falsa en disco: sin red y sin la config de shell de quien corre el test.

import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { assetNames, currentPlatform } from "../../src/upgrade/release.ts";
import { tempDir } from "./io.ts";

export const INSTALL_SCRIPT = fileURLToPath(new URL("../../install.sh", import.meta.url));

/** Variables que apuntan a la config real del shell o cambian el instalador: un test nunca las hereda. */
const INHERITED_CONFIG = ["ZDOTDIR", "XDG_CONFIG_HOME", "BASH_ENV", "ENV", "OMI_HOME", "OMI_NO_MODIFY_PATH"];

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export interface FakeReleaseOptions {
	binary?: string;
	bundled?: string;
	tamper?: boolean;
	/** Plataforma de los assets; por defecto, la del host. */
	platform?: string;
}

/** Publica en una carpeta lo mismo que una release, con scripts en vez de binarios. */
export async function fakeRelease(t: TestContext, options: FakeReleaseOptions = {}): Promise<string> {
	const dir = await tempDir(t);
	const stage = await tempDir(t);
	const names = assetNames(options.platform ?? currentPlatform());
	const bundled = options.bundled ?? "#!/bin/sh\necho 1.0.0\n";
	await mkdir(join(stage, "theme"), { recursive: true });
	await writeFile(join(stage, "theme/dark.json"), "x\n");
	await writeFile(join(stage, "omi"), bundled, { mode: 0o755 });
	await writeFile(join(dir, names.binary), options.binary ?? "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
	execFileSync("tar", ["-czf", join(dir, names.runtime), "-C", stage, "."]);
	const lines: string[] = [];
	for (const name of [names.binary, names.runtime]) lines.push(`${sha256(await readFile(join(dir, name)))}  ${name}`);
	await writeFile(join(dir, "checksums.txt"), `${lines.join("\n")}\n`);
	if (options.tamper === true) await writeFile(join(dir, names.binary), "#!/bin/sh\necho malo\n");
	return dir;
}

/** Entorno del instalador: HOME temporal y la release en disco. `extra` con `undefined` quita la variable. */
export function installerEnv(home: string, base: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of INHERITED_CONFIG) delete env[name];
	return { ...env, HOME: home, OMI_INSTALL_BASE: `file://${base}`, ...extra };
}

/** Corre install.sh. Con `piped`, el script entra por stdin, como en `curl … | sh`. */
export async function runInstaller(base: string, home: string, extra: NodeJS.ProcessEnv = {}, piped = false): Promise<SpawnSyncReturns<string>> {
	const env = installerEnv(home, base, extra);
	if (!piped) return spawnSync("sh", [INSTALL_SCRIPT], { encoding: "utf8", env });
	return spawnSync("sh", [], { encoding: "utf8", env, input: await readFile(INSTALL_SCRIPT, "utf8") });
}

/** Un `uname` que dice ser otra plataforma, para probar la rama de macOS o de Linux en cualquier host. */
export async function fakeUname(t: TestContext, platform: string): Promise<string> {
	const [os, arch] = platform.split("-");
	const dir = await tempDir(t);
	const kernel = os === "darwin" ? "Darwin" : "Linux";
	const machine = arch === "arm64" ? "arm64" : "x86_64";
	await writeFile(join(dir, "uname"), `#!/bin/sh\ncase "$1" in\n\t-s) echo ${kernel} ;;\n\t-m) echo ${machine} ;;\n\t*) exit 1 ;;\nesac\n`, { mode: 0o755 });
	return dir;
}

/** Ruta absoluta de un comando del host, o `undefined` si no está instalado. */
export function hostCommand(name: string): string | undefined {
	const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" });
	const path = found.stdout.trim();
	return found.status === 0 && path.startsWith("/") ? path : undefined;
}

/**
 * Un shell nuevo, como al abrir una terminal: arranca con un PATH mínimo, sin el de quien corre
 * el test, así que sólo encuentra `omi` si sus archivos de inicio lo agregan.
 */
export function newShell(shell: string, flags: string[], home: string, extra: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
	return spawnSync(shell, [...flags, "command -v omi && omi --version"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb", ...extra } });
}
