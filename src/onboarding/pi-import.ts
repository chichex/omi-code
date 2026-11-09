// Primer arranque: ofrece traer la configuración de Pi a ~/.omi/agent sin tocar ~/.pi/agent.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../cli/io.ts";
import { painter } from "../cli/style.ts";
import { OmiError } from "../core/errors.ts";
import { agentDir, omiHome, sourcePiAgentDir } from "../core/paths.ts";
import { exists, isDirectory } from "../core/files.ts";
import { renderOutcome, renderQuestion, renderSummary, type OfferRow } from "./pi-import-view.ts";

const SETTINGS_FILE = "settings.json";
const PROVIDER_FILES = ["auth.json", "models.json"] as const;
const ONBOARDING_MARKER = "onboarding.json";
const GRILLS_DIR = "grill-sessions";

/** Identidad del repo sin transporte, .git ni @ref. */
const ABSORBED_PACKAGE = /^(?:git:)?(?:(?:https?:\/\/|ssh:\/\/)?(?:git@)?)github\.com[/:]chichex\/(?:skills|chiche)(?:\.git)?(?:@.+|\/)?$/i;

const OAUTH_WARNING = "Pi y omi compartirían la sesión: si uno renueva el token, el otro puede pedirte login.";

export interface PiImportResult {
	status: "imported" | "declined" | "skipped";
	files: string[];
}

const SKIPPED: PiImportResult = { status: "skipped", files: [] };

const DECISION_KEYS = ["credentialsImport", "settingsImport", "grillImport"] as const;
/** Una sola decisión que antes abarcaba credenciales y ajustes. */
const LEGACY_CONFIG_KEY = "piImport";
const DECISION_VALUES = ["imported", "declined", "skipped"] as const;

type DecisionKey = (typeof DECISION_KEYS)[number];
type DecisionValue = (typeof DECISION_VALUES)[number];
type ImportDecision = Partial<Record<DecisionKey, DecisionValue>>;

