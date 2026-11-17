import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GithubInspector } from "../src/tui/workspace/github-inspector.ts";
import type { GithubItem, GitSnapshot } from "../src/tui/workspace/data.ts";
import type { IssuePreparationEntry } from "../src/tui/workspace/issue-registry.ts";
import { tempDir } from "./helpers/io.ts";

test("workspace_detalle de issue escribe en las preparaciones vigentes, no en las que capturó al abrir", async (t) => {
	const root = await tempDir(t);
	const git: GitSnapshot = { root, gitDir: `${root}/.git`, commonDir: `${root}/.git`, mainRoot: root, linked: false, branch: "main", detached: false, changes: [], changeCount: 0, tracking: false, ahead: undefined, behind: undefined };
	const item: GithubItem = { number: 7, title: "Issue", author: "test", labels: [], url: "https://github.com/test/repo/issues/7", updatedAt: "", draft: false, head: "", base: "", review: "" };
	const ctx = { isProjectTrusted: () => true } as unknown as ExtensionContext;
	const opened = new Map<number, IssuePreparationEntry>(); const reloaded = new Map<number, IssuePreparationEntry>();
	let calls = 0;
	// Un refresco local reemplaza el Map y el error mientras el detalle espera disco/GitHub.
	const state = () => ({ ctx, git, github: { issues: { items: [item], selected: 0 }, prs: { items: [], selected: 0 } }, view: "issues" as const, ...(calls++ === 0 ? { preparations: opened, preparationsError: undefined } : { preparations: reloaded, preparationsError: "Registro recargado" }) });
	const inspector = new GithubInspector({ state, active: () => true, gitIdentity: () => "same", changed: () => {}, modalBusy: () => false, signal: new AbortController().signal, offline: true, pi: {} as ExtensionAPI, info: async () => false, onBegin: () => { throw new Error("Cerrar el detalle sin Enter no pide empezar"); }, canBegin: true });
	await inspector.show("issues");
	assert.equal(opened.size, 0, "el Map reemplazado no recibe la preparación");
	assert.deepEqual(reloaded.get(7), { error: "Registro recargado" });
});
