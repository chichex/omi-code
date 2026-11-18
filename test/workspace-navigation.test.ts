import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WORKSPACE_VIEWS, workspaceTabs } from "../src/tui/workspace/navigation.ts";

test("workspace_navegación única: Chat, Issues, PRs, Cambios, OMI y Progreso en ese orden", () => {
	assert.deepEqual(WORKSPACE_VIEWS.map((view) => view.label), ["Chat", "Issues", "PRs", "Cambios", "OMI", "Progreso"]);
	assert.deepEqual(WORKSPACE_VIEWS.map((view) => view.key), ["ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6"]);
	assert.equal(new Set(WORKSPACE_VIEWS.map((view) => view.command)).size, 6);
});

test("workspace_pestañas conservan la activa y los seis números al achicar, con hit boxes exactos", () => {
	for (const width of [28, 40, 52, 80, 110, 132, 160]) for (const active of WORKSPACE_VIEWS) {
		const tabs = workspaceTabs(width, active.id); const output = tabs.map((tab) => tab.label).join("");
		assert.ok(visibleWidth(output) <= width, `${width}: ${output}`);
		assert.equal(tabs.length, 6); assert.match(output, new RegExp(`\\[${WORKSPACE_VIEWS.indexOf(active) + 1} ${active.label}\\]`));
		let column = 0;
		for (const tab of tabs) { assert.equal(tab.start, column); column += visibleWidth(tab.label); assert.equal(tab.end, column); }
		assert.ok(!tabs.some((tab) => width >= tab.start && width < tab.end), "el espacio sobrante no activa una pestaña");
	}
});