/** Grupo que se muestra. Con `files` vacío se informa, pero no se pregunta. */
interface ImportGroup extends OfferRow {
	decisionKey: DecisionKey;
	files: string[];
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

function packageSource(entry: unknown): unknown {
	return typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
}

/** Los settings tal como quedarían en omi. Lanza si no son un objeto JSON. */
function importedSettings(raw: string, base: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ""));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("settings.json no es un objeto");
	const settings = parsed as Record<string, unknown>;
	if (Array.isArray(settings.packages)) {
		settings.packages = settings.packages.filter((entry: unknown) => {
			const source = packageSource(entry);
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
	return settings;
}

/** Código que Pi instalaría o cargaría al arrancar con estos settings. */
function externalCode(settings: Record<string, unknown>): string[] {
	return [settings.packages, settings.extensions].flatMap((list) => Array.isArray(list) ? list.map(packageSource) : [])
		.filter((source): source is string => typeof source === "string");
}

async function hasProviders(dir: string): Promise<boolean> {
	for (const name of PROVIDER_FILES) {
		try {
			const data = JSON.parse((await readFile(join(dir, name), "utf8")).replace(/^﻿/, "")) as Record<string, unknown>;
			const providers = name === "models.json" ? data.providers : data;
			if (typeof providers === "object" && providers !== null && Object.keys(providers).length > 0) return true;
		} catch (error) {
			// No sobrescribir configuración ilegible; el humano debe corregirla.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
		}
	}
	return false;
}

async function usesOAuth(dir: string): Promise<boolean> {
	try {
		const data: unknown = JSON.parse((await readFile(join(dir, "auth.json"), "utf8")).replace(/^﻿/, ""));
		if (typeof data !== "object" || data === null) return false;
		return Object.values(data).some((entry: unknown) => (entry as { type?: unknown } | null)?.type === "oauth");
	} catch {
		return false;
	}
}

async function importFile(source: string, target: string, name: string, overwrite = true): Promise<boolean> {
	const temporary = `${target}.${randomUUID()}.tmp`;
	const { mode } = await stat(source);
	try {
		if (name === SETTINGS_FILE) {
			const settings = importedSettings(await readFile(source, "utf8"), dirname(source));
			await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: mode & 0o777, flag: "wx" });
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

function isDecision(value: unknown): value is DecisionValue {
	return typeof value === "string" && (DECISION_VALUES as readonly string[]).includes(value);
}

async function previousDecision(homeDir: string): Promise<ImportDecision | null> {
	try {
		const value: unknown = JSON.parse(await readFile(join(omiHome(homeDir), ONBOARDING_MARKER), "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
		const data = value as Record<string, unknown>;
		for (const key of [...DECISION_KEYS, LEGACY_CONFIG_KEY]) {
			if (data[key] !== undefined && !isDecision(data[key])) return null;
		}
		const legacy = data[LEGACY_CONFIG_KEY];
		const decision: ImportDecision = isDecision(legacy) ? { credentialsImport: legacy, settingsImport: legacy } : {};
		for (const key of DECISION_KEYS) {
			const stored = data[key];
			if (isDecision(stored)) decision[key] = stored;
		}
		return decision;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
	}
}

async function rememberDecision(homeDir: string, decision: ImportDecision): Promise<void> {
	await mkdir(omiHome(homeDir), { recursive: true, mode: 0o700 });
	await writeFile(join(omiHome(homeDir), ONBOARDING_MARKER), `${JSON.stringify(decision)}\n`);
}

async function missingGrillFiles(source: string, target: string): Promise<string[]> {
	const directory = join(source, GRILLS_DIR);
	if (!(await isDirectory(directory))) return [];
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isFile() || !/\.(json|md)$/.test(entry.name)) continue;
		const stem = entry.name.replace(/\.(json|md)$/, "");
		if (await exists(join(target, GRILLS_DIR, `${stem}.json`)) || await exists(join(target, GRILLS_DIR, `${stem}.md`))) continue;
		files.push(`${GRILLS_DIR}/${entry.name}`);
	}
	return files.sort();
}

async function credentialsGroup(source: string, providersInOmi: boolean): Promise<ImportGroup | null> {
	const files = await existingFiles(source, PROVIDER_FILES);
	if (files.length === 0) return null;
	const row = { decisionKey: "credentialsImport", label: "Credenciales", noun: "credenciales", summary: files.join(", "), defaultYes: false } as const;
	if (providersInOmi) return { ...row, files: [], warnings: ["omi ya tiene credenciales: no se tocan."] };
	return { ...row, files, warnings: await usesOAuth(source) ? [OAUTH_WARNING] : [] };
}

async function settingsGroup(source: string, target: string): Promise<ImportGroup | null> {
	const path = join(source, SETTINGS_FILE);
	if (!(await exists(path))) return null;
	const row = { decisionKey: "settingsImport", label: "Ajustes", noun: "ajustes", summary: SETTINGS_FILE } as const;
	let code: string[];
	try {
		code = externalCode(importedSettings(await readFile(path, "utf8"), source));
	} catch {
		return { ...row, files: [], warnings: ["Ilegible: no se copia."], defaultYes: false };
	}
	const warnings = [
		...(code.length > 0 ? [`Instala y carga: ${code.join(", ")}`] : []),
		...(await exists(join(target, SETTINGS_FILE)) ? ["Reemplaza los ajustes actuales de omi."] : []),
	];
	return { ...row, files: [SETTINGS_FILE], warnings, defaultYes: warnings.length === 0 };
}

async function grillsGroup(source: string, target: string): Promise<ImportGroup | null> {
	const files = await missingGrillFiles(source, target);
	if (files.length === 0) return null;
	const sessions = new Set(files.map((file) => file.replace(/\.(json|md)$/, ""))).size;
	return {
		decisionKey: "grillImport",
		label: "Grills",
		noun: "grills",
		summary: sessions === 1 ? "1 sesión" : `${sessions} sesiones`,
		files,
		warnings: [],
		defaultYes: true,
	};
}

/** Con `again`, las decisiones anteriores no cuentan y lo que no se copia se explica. */
async function importGroups(source: string, target: string, previous: ImportDecision, again: boolean): Promise<ImportGroup[]> {
	const providersInOmi = await hasProviders(target);
	const pending = (key: DecisionKey): boolean => again || previous[key] === undefined;
	const configOpen = again || !providersInOmi;
	const groups = [
		pending("credentialsImport") && configOpen ? await credentialsGroup(source, providersInOmi) : null,
		pending("settingsImport") && configOpen ? await settingsGroup(source, target) : null,
		pending("grillImport") ? await grillsGroup(source, target) : null,
	];
	return groups.filter((group) => group !== null);
}

function isAccepted(answer: string, defaultYes: boolean): boolean {
	const normalized = answer.trim();
	return normalized === "" ? defaultYes : /^(s|si|sí|y|yes)$/i.test(normalized);
}

async function copyGroup(source: string, target: string, group: ImportGroup): Promise<string[]> {
	const copied: string[] = [];
	for (const name of group.files) {
		const isGrill = name.startsWith(`${GRILLS_DIR}/`);
		if (isGrill) await mkdir(join(target, GRILLS_DIR), { recursive: true, mode: 0o700 });
		if (await importFile(join(source, name), join(target, name), name, !isGrill)) copied.push(name);
	}
	return copied;
}

function nextDecision(previous: ImportDecision, offered: readonly ImportGroup[], accepted: readonly ImportGroup[]): ImportDecision {
	const decision: ImportDecision = {};
	for (const key of DECISION_KEYS) {
		const wasOffered = offered.some((group) => group.decisionKey === key);
		const wasAccepted = accepted.some((group) => group.decisionKey === key);
		decision[key] = wasOffered ? (wasAccepted ? "imported" : "declined") : previous[key] ?? "skipped";
	}
	return decision;
}

async function offerImport(io: Io, previous: ImportDecision, again: boolean): Promise<PiImportResult> {
	const source = sourcePiAgentDir(io.homeDir);
	const target = agentDir(io.homeDir);
	const paint = painter(io);
	const groups = await importGroups(source, target, previous, again);
	const offered = groups.filter((group) => group.files.length > 0);
	if (again ? groups.length === 0 : offered.length === 0) return SKIPPED;
	io.err(renderSummary(groups, target, paint));
	if (offered.length === 0) return SKIPPED;

	// Primero todas las respuestas: cancelar a mitad de camino no deja nada copiado.
	const accepted: ImportGroup[] = [];
	for (const group of offered) {
		if (isAccepted(await io.prompt(renderQuestion(group, paint)), group.defaultYes)) accepted.push(group);
	}

	if (accepted.length > 0) await mkdir(target, { recursive: true, mode: 0o700 });
	const files: string[] = [];
	for (const group of accepted) files.push(...await copyGroup(source, target, group));
	await rememberDecision(io.homeDir, nextDecision(previous, offered, accepted));
	io.err(renderOutcome(accepted, accepted.length < offered.length, paint));
	return accepted.length > 0 ? { status: "imported", files } : { status: "declined", files: [] };
}

export async function runPiImportOnboarding(io: Io): Promise<PiImportResult> {
	if (!io.interactive) return SKIPPED;
	const previous = await previousDecision(io.homeDir);
	if (previous === null) { io.err("aviso: onboarding.json ilegible; se omite la importación sin sobrescribirlo"); return SKIPPED; }
	return offerImport(io, previous, false);
}

/** `omi import pi`: pregunta otra vez, aunque ya se haya decidido. */
export async function runPiImportAgain(io: Io): Promise<PiImportResult> {
	const previous = await previousDecision(io.homeDir);
	if (previous === null) {
		throw new OmiError("onboarding_marker_invalid", `${join(omiHome(io.homeDir), ONBOARDING_MARKER)} está ilegible`, { hint: "corregilo o borralo y volvé a intentar" });
	}
	return offerImport(io, previous, true);
}
