import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundAnsi, parseColor, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getActiveBackgroundAnsi } from "../node_modules/@earendil-works/pi-tui/dist/utils.js";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { GitSnapshot, Resources } from "../src/tui/workspace/data.ts";
import type { IssueTriageState } from "../src/tui/workspace/issue-triage.ts";
import { workspaceSidebar } from "../src/tui/workspace/sidebar.ts";
import { SubagentMonitor } from "../src/tui/workspace/subagents.ts";

const sectionIds = ["workspace", "session", "actions", "omi", "subagents", "resources", "issue"] as const;
const titles = ["PROYECTO", "SESIÓN", "GITHUB ACTIONS", "OMI", "SUBAGENTES", "RECURSOS", "ISSUE ACTIVO"];
type State = Parameters<typeof workspaceSidebar>[0];
const git: GitSnapshot = { root: "/repo/Proyecto漢🙂", gitDir: "/repo/.git", commonDir: "/repo/.git", mainRoot: "/repo", linked: true,
	branch: "feat/sidebar", detached: false, changes: [], changeCount: 3, tracking: true, ahead: 2, behind: 1 };
const resources: Resources = { host: "host-漢🙂", cpu: 37, processCpu: 2.5, totalRam: 16 * 2 ** 30, availableRam: 6 * 2 ** 30, rss: 256 * 2 ** 20,
	memoryEstimated: true, disk: { total: 100 * 2 ** 30, used: 41 * 2 ** 30, available: 59 * 2 ** 30 } };
const issue: IssueTriageState = { version: 1, issue: { number: 42, title: "ISSUE_VISIBLE 漢🙂", url: "" },
	triage: { type: "fix", summary: "Corregir lateral", rationale: "Bug", scope: [], acceptanceCriteria: [], questions: [] },
	worktree: git.root, branch: git.branch, baseRef: "main", baseCommit: "a".repeat(40) };
function state(overrides: Partial<State> = {}): State {
	return { theme: getThemeByName("dark")!, cwd: git.root, height: 64, git, gitError: false, resources,
		actions: { reviews: { error: "Offline" }, releases: { error: "Offline" } }, project: "acme/tienda", context: { label: "56k / 200k", percent: 28, limit: 200000 },
		model: { name: "Modelo real", provider: "proveedor-real" }, thinking: "high", subagents: new SubagentMonitor(), issueTriage: issue,
		session: { input: 12000, output: 3400, cacheRead: 50000, cacheWrite: 1000, cost: .1234, lastCost: .0234, responses: 3 }, ...overrides };
}
function plain(result: ReturnType<typeof workspaceSidebar>): string[] { return result.lines.map(stripTerminalSequences); }
function populated(): SubagentMonitor {
	const monitor = new SubagentMonitor();
	monitor.start("eight", { tasks: Array.from({ length: 8 }, (_, index) => ({ agent: "worker", task: `Tarea ${index + 1}` })) });
	return monitor;
}

test("workspace_sidebar_render usa rectángulos y orden unificado sin encabezados heredados", () => {
	const result = workspaceSidebar(state(), 41); const rows = plain(result);
	const starts = titles.map((title) => rows.findIndex((row) => row.includes(title)));
	assert.ok(starts.every((row) => row >= 0), rows.join("\n")); assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
	assert.equal(rows.filter((row) => row.startsWith("┌")).length, 7); assert.equal(rows.filter((row) => row.startsWith("└")).length, 7);
	assert.doesNotMatch(rows.join("\n"), /▌|█|CONTEXTO|EQUIPO/);
	const sessionRows = rows.slice(starts[1], starts[2]);
	for (const expected of [/Modelo real/, /proveedor-real/, /Razonamiento.*[●○◯]/, /56k \/ 200k.*28%|28%.*56k \/ 200k/, /12k.*3\.4k/, /50k.*1k/, /\$0\.1234/]) assert.match(sessionRows.join("\n"), expected);
	for (const [pattern, target] of [[/Modelo real|proveedor-real|Razonamiento/, "model"], [/56k \/ 200k|12k.*3\.4k|50k.*1k|\$0\.1234/, "context"]] as const) {
		for (const [index, row] of rows.entries()) if (pattern.test(row)) assert.equal(result.targets.get(index), target, row);
	}
	for (const [index, row] of rows.entries()) if (/SESIÓN/.test(row)) assert.equal(result.targets.get(index), "model");
	assert.equal(rows.at(-1)!.trim(), "Personalizar lateral >"); assert.equal(result.targets.get(rows.length - 1), "sidebar-settings");
});

