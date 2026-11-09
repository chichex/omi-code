// Decide la próxima release a partir de los commits desde el último tag vX.Y.Z.
//
//   node scripts/next-release.ts [--force]
//
// Imprime `version=X.Y.Z`, o `version=` si nada empaquetado cambió: es el formato de $GITHUB_OUTPUT.
// --force pide al menos un patch: el dry-run lo usa para ejercitar el pipeline sin cambios empaquetados.
// Sin dependencias: corre antes de `npm ci`.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface Commit {
	message: string;
	files: string[];
}

const PACKAGED_DIRS = ["src/", "bin/"];
const PACKAGED_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json", "install.sh", "scripts/build-release.ts"]);
const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const LOG_FORMAT = "%x1e%B%x1f";

/** Si el path cambia lo que recibe el usuario. */
export function isPackaged(path: string): boolean {
	if (path.endsWith(".test.ts")) return false;
	return PACKAGED_FILES.has(path) || PACKAGED_DIRS.some((dir) => path.startsWith(dir));
}

function isBreaking(message: string): boolean {
	return /^[a-z]+(\([^)]*\))?!:/.test(message) || /^BREAKING[ -]CHANGE:/m.test(message);
}

function isFeature(message: string): boolean {
	return /^feat(\([^)]*\))?:/.test(message);
}

export function nextVersion(current: string, commits: readonly Commit[], force = false): string | null {
	const messages = commits.filter((commit) => commit.files.some(isPackaged)).map((commit) => commit.message);
	if (messages.length === 0 && !force) return null;
	const [major = 0, minor = 0, patch = 0] = current.split(".").map(Number);
	const breaking = messages.some(isBreaking);
	// Antes de 1.0 lo incompatible sube el minor: llegar a 1.0.0 lo decide un humano.
	if (breaking && major > 0) return `${major + 1}.0.0`;
	if (breaking || messages.some(isFeature)) return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

export function latestVersion(tags: readonly string[]): string | null {
	const versions = tags.flatMap((tag) => {
		const match = VERSION_TAG.exec(tag);
		return match === null ? [] : [[Number(match[1]), Number(match[2]), Number(match[3])] as const];
	});
	versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
	return versions[0]?.join(".") ?? null;
}

export function parseLog(raw: string): Commit[] {
	return raw.split("\x1e").slice(1).map((record) => {
		const [message = "", files = ""] = record.split("\x1f");
		return { message: message.trim(), files: files.split("\n").filter((line) => line !== "") };
	});
}

function git(...args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function plan(force: boolean): string {
	const current = latestVersion(git("tag", "--merged", "HEAD").split("\n"));
	if (current === null) throw new Error("no hay tags vX.Y.Z alcanzables desde HEAD: la versión base la decide un humano");
	const log = git("-c", "core.quotePath=false", "log", "--no-merges", "--no-renames", "--name-only", `--format=${LOG_FORMAT}`, `v${current}..HEAD`);
	return `version=${nextVersion(current, parseLog(log), force) ?? ""}`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
	console.log(plan(values.force));
}
