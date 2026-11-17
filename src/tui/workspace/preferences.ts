import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "../../core/paths.ts";

export const SIDEBAR_SECTIONS = [
	{ id: "workspace", label: "Proyecto" },
	{ id: "session", label: "Sesión" },
	{ id: "actions", label: "GitHub Actions" },
	{ id: "omi", label: "OMI" },
	{ id: "subagents", label: "Subagentes" },
	{ id: "resources", label: "Recursos" },
	{ id: "issue", label: "Issue activo" },
] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTIONS)[number]["id"];
export interface WorkspacePreferences { favorites: string[]; sidebar: boolean; hiddenSections?: SidebarSectionId[] }

function isSectionId(value: unknown): value is SidebarSectionId {
	return SIDEBAR_SECTIONS.some((section) => section.id === value);
}
function preferencesFrom(value: unknown): WorkspacePreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { favorites: [], sidebar: true };
	const preferences: WorkspacePreferences = {
		favorites: "favorites" in value && Array.isArray(value.favorites)
			? value.favorites.filter((key): key is string => typeof key === "string" && key.length < 512).slice(0, 1000) : [],
		sidebar: !("sidebar" in value && value.sidebar === false),
	};
	// No agregar el campo a archivos anteriores. Un valor inválido deja todo visible.
	if ("hiddenSections" in value && Array.isArray(value.hiddenSections)) {
		preferences.hiddenSections = [...new Set(value.hiddenSections.filter(isSectionId))];
	}
	return preferences;
}

export async function loadWorkspacePreferences(home: string): Promise<WorkspacePreferences> {
	try {
		const value: unknown = JSON.parse(await readFile(join(agentDir(home), "workspace-ui.json"), "utf8"));
		return preferencesFrom(value);
	} catch { /* Una preferencia rota no impide arrancar. */ }
	return { favorites: [], sidebar: true };
}
export async function saveWorkspacePreferences(home: string, preferences: WorkspacePreferences): Promise<void> {
	const dir = agentDir(home); await mkdir(dir, { recursive: true, mode: 0o700 });
	const target = join(dir, "workspace-ui.json"); const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(preferencesFrom(preferences)) + "\n", { mode: 0o600, flag: "wx" });
		await rename(temporary, target);
	} finally { await rm(temporary, { force: true }); }
}
