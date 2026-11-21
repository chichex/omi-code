import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FoundationsGate } from "../src/tui/development-foundations.ts";
import { memoryKb } from "./helpers/mock-kb.ts";
import { tempDir } from "./helpers/io.ts";

const policy = { enabled: true, maxScope: "localized", allowedImpacts: ["cosmetic", "documentation", "local-behavior"] };
const block = (chat: unknown = policy, repo = "test/repo") => "```omi-development-triage\n" + JSON.stringify({ version: 1, repo, chat }) + "\n```";
interface Pin { origin: string; policy: typeof policy; hash: string | null; notice: string }
function reader(gate: FoundationsGate) {
	assert.ok("triage" in gate && typeof gate.triage === "function", "falta leer criterios de triage desde las perillas sin aceptar permisos");
	return (ctx: ExtensionContext) => Reflect.apply(gate.triage, gate, [ctx]) as Promise<Pin>;
}
async function fixture(t: import("node:test").TestContext, text?: string) {
	const home = await tempDir(t); const kb = memoryKb({ products: ["repo"] }); if (text !== undefined) kb.perillas("repo", text);
	let prompts = 0; const identity = { origin: "https://github.com/test/repo.git\n" };
	const gate = new FoundationsGate({ kb, trustDir: home, now: () => "now", confirm: async () => { prompts++; return true; }, runner: { run: async () => ({ code: 0, stdout: identity.origin, stderr: "" }) } });
	const ctx = { hasUI: true, cwd: home, sessionManager: { getSessionFile: () => `${home}/session.jsonl` } } as unknown as ExtensionContext;
	return { gate, ctx, kb, identity, prompts: () => prompts };
}

test("triage_policy: lee el bloque de perillas por repo una vez, sin guardar ni aceptar Foundations", async (t) => {
	const f = await fixture(t, "# Otras perillas\n\n" + block()); const read = reader(f.gate);
	const first = await read(f.ctx); assert.equal(first.origin, "kb"); assert.deepEqual(first.policy, policy); assert.match(first.hash!, /^[a-f0-9]{64}$/);
	f.kb.perillas("repo", block({ ...policy, enabled: false }));
	assert.deepEqual(await read(f.ctx), first, "la política queda fija toda la sesión");
	assert.equal(f.prompts(), 0); assert.equal(f.gate.current(f.ctx), undefined, "leer triage no fija/acepta permisos Foundations");
	assert.ok(!f.kb.calls.some((call) => call.tool === "guardar")); assert.equal(f.kb.calls.filter((call) => call.tool === "mis_productos").length, 1);
});

test("triage_policy: ausente, ajeno y KB caída tienen default explícito conservador", async (t) => {
	for (const text of [undefined, "Sin bloque", block({ ...policy, enabled: false }, "other/repo")]) {
		const f = await fixture(t, text); const pin = await reader(f.gate)(f.ctx);
		assert.equal(pin.origin, "default"); assert.deepEqual(pin.policy, policy); assert.ok(pin.notice); assert.equal(f.prompts(), 0);
	}
	const f = await fixture(t, block()); f.kb.available = "sin login";
	const pin = await reader(f.gate)(f.ctx); assert.equal(pin.origin, "default"); assert.deepEqual(pin.policy, policy); assert.match(pin.notice, /KB|login/);
});

test("triage_policy: formato inválido, duplicado, repo ambiguo o cerca abierta detiene en vez de asumir simpleza", async (t) => {
	for (const text of ["```omi-development-triage\n{ roto\n```", block() + "\n" + block(), "```omi-development-triage\n{}\n```", block().replace(/\n```$/, ""), block({ ...policy, extra: true }), block({ ...policy, maxScope: "anything" }), block({ ...policy, allowedImpacts: ["public-contract"] }), block({ ...policy, allowedImpacts: ["cosmetic", "cosmetic"] }), ...["", "sin-owner", "test/repo ", "test//repo", "test/repo/extra"].map((repo) => block(policy, repo))]) {
		const f = await fixture(t, text); await assert.rejects(reader(f.gate)(f.ctx), /triage|clasific|política/i); assert.equal(f.prompts(), 0);
		assert.ok(!f.kb.calls.some((call) => call.tool === "guardar"));
	}
});

test("triage_policy: el pin no se comparte con otras sesiones ni repositorios", async (t) => {
	const f = await fixture(t, block()); const read = reader(f.gate); const first = await read(f.ctx);
	f.kb.perillas("repo", block({ ...policy, enabled: false }));
	const other = { ...f.ctx, sessionManager: { getSessionFile: () => `${f.ctx.cwd}/other.jsonl` } } as unknown as ExtensionContext;
	assert.equal((await read(other)).policy.enabled, false);
	f.identity.origin = "https://github.com/other/repo.git\n"; f.kb.perillas("repo", block({ ...policy, maxScope: "module" }, "other/repo"));
	const foreign = { ...f.ctx, sessionManager: { getSessionFile: () => `${f.ctx.cwd}/foreign.jsonl` } } as unknown as ExtensionContext;
	assert.equal((await read(foreign)).policy.maxScope, "module");
	assert.deepEqual(await read(f.ctx), first, "la sesión original conserva su propia revisión");
	assert.equal((await read(other)).policy.enabled, false);
});

test("triage_policy: cambiar criterio no altera las cuatro políticas de autorización", async (t) => {
	const f = await fixture(t, block({ ...policy, enabled: false, maxScope: "module" }));
	const pin = await reader(f.gate)(f.ctx); assert.equal(pin.policy.enabled, false); assert.equal(pin.policy.maxScope, "module");
	const permissions = await f.gate.policy(f.ctx); assert.deepEqual(permissions.politica, { arranque: "ask", receta: "ask", push_pr: "ask" });
	assert.equal(f.prompts(), 0);
});
