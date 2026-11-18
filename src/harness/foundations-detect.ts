// Propuesta de Foundations a partir de archivos del repo. Sólo lee: nunca ejecuta un script ni un gestor.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { STRICT_POLICY, type FoundationsBlock } from "./foundations.ts";

const MAX_MANIFEST = 1024 * 1024;
// Gates y preparación habituales; deploy, publish o hooks de instalación no entran.
const SCRIPT = /^(?:test|typecheck|lint|check|build|format:check|test:[a-z0-9_.:-]+|lint:[a-z0-9_.:-]+)$/;
const MANAGERS = [
	{ lock: "package-lock.json", install: "npm ci", run: "npm run", test: "npm test" },
	{ lock: "pnpm-lock.yaml", install: "pnpm install --frozen-lockfile", run: "pnpm run", test: "pnpm test" },
	{ lock: "yarn.lock", install: "yarn install --frozen-lockfile", run: "yarn run", test: "yarn test" },
	// `bun test` es el runner propio de bun, no el script.
	{ lock: "bun.lock", install: "bun install --frozen-lockfile", run: "bun run", test: "bun run test" },
	{ lock: "bun.lockb", install: "bun install --frozen-lockfile", run: "bun run", test: "bun run test" },
];

async function regularFile(path: string): Promise<boolean> {
	try { const entry = await lstat(path); return entry.isFile() && entry.size <= MAX_MANIFEST; } catch { return false; }
}
async function scripts(root: string): Promise<string[] | undefined> {
	const path = join(root, "package.json");
	if (!(await regularFile(path))) return undefined;
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		const scripts = value && typeof value === "object" && "scripts" in value ? value.scripts : undefined;
		if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
		return Object.keys(scripts).filter((name) => SCRIPT.test(name));
	} catch { return undefined; }
}

/** Un comando propuesto y de dónde sale, para mostrarlo junto a la opción. */
export interface DetectedCommand { command: string; source: string }

/** Comandos exactos que se proponen para el catálogo, en el orden en que aparecen, con su origen. */
export async function detectFoundationsCandidates(root: string): Promise<DetectedCommand[]> {
	const found: DetectedCommand[] = [];
	const names = await scripts(root);
	if (names?.length) {
		let manager = { lock: "", install: "", run: "npm run", test: "npm test" };
		for (const candidate of MANAGERS) if (await regularFile(join(root, candidate.lock))) { manager = candidate; break; }
		if (manager.install) found.push({ command: manager.install, source: `Instala las dependencias según ${manager.lock}` });
		for (const name of names) found.push({ command: name === "test" ? manager.test : `${manager.run} ${name}`, source: `Script «${name}» de package.json` });
	}
	if (await regularFile(join(root, "go.mod"))) found.push({ command: "go test ./...", source: "Tests del módulo de go.mod" }, { command: "go vet ./...", source: "Análisis estático del módulo de go.mod" });
	// Un comando repetido conserva su primera aparición, con su origen.
	const unique = new Map<string, DetectedCommand>();
	for (const entry of found) if (!unique.has(entry.command)) unique.set(entry.command, entry);
	return [...unique.values()].slice(0, 100);
}

/** Primera propuesta: los comandos detectados y los cuatro puntos en ask. */
export function proposeFoundations(repo: string, commands: string[]): FoundationsBlock {
	return { version: 1, repo: repo.toLowerCase(), comandos: [...commands], politica: { ...STRICT_POLICY } };
}