test("workspace_sidebar_render ancho exacto, ANSI y Unicode en alturas soportadas", () => {
	for (const width of [41, 48]) for (const height of [20, 26, 34, 64]) {
		const result = workspaceSidebar(state({ height, subagents: populated() }), width); const rows = plain(result);
		assert.equal(rows.length, height); assert.ok(result.lines.every((line) => visibleWidth(line) === width), `${width}x${height}`);
		for (const title of titles) assert.ok(rows.some((row) => row.includes(title)), `${width}x${height}: ${title}\n${rows.join("\n")}`);
		assert.match(rows.join("\n"), /#42/); assert.match(rows.join("\n"), /ISSUE_VISIBLE 漢🙂/);
		assert.equal(rows.at(-1)!.trim(), "Personalizar lateral >");
		const lastBorder = rows.findLastIndex((row) => row.startsWith("└")); assert.ok(lastBorder >= 0 && lastBorder < height - 1);
		assert.match(rows[lastBorder]!, /└.*┘$/); assert.ok(rows.slice(lastBorder + 1, -1).every((row) => !row.trim()));
		if (height >= 34) assert.equal(rows.filter((row) => row.startsWith("┌")).length, 7, "rectángulos individuales cuando hay espacio");
		assert.ok([...result.targets.keys()].every((row) => row >= 0 && row < height));
		assert.match(rows.join("\n"), height < 34 ? /8.*(?:cola|más)|(?:cola|más).*8/ : /worker/);
		if (height === 64) assert.equal(rows.filter((row) => /worker/.test(row)).length, 8, "los ocho tasks se expanden si caben");
		for (const [index, row] of rows.entries()) if (!row.trim()) assert.equal(result.targets.has(index), false, "padding nunca abre detalles");
	}
});

test("workspace_sidebar_render recursos usan diez círculos por métrica y RAM GiB en una sola fila", () => {
	for (const width of [41, 48]) for (const height of [20, 64]) {
		const rows = plain(workspaceSidebar(state({ height }), width));
		for (const [name, value] of [["CPU", /37%/], ["RAM", /10(?:\.0)?\s*\/\s*16(?:\.0)?\s*GiB/], ["Disco", /41%/]] as const) {
			const row = rows.find((line) => new RegExp(`│ ${name}`).test(line)); assert.ok(row, rows.join("\n"));
			assert.equal((row.match(/[●○◯]/g) ?? []).length, 10, row); assert.match(row, value);
		}
	}
});

test("workspace_sidebar_render ocultar una sección remueve sus filas y targets sin huecos", () => {
	for (const id of sectionIds) for (const height of [20, 26, 34, 64]) {
		const result = workspaceSidebar(state({ height, hiddenSections: [id] }), 41); const rows = plain(result);
		assert.ok(!rows.some((row) => /^[┌├]/.test(row) && row.includes(titles[sectionIds.indexOf(id)]!)), id);
		const removed = id === "session" ? ["model", "context"] : id === "issue" ? ["issues"] : [id];
		for (const target of result.targets.values()) assert.ok(!removed.includes(target), `${id}: ${target}`);
		const lastBorder = rows.findLastIndex((row) => row.startsWith("└"));
		assert.ok(rows.slice(0, lastBorder + 1).every((row) => row.trim()), "no queda espacio reservado para ocultos");
	}
	for (const height of [20, 64]) {
		const result = workspaceSidebar(state({ height, hiddenSections: sectionIds }), 41); const rows = plain(result);
		assert.ok(rows.slice(0, -1).every((row) => !row.trim())); assert.deepEqual([...result.targets], [[height - 1, "sidebar-settings"]]);
		assert.equal(rows.at(-1)!.trim(), "Personalizar lateral >");
	}
});

test("workspace_sidebar_render mantiene toda la superficie negra u ofrece blanco accesible en tema claro", () => {
	for (const appearance of ["dark", "light"] as const) {
		const theme = getThemeByName(appearance)!; const result = workspaceSidebar(state({ theme, height: 34 }), 41);
		const expected = backgroundAnsi(parseColor(appearance === "dark" ? "#000000" : "#ffffff"), theme.getColorMode());
		for (const row of result.lines) {
			for (let column = 0; column < 41; column++) assert.equal(getActiveBackgroundAnsi(sliceByColumn(row, 0, column + 1)), expected, `${appearance} columna ${column}`);
			assert.equal(getActiveBackgroundAnsi(row), "", "no filtra fondo a otros componentes");
		}
	}
});

test("workspace_sidebar_render no inventa contexto, uso, Git, recursos ni runs al faltar datos", () => {
	for (const height of [20, 64]) {
		const rows = plain(workspaceSidebar(state({ height, git: undefined, resources: undefined, model: undefined, thinking: undefined, session: undefined,
			project: undefined, envAt: undefined, context: { label: "— / 200k", percent: undefined, limit: 200000 }, actions: { reviews: {}, releases: {} }, issueTriage: undefined }), 41));
		const screen = rows.join("\n"); assert.match(screen, /Sin repositorio Git/); assert.match(screen, /— \/ 200k/); assert.match(screen, /Consultando/);
		assert.doesNotMatch(screen, /Al día|sin upstream|Sin runs|Sin ejecuciones|\$0|0%|0 GiB|0 \/ 200k|ISSUE ACTIVO/);
	}
});

test("workspace_sidebar_render Unicode ancho y ANSI externos no desbordan ni inyectan controles", () => {
	const name = "漢字🙂e\u0301".repeat(20) + "\x1b]8;;https://example.test\x07\n";
	for (const width of [41, 48]) for (const height of [20, 64]) {
		const result = workspaceSidebar(state({ height, model: { name, provider: name }, git: { ...git, branch: name },
			resources: { ...resources, host: name }, issueTriage: { ...issue, branch: name, issue: { ...issue.issue, title: name } } }), width);
		assert.ok(result.lines.every((row) => visibleWidth(row) === width));
		assert.doesNotMatch(result.lines.join("\n"), /\x1b\]8|\x07/); assert.doesNotMatch(plain(result).join(""), /[\x00-\x1f\x7f-\x9f]/);
		assert.ok(plain(result).some((row) => row.includes("漢字🙂")));
	}
});

