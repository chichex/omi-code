// Primer arranque: ofrece traer la configuración de Pi a ~/.omi/agent sin tocar ~/.pi/agent.

import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Io } from "../cli/io.ts";
import { agentDir, omiHome, piAgentDir } from "../core/paths.ts";

const IMPORTABLE_FILES = ["auth.json", "models.json", "settings.json"] as const;
const PROVIDER_FILES = ["auth.json", "models.json"] as const;
const ONBOARDING_MARKER = "onboarding.json";

/** omi embebe estos paquetes: cargarlos además desde settings duplicaría skills y tools. */
const ABSORBED_PACKAGES = ["git:github.com/chichex/skills", "git:github.com/chichex/chiche"];

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

function withoutAbsorbedPackages(raw: string): string {
	const settings = JSON.parse(raw) as { packages?: unknown };
	if (!Array.isArray(settings.packages)) return raw;
	const packages = settings.packages.filter((entry) => !ABSORBED_PACKAGES.includes(String(entry)));
	return JSON.stringify({ ...settings, packages }, null, 2);
}

async function importFile(source: string, target: string, name: string): Promise<void> {
	const temporary = `${target}.tmp`;
	const { mode } = await stat(source);
	if (name === "settings.json") {
		await writeFile(temporary, withoutAbsorbedPackages(await readFile(source, "utf8")), { mode: mode & 0o777 });
	} else {
		await copyFile(source, temporary, constants.COPYFILE_EXCL);
	}
	try {
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
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
	if ((await existingFiles(target, PROVIDER_FILES)).length > 0) return SKIPPED;
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
