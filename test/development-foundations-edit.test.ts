import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeProjectCommand } from "../src/tui/development-command-authorization.ts";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { foundationsHash, STRICT_POLICY, type FoundationsBlock } from "../src/harness/foundations.ts";
import { sourceHash } from "../src/harness/model.ts";

const block: FoundationsBlock = { version: 2, repo: "test/repo", confirmar: ["git push *"], politica: { ...STRICT_POLICY } };
function fixture(choice: string | undefined) {
	const source = { title: "Test", body: "Pedido", number: 68, url: "https://github.com/test/repo/issues/68", hash: sourceHash("Test", "Pedido") };
	const state = createWorkflow(source, { root: "/tmp/work", commonDir: "/tmp/.git", branch: "feat/test", baseCommit: "a".repeat(40) }, "work", "now");
	const key = { kbUrl: "https://kb.test/mcp", product: "repo", repo: "test/repo" };
	const pin = { version: 2, origin: "kb", block, hash: foundationsHash(block), docId: "doc", author: "", date: "", notice: "", reading: { kind: "valid", key, block, hash: foundationsHash(block), perillas: {} } };
	let pinDecisions = 0; const mutations: unknown[] = []; let assertions = 0;
	const session = { foundations: { current: () => pin, pin: async () => { pinDecisions++; return pin; } },
		select: async (_ctx: unknown, detail: string, choices: string[]) => {
			// Cambio de contrato del dueño (2026-11-24): un comando simple suma «no volver a preguntar» por su prefijo, en este repo.
			assert.deepEqual(choices, ["Sí", "Sí, y no volver a preguntar por «git push *» en este repo", "No", "Editar reglas"]);
			assert.match(detail, /comando exacto|EXACTO/); assert.match(detail, /reintent|volver a intentar/);
			assert.doesNotMatch(detail, /Permitir siempre/); return choice;
		}, assertUnchanged: async () => { assertions++; },
		apply: async (event: Parameters<typeof transition>[1]) => { mutations.push(event); return transition(state, event, "now"); },
	};
	const context = { ui: { notify() {} } };
	const run = () => Reflect.apply(authorizeProjectCommand, undefined, [session, context, { state, command: "git push origin main", kind: "setup", signal: new AbortController().signal }]);
	return { run, mutations, pinDecisions: () => pinDecisions, assertions: () => assertions };
}
test("foundations_edit: permiso ofrece Editar reglas, no concede ni escribe al cancelar y no abre aceptación implícita", async () => {
	const f = fixture("No"); await assert.rejects(f.run(), /no autorizado|no se ejecut/i);
	assert.deepEqual(f.mutations, []); assert.equal(f.pinDecisions(), 0);
});
test("foundations_edit: Sí sigue concediendo sólo grant exacto tras revalidar, no permiso permanente", async () => {
	const f = fixture("Sí"); const state = await f.run();
	assert.equal(f.assertions(), 1); assert.equal(f.pinDecisions(), 0);
	assert.deepEqual(state.grants?.map((grant: { command: string }) => grant.command), ["git push origin main"]);
});