test("workspace_sidebar_render alto cero no deja contenido ni targets al desmontar", () => {
	const result = workspaceSidebar(state({ height: 0 }), 41);
	assert.deepEqual(result.lines, []); assert.equal(result.targets.size, 0);
});

test("workspace_sidebar_render sin respuestas no inventa un costo de sesión cero", () => {
	const result = workspaceSidebar(state({ session: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastCost: 0, responses: 0 } }), 41);
	assert.doesNotMatch(plain(result).join("\n"), /Costo|Cache|Uso|\$0/);
});

test("workspace_sidebar_render nunca hereda el issue de otra rama o worktree", () => {
	for (const other of [{ ...git, branch: "main" }, { ...git, root: "/other" }]) {
		assert.doesNotMatch(plain(workspaceSidebar(state({ git: other }), 41)).join("\n"), /ISSUE ACTIVO|ISSUE_VISIBLE|#42/);
	}
});

test("workspace_sidebar_render conserva fallas de subagentes aun cuando sólo cabe el resumen", () => {
	const monitor = populated();
	monitor.update("eight", { results: Array.from({ length: 8 }, () => ({ status: "error" })) });
	const result = workspaceSidebar(state({ height: 20, subagents: monitor }), 41);
	assert.match(plain(result).join("\n"), /8 errores/);
});

test("workspace_sidebar_render compacta sin confundir errores ni destinos de detalle", () => {
	for (const height of [20, 26, 64]) {
		const run = { id: 1, name: "RUN_REAL", status: "completed", conclusion: "success", createdAt: new Date().toISOString(), url: "" };
		const result = workspaceSidebar(state({ height, gitError: true, envError: "Offline", project: undefined,
			actions: { reviews: { runs: [run], error: "Falló la lectura" }, releases: { error: "Offline" } } }), 41);
		const rows = plain(result); const screen = rows.join("\n");
		assert.match(screen, /desactualizado/i); assert.match(screen, /Offline/); assert.doesNotMatch(screen, /Sin runs|Sin ejecuciones/);
		const actionStart = rows.findIndex((row) => row.includes("GITHUB ACTIONS")); const omiStart = rows.findIndex((row) => /[─ ]OMI[ ·─]/.test(row));
		assert.equal(result.targets.get(actionStart), "actions"); assert.equal(result.targets.get(omiStart), "omi");
		for (const [index, row] of rows.entries()) if (row.includes("ISSUE_VISIBLE")) assert.notEqual(result.targets.get(index), "resources");
	}
});
