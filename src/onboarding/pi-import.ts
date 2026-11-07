// Primer arranque: ofrece traer la configuración de Pi a ~/.omi/agent sin tocar ~/.pi/agent.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../cli/io.ts";
import { agentDir, omiHome, piAgentDir } from "../core/paths.ts";

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

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

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

async function importFile(source: string, target: string, name: string): Promise<void> {
	const temporary = `${target}.${randomUUID()}.tmp`;
	const { mode } = await stat(source);
	try {
		if (name === "settings.json") {
			await writeFile(temporary, importedSettings(await readFile(source, "utf8"), dirname(source)), { mode: mode & 0o777, flag: "wx" });
		} else {
			await copyFile(source, temporary, constants.COPYFILE_EXCL);
		}
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function rememberDecision(homeDir: string, decision: PiImportResult["status"]): Promise<void> {
	await mkdir(omiHome(homeDir), { recursive: true, mode: 0o700 });
	await writeFile(join(omiHome(homeDir), ONBOARDING_MARKER), `${JSON.stringify({ piImport: decision })}\n`);
}

export async function runPiImportOnboarding(io: Io): Promise<PiImportResult> {
	const source = piAgentDir(io.homeDir);
	const target = agentDir(io.homeDir);
	if (!io.interactive) return SKIPPED;
	if (await exists(join(omiHome(io.homeDir), ONBOARDING_MARKER))) return SKIPPED;
	if (await hasProviders(target)) return SKIPPED;
	const files = await existingFiles(source, IMPORTABLE_FILES);
	if (files.length === 0) return SKIPPED;

	const answer = await io.prompt(`Encontré configuración de Pi (${files.join(", ")}). ¿Importarla a ~/.omi/agent? [S/n] `);
	if (/^n/i.test(answer.trim())) {
		await rememberDecision(io.homeDir, "declined");
		return { status: "declined", files: [] };
	}
	await mkdir(target, { recursive: true, mode: 0o700 });
	for (const name of files) {
		await importFile(join(source, name), join(target, name), name);
	}
	await rememberDecision(io.homeDir, "imported");
	return { status: "imported", files };
}
