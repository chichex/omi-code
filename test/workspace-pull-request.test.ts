import assert from "node:assert/strict";
import { test } from "node:test";
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { footerStatus, readBranchPullRequest, type BranchPullRequest } from "../src/tui/workspace/pull-request.ts";
import type { GitSnapshot } from "../src/tui/workspace/data.ts";
import { surface } from "../src/tui/workspace/presentation.ts";

const git = { root: "/repo", branch: "feature", detached: false } as GitSnapshot;
const rawPr = { number: 7, title: "Footer PR", url: "https://github.com/example/repo/pull/7", isDraft: true, state: "OPEN" };
const pr: BranchPullRequest = { number: 7, title: rawPr.title, url: rawPr.url, draft: true, state: "OPEN" };

test("workspace_PR actual usa la resolución de gh, no el primer PR creado o de la lista del repo", async () => {
	const signal = new AbortController().signal;
	assert.deepEqual(await readBranchPullRequest(git, signal, async (command, args, cwd, receivedSignal) => {
		assert.equal(command, "gh"); assert.equal(cwd, git.root); assert.equal(receivedSignal, signal);
		assert.deepEqual(args, ["pr", "status", "--json", "number,title,url,isDraft,state"]);
		return { code: 0, stdout: JSON.stringify({ currentBranch: rawPr, createdBy: [{ ...rawPr, number: 8 }], needsReview: [] }) };
	}), pr);
	for (const state of ["OPEN", "CLOSED", "MERGED"]) assert.equal((await readBranchPullRequest(git, undefined, async () => ({ code: 0, stdout: JSON.stringify({ currentBranch: { ...rawPr, state } }) })))?.state, state);
	for (const value of [{}, { createdBy: [rawPr] }, { currentBranch: null }]) assert.equal(await readBranchPullRequest(git, undefined, async () => ({ code: 0, stdout: JSON.stringify(value) })), undefined);
	assert.equal(await readBranchPullRequest({ ...git, detached: true }, undefined, async () => { throw new Error("no ejecutar"); }), undefined);
});

test("workspace_PR actual no convierte errores en ausencia de PR ni permite inyectar URLs o controles", async () => {
	for (const result of [{ code: 1, stdout: "" }, { code: 0, stdout: "{}", truncated: true }, { code: 0, stdout: "broken" }, { code: 0, stdout: "[]" }, { code: 0, stdout: "null" }]) await assert.rejects(readBranchPullRequest(git, undefined, async () => result));
	for (const currentBranch of [[], "bad", { ...rawPr, number: 0 }, { ...rawPr, state: "UNKNOWN" }, { ...rawPr, title: null },
		...[
			"javascript:alert(1)", "file:///tmp/pull/7", "https://user:secret@github.com/example/repo/pull/7", "https://github.com/example/repo/pull/8",
			"https://github.com/example/repo/pull/7\x1b]52;c;bad\x07", "https://github.com/example/repo/pull/7\n",
		].map((url) => ({ ...rawPr, url }))]) {
		await assert.rejects(readBranchPullRequest(git, undefined, async () => ({ code: 0, stdout: JSON.stringify({ currentBranch }) })));
	}
});

test("workspace_footer acerca el botón a la rama y excluye el espacio libre de los destinos de clic", () => {
	const theme = getThemeByName("dark")!; const left = " ● Listo · feature";
	for (const width of [80, 132, 240]) {
		const footer = footerStatus(theme, left, "Ctrl 1–5 vistas · /omi", width, pr);
		assert.equal(footer.workspaceEnd, visibleWidth(left)); assert.equal(footer.prStart, visibleWidth(left) + 3);
		assert.match(stripTerminalSequences(footer.line), /feature · \[ PR #7 ↗ \] +Ctrl/);
		assert.ok(footer.prEnd! < footer.hintStart - 1, "el espacio libre queda después del botón, no antes");
	}
});

test("workspace_footer reserva el PR aunque trunque la rama y cierra el enlace antes del contexto", () => {
	for (const name of ["dark", "light"]) {
		const theme = getThemeByName(name)!;
		for (const width of [0, 1, 8, 16, 28, 40, 80, 110, 132]) for (const stale of [false, true]) {
			const footer = footerStatus(theme, " ● Listo · 漢字🙂 · " + "feature/very-long-branch".repeat(20), "Contexto 56k / 200k · 28%", width, pr, stale);
			assert.equal(visibleWidth(footer.line), width);
			const row = surface(theme, footer.line, width, true);
			assert.equal(visibleWidth(row), width);
			if (width >= 28) {
				assert.match(stripTerminalSequences(row), stale ? /PR #7\* ↗/ : /PR #7 ↗/);
				assert.ok(footer.prStart !== undefined && footer.prEnd !== undefined);
				for (let column = 0; column < width; column++) assert.equal(getOsc8LinkAtColumn(row, column), column >= footer.prStart && column < footer.prEnd ? pr.url : undefined, `columna ${column}/${width}`);
				assert.match(stripTerminalSequences(row), /Contexto/);
			}
			const noPr = footerStatus(theme, " Listo", "Contexto 56k / 200k", width);
			assert.equal(visibleWidth(noPr.line), width); assert.equal(noPr.prStart, undefined);
			assert.doesNotMatch(stripTerminalSequences(noPr.line), /PR #/); assert.ok(!noPr.line.includes("\x1b]8;;"));
		}
	}
});
