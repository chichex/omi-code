// omi_pr_merge: la persona pide el merge en el chat y lo autoriza con su sí en la pantalla de OMI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CommandOptions, CommandResult } from "../src/core/exec.ts";
import { workflowToolAllowed } from "../src/harness/permissions.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { PR_MERGE_TOOL, prMergeExtension } from "../src/tui/pr-merge.ts";

const HEAD = "fdd118c0ffee1234567890abcdef1234567890ab";
const pull = (over: Record<string, unknown> = {}) => ({
	number: 79, title: "feat(tui): mostrar la versión de OMI en la cabecera", url: "https://github.com/chichex/omi-code/pull/79", state: "OPEN", isDraft: false,
	headRefName: "feat/tui-omi-version", headRefOid: HEAD, baseRefName: "main", mergeStateStatus: "CLEAN",
	statusCheckRollup: [{ __typename: "CheckRun", name: "cierre", status: "COMPLETED", conclusion: "SUCCESS" }], ...over,
});
const ok = (value: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

/** GitHub falso: lee el PR, la configuración del repo y registra el PUT del merge. */
function github(options: { before?: Record<string, unknown>; after?: Record<string, unknown>; repo?: Record<string, unknown>; put?: CommandResult } = {}) {
	const log: string[] = []; const calls: { args: string[]; options: CommandOptions | undefined }[] = []; let merged = false;
	const runner = { async run(command: string, args: string[], opts?: CommandOptions): Promise<CommandResult> {
		assert.equal(command, "gh"); calls.push({ args, options: opts });
		if (args[0] === "api") { log.push("PUT"); const put = options.put ?? ok({ merged: true }); merged = put.code === 0; return put; }
		if (args[0] === "repo") return ok({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, ...options.repo });
		if (args[0] === "pr" && args[1] === "view") return ok(merged ? { ...pull(), state: "MERGED", mergeCommit: { oid: "e".repeat(40) }, ...options.after } : { ...pull(options.before), ...(options.after && !merged ? options.after : {}) });
		throw new Error(`gh inesperado: ${args.join(" ")}`);
	} };
	return { runner, log, calls, puts: () => calls.filter((call) => call.args[0] === "api") };
}

async function load(runner: ReturnType<typeof github>["runner"]) {
	const tools: ToolDefinition[] = []; const starts: ((event: unknown, ctx: unknown) => unknown)[] = []; let active = ["read", "bash"];
	const extension = prMergeExtension(runner);
	await extension.factory({ registerTool: (tool: ToolDefinition) => { tools.push(tool); active.push(tool.name); }, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (name === "session_start") starts.push(handler); },
		getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; } } as unknown as ExtensionAPI);
	const tool = tools.find((t) => t.name === PR_MERGE_TOOL); assert.ok(tool);
	return { tool, active: () => active, start: async (ctx: { mode: string; hasUI: boolean }) => { for (const handler of starts) await handler({ type: "session_start" }, ctx); } };
}

function person(answer: boolean, log: string[] = [], options: { hasUI?: boolean } = {}) {
	const dialogs: { title: string; message: string }[] = [];
	const ctx = { cwd: "/repo", mode: "tui", hasUI: options.hasUI ?? true, ui: { confirm: async (title: string, message: string) => { log.push("confirm"); dialogs.push({ title, message }); return answer; } } } as unknown as ExtensionToolContext;
	return { ctx, dialogs };
}
const run = (tool: ToolDefinition, params: unknown, ctx: ExtensionToolContext) => tool.execute("call", params, new AbortController().signal, undefined, ctx);
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("\n");

