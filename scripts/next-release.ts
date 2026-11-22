// Decide la próxima release a partir de los commits desde el último tag vX.Y.Z.
//
//   node scripts/next-release.ts [--force]
//
// Imprime `version=X.Y.Z`, o `version=` si nada empaquetado cambió: es el formato de $GITHUB_OUTPUT.
// --force pide al menos un patch: el dry-run lo usa para ejercitar el pipeline sin cambios empaquetados.
// Sin dependencias: corre antes de `npm ci`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface Commit {
	message: string;
	files: string[];
}

const PACKAGED_DIRS = ["src/", "bin/"];
// bundled-tools fija fd y rg del runtime: subirlos cambia lo que recibe el usuario.
const PACKAGED_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json", "install.sh", "scripts/build-release.ts", "scripts/bundled-tools.ts", "scripts/bundled-tools.json"]);
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

export function plan(force: boolean): string {
	const sourceSha = git("rev-parse", "--verify", "HEAD").trim();
	const names = git("tag", "--merged", sourceSha).split("\n").filter((name) => VERSION_TAG.test(name));
	const current = latestVersion(names);
	if (current === null) throw new Error("no hay tags vX.Y.Z alcanzables desde HEAD: la versión base la decide un humano");
	const tags = names.map((name) => ({ name, sha: git("rev-parse", "--verify", `refs/tags/${name}^{commit}`).trim() }));
	const baseTag = `v${current}`, baseSha = tags.find((tag) => tag.name === baseTag)?.sha;
	if (!baseSha) throw new Error("tag base no resuelto");
	const range = `${baseSha}..${sourceSha}`;
	const log = git("-c", "core.quotePath=false", "log", "--no-merges", "--no-renames", "--name-only", `--format=${LOG_FORMAT}`, range);
	const commits = parseLog(log), version = nextVersion(current, commits, force);
	const evidence = process.env.OMI_RELEASE_PLAN_PATH;
	if (evidence) {
		if (!isAbsolute(evidence)) throw new Error("release plan requiere un archivo absoluto privado");
		const shas = git("log", "--no-merges", "--format=%H", range).trim().split("\n").filter(Boolean);
		// Evidencia separada y sin delimitadores ambiguos dentro del mensaje ni quoting de paths.
		const exact = shas.map((sha) => {
			const message = git("show", "-s", "--format=%B", sha).trim();
			const raw = git("diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-z", "-r", sha);
			if (raw && !raw.endsWith("\0")) throw new Error("manifest Git incompleto");
			return { sha, message: message || "(empty commit message)", files: raw ? raw.slice(0, -1).split("\0") : [] };
		});
		const repo = (process.env.GITHUB_REPOSITORY ?? "").toLowerCase();
		const snapshot = { version: 1, contract: "omi-release-plan-v1", repo, sourceSha, runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
			plannerHash: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), force, complete: names.length <= 1000 && exact.length <= 1000 && shas.length === commits.length && nextVersion(current, exact, force) === version && exact.every((c) => c.files.length <= 1000 && c.files.every((path) => !/[\x00-\x1f\x7f]/.test(path))) && sourceSha === process.env.GITHUB_SHA,
			baseTag, baseSha, tags, commits: exact, nextVersion: version };
		writeFileSync(evidence, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
	}
	return `version=${version ?? ""}`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
	console.log(plan(values.force));
}
