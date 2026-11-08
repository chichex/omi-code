// Primer arranque: ofrece traer la configuración de Pi a ~/.omi/agent sin tocar ~/.pi/agent.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../cli/io.ts";
import { agentDir, omiHome, sourcePiAgentDir } from "../core/paths.ts";
import { exists, isDirectory } from "../core/files.ts";

const IMPORTABLE_FILES = ["auth.json", "models.json", "settings.json"] as const;
const PROVIDER_FILES = ["auth.json", "models.json"] as const;
const ONBOARDING_MARKER = "onboarding.json";

/** Identidad del repo sin transporte, .git ni @ref. */
const ABSORBED_PACKAGE = /^(?:git:)?(?:(?:https?:\/\/|ssh:\/\/)?(?:git@)?)github\.com[/:]chichex\/(?:skills|chiche)(?:\.git)?(?:@.+|\/)?$/i;

export interface PiImportResult {
	status: "imported" | "declined" | "skipped";
	files: string[];
}

const SKIPPED: PiImportResult = { status: "skipped", files: [] };

async function existingFiles(dir: string, names: readonly string[]): Promise<string[]> {
	const found: string[] = [];
	for (const name of names) {
		if (await exists(join(dir, name))) found.push(name);
	}
	return found;
}

function localPath(source: string, base: string): string {
	return /^\.{1,2}(?:\/|$)/.test(source) ? resolve(base, source) : source;
}

function importedSettings(raw: string, base: string): string {
	const settings = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
	if (Array.isArray(settings.packages)) {
		settings.packages = settings.packages.filter((entry: unknown) => {
			const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
			return typeof source !== "string" || !ABSORBED_PACKAGE.test(source);
		}).map((entry: unknown) => {
			if (typeof entry === "string") return localPath(entry, base);
			const pkg = entry as { source?: unknown } | null;
			return typeof pkg?.source === "string" ? { ...pkg, source: localPath(pkg.source, base) } : entry;
		});
	}
	for (const key of ["extensions", "skills", "prompts", "themes"]) {
		if (Array.isArray(settings[key])) settings[key] = settings[key].map((path: unknown) => typeof path === "string" ? localPath(path, base) : path);
	}
	return JSON.stringify(settings, null, 2);
}

async function hasProviders(dir: string): Promise<boolean> {
	for (const name of PROVIDER_FILES) {
		try {
			const data = JSON.parse((await readFile(join(dir, name), "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>;
			const providers = name === "models.json" ? data.providers : data;
			if (typeof providers === "object" && providers !== null && Object.keys(providers).length > 0) return true;
		} catch (error) {
			// No sobrescribir configuración ilegible; el humano debe corregirla.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
		}
	}
	return false;
}

async function importFile(source: string, target: string, name: string, overwrite = true): Promise<boolean> {
	const temporary = `${target}.${randomUUID()}.tmp`;
	const { mode } = await stat(source);
	try {
		if (name === "settings.json") {
			await writeFile(temporary, importedSettings(await readFile(source, "utf8"), dirname(source)), { mode: mode & 0o777, flag: "wx" });
		} else {
			await copyFile(source, temporary, constants.COPYFILE_EXCL);
		}
		if (overwrite) await rename(temporary, target);
		else {
			try { await link(temporary, target); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
		}
		return true;
	} finally {
		await rm(temporary, { force: true });
	}
}

interface ImportDecision { piImport?: string; grillImport?: string }

async function previousDecision(homeDir: string): Promise<ImportDecision | null> {
	try {
		const value: unknown = JSON.parse(await readFile(join(omiHome(homeDir), ONBOARDING_MARKER), "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
		const data = value as Record<string, unknown>;
		for (const key of ["piImport", "grillImport"]) {
			const decision = data[key];
			if (decision !== undefined && (typeof decision !== "string" || !["imported", "declined", "skipped"].includes(decision))) return null;
		}
		return { ...(typeof data.piImport === "string" ? { piImport: data.piImport } : {}), ...(typeof data.grillImport === "string" ? { grillImport: data.grillImport } : {}) };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
	}
}

async function rememberDecision(homeDir: string, decision: ImportDecision): Promise<void> {
	await mkdir(omiHome(homeDir), { recursive: true, mode: 0o700 });
	await writeFile(join(omiHome(homeDir), ONBOARDING_MARKER), `${JSON.stringify(decision)}\n`);
}

async function missingGrillFiles(source: string, target: string): Promise<string[]> {
	const directory = join(source, "grill-sessions");
	if (!(await isDirectory(directory))) return [];
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isFile() || !/\.(json|md)$/.test(entry.name)) continue;
		const stem = entry.name.replace(/\.(json|md)$/, "");
		if (await exists(join(target, "grill-sessions", `${stem}.json`)) || await exists(join(target, "grill-sessions", `${stem}.md`))) continue;
		files.push(`grill-sessions/${entry.name}`);
	}
	return files.sort();
}

export async function runPiImportOnboarding(io: Io): Promise<PiImportResult> {
	const source = sourcePiAgentDir(io.homeDir);
	const target = agentDir(io.homeDir);
	if (!io.interactive) return SKIPPED;
	const previous = await previousDecision(io.homeDir);
	if (previous === null) { io.err("aviso: onboarding.json ilegible; se omite la importación sin sobrescribirlo"); return SKIPPED; }
	const config = previous.piImport !== undefined || await hasProviders(target) ? [] : await existingFiles(source, IMPORTABLE_FILES);
	const grills = previous.grillImport === undefined ? await missingGrillFiles(source, target) : [];
	const files = [...config, ...grills];
	if (files.length === 0) return SKIPPED;

	const answer = await io.prompt(`Encontré configuración de Pi (${files.join(", ")}). ¿Importarla a ${target}? [S/n] `);
	if (/^n/i.test(answer.trim())) {
		await rememberDecision(io.homeDir, { piImport: previous.piImport ?? "declined", grillImport: "declined" });
		return { status: "declined", files: [] };
	}
	await mkdir(target, { recursive: true, mode: 0o700 });
	const imported: string[] = [];
	for (const name of files) {
		if (name.startsWith("grill-sessions/")) await mkdir(join(target, "grill-sessions"), { recursive: true, mode: 0o700 });
		if (await importFile(join(source, name), join(target, name), name, !name.startsWith("grill-sessions/"))) imported.push(name);
	}
	await rememberDecision(io.homeDir, { piImport: previous.piImport ?? (config.length > 0 ? "imported" : "skipped"), grillImport: "imported" });
	return { status: "imported", files: imported };
}