test("omi_pr_merge mergea el SHA que vio la persona, después de su sí", async () => {
	const gh = github(); const { tool } = await load(gh.runner); const { ctx, dialogs } = person(true, gh.log);
	const result = await run(tool, { pr: 79 }, ctx);
	assert.deepEqual(gh.log, ["confirm", "PUT"], "primero el sí, después el merge");
	assert.equal(dialogs[0]!.title, "Mergear el PR #79");
	for (const shown of ["chichex/omi-code", "feat(tui): mostrar la versión de OMI en la cabecera", "feat/tui-omi-version → main", "squash", HEAD.slice(0, 12), "cierre ok"]) assert.ok(dialogs[0]!.message.includes(shown), `el diálogo muestra ${shown}:\n${dialogs[0]!.message}`);
	const [put] = gh.puts(); assert.ok(put);
	assert.deepEqual(put.args, ["api", "--hostname", "github.com", "--method", "PUT", "repos/chichex/omi-code/pulls/79/merge", "-f", `sha=${HEAD}`, "-f", "merge_method=squash"]);
	assert.equal(put.options?.cwd, "/repo");
	assert.match(textOf(result), /PR #79 mergeado en main/);
});

test("omi_pr_merge sin el sí de la persona no mergea ni insiste", async () => {
	const gh = github(); const { tool } = await load(gh.runner); const { ctx } = person(false, gh.log);
	const result = await run(tool, { pr: 79 }, ctx);
	assert.deepEqual(gh.log, ["confirm"]); assert.equal(gh.puts().length, 0);
	assert.match(textOf(result), /no confirmó/); assert.match(textOf(result), /no se mergeó/);
});

test("omi_pr_merge no le pregunta a la persona si GitHub no lo deja mergear", async () => {
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ isDraft: true, mergeStateStatus: "DRAFT" }, /draft/],
		[{ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ __typename: "CheckRun", name: "cierre", status: "COMPLETED", conclusion: "FAILURE" }] }, /bloquea[\s\S]*cierre falló/],
		[{ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ __typename: "CheckRun", name: "cierre", status: "IN_PROGRESS", conclusion: "" }] }, /cierre corriendo/],
		[{ mergeStateStatus: "DIRTY" }, /conflictos con main/],
		[{ mergeStateStatus: "BEHIND" }, /atrás de main/],
		[{ mergeStateStatus: "UNKNOWN" }, /reintentá/],
		[{ state: "MERGED" }, /ya está mergeado/],
		[{ state: "CLOSED" }, /está cerrado/],
	];
	for (const [before, reason] of cases) {
		const gh = github({ before }); const { tool } = await load(gh.runner); const { ctx } = person(true, gh.log);
		await assert.rejects(run(tool, { pr: 79 }, ctx), (error: Error) => { assert.match(error.message, /No mergeé el PR #79/); assert.match(error.message, reason); return true; }, JSON.stringify(before));
		assert.deepEqual(gh.log, [], `sin diálogo ni merge: ${JSON.stringify(before)}`);
	}
});

test("omi_pr_merge usa el método que permite el repo: squash si puede", async () => {
	for (const [repo, method] of [[{}, "squash"], [{ squashMergeAllowed: false }, "merge"], [{ squashMergeAllowed: false, mergeCommitAllowed: false }, "rebase"]] as const) {
		const gh = github({ repo }); const { tool } = await load(gh.runner); const { ctx } = person(true, gh.log);
		await run(tool, { pr: 79 }, ctx);
		assert.ok(gh.puts()[0]!.args.includes(`merge_method=${method}`), JSON.stringify(repo));
	}
});

test("omi_pr_merge si GitHub no confirma el merge lo dice, no lo da por hecho ni lo reintenta", async () => {
	const gh = github({ put: { code: 1, stdout: "", stderr: "gh: Head branch was modified. Review and try the merge again. (HTTP 409)" } });
	const { tool } = await load(gh.runner); const { ctx } = person(true, gh.log);
	await assert.rejects(run(tool, { pr: 79 }, ctx), (error: Error) => { assert.match(error.message, /GitHub no confirmó el merge del PR #79/); assert.match(error.message, /Head branch was modified/); return true; });
	assert.equal(gh.puts().length, 1, "un solo intento");
});

test("omi_pr_merge sin TUI no se ofrece y, si llega igual, falla sin tocar GitHub", async () => {
	const gh = github(); const loaded = await load(gh.runner);
	await loaded.start({ mode: "print", hasUI: false });
	assert.equal(loaded.active().includes(PR_MERGE_TOOL), false);
	const { ctx } = person(true, gh.log, { hasUI: false });
	await assert.rejects(run(loaded.tool, { pr: 79 }, ctx), /TUI/);
	assert.deepEqual(gh.calls, []);
});

test("omi_pr_merge sólo la llama el modelo, de a una, con el número del PR", async () => {
	const { tool } = await load(github().runner);
	assert.equal(tool.exposure, "model-only"); assert.equal(tool.executionMode, "sequential");
	assert.equal(Value.Check(tool.parameters, { pr: 79 }), true);
	for (const bad of [{}, { pr: 0 }, { pr: 1.5 }, { pr: "79" }, { pr: 79, repo: "otro/repo" }]) assert.equal(Value.Check(tool.parameters, bad), false, JSON.stringify(bad));
});

test("omi_pr_merge no corre dentro del harness: ahí el merge es /omi-work land", () => {
	const state = createWorkflow({ number: 42, title: "Arreglar", url: "https://github.com/test/repo/issues/42", body: "Pedido", hash: "source" }, { root: "/tmp/repo", commonDir: "/tmp/repo/.git", branch: "fix/issue-42", baseCommit: "a".repeat(40) }, "work", "2026-11-18T00:00:00Z");
	for (const phase of ["explore", "decide", "recipe", "approve", "implement", "verify", "pr"] as const) assert.equal(workflowToolAllowed({ ...state, phase }, PR_MERGE_TOOL, { pr: 79 }), false, phase);
});
