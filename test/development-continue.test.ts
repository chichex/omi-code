import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { ASK_ALL } from "./helpers/foundations.ts";

// Como Pi arma agent_before_settle: sin entradas ni continuación de otros handlers.
const settle = (outcome: "completed" | "aborted" | "error" = "completed", extra: Record<string, unknown> = {}) => ({ type: "agent_before_settle", entries: [], continue: false, outcome, context: { pendingMessages: [] }, ...extra });
type Boundary = { entries?: { type: string; customType?: string; content?: string }[]; continue?: boolean } | undefined;
const continuation = (result: unknown) => (result as Boundary)?.entries?.find((entry) => entry.type === "custom_message" && entry.customType === "omi-development-continue");
const continued = (result: unknown): boolean => (result as Boundary)?.continue === true && continuation(result) !== undefined;

test("development_continue: si el modelo corta en una etapa suya, el harness retoma el turno", async (t) => {
	const f = await developmentFixture(t); await f.start();
	assert.equal((await f.state()).phase, "explore");
	const result = await f.emit("agent_before_settle", settle());
	assert.ok(continued(result));
	assert.match(continuation(result)!.content!, /#42/);
	assert.match(continuation(result)!.content!, /Explorar/);
});

test("development_continue: dos vueltas sin avanzar y frena con un aviso; avanzar renueva el tope", async (t) => {
	const f = await developmentFixture(t); await f.start();
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
	assert.equal(continued(await f.emit("agent_before_settle", settle())), false);
	assert.ok(f.messages.some((message) => /cortó dos veces sin avanzar/.test(message)));
	await f.explore();
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
});

test("development_continue: un mensaje de la persona renueva el tope; uno de una extensión no", async (t) => {
	const f = await developmentFixture(t); await f.start();
	await f.emit("agent_before_settle", settle()); await f.emit("agent_before_settle", settle());
	await f.emit("input", { type: "input", text: "dale", source: "extension" });
	assert.equal(continued(await f.emit("agent_before_settle", settle())), false);
	await f.emit("input", { type: "input", text: "seguí con el C2", source: "interactive" });
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
});

test("development_continue: no retoma con Esc, con error ni si Pi ya sigue por otro motivo", async (t) => {
	const f = await developmentFixture(t); await f.start();
	assert.equal(continued(await f.emit("agent_before_settle", settle("aborted"))), false);
	assert.equal(continued(await f.emit("agent_before_settle", settle("error"))), false);
	assert.equal(continuation(await f.emit("agent_before_settle", settle("completed", { continue: true }))), undefined);
	assert.equal(continued(await f.emit("agent_before_settle", settle("completed", { context: { pendingMessages: [{ role: "user" }] } }))), false);
	// Ninguno de esos gastó vueltas del tope.
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
});

test("development_continue: conserva las entradas de otros handlers", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const other = { type: "custom_message", customType: "otro", content: "x", display: false };
	const result = await f.emit("agent_before_settle", settle("completed", { entries: [other] })) as Boundary;
	assert.deepEqual(result?.entries?.[0], other);
	assert.ok(continued(result));
});

test("development_continue: no retoma si la etapa espera a la persona o el trabajo está pausado", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await f.start();
	await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	assert.equal((await f.state()).phase, "approve");
	assert.equal(continued(await f.emit("agent_before_settle", settle())), false);
	const g = await developmentFixture(t); await g.start();
	await g.command("pause");
	assert.equal((await g.state()).status, "paused");
	assert.equal(continued(await g.emit("agent_before_settle", settle())), false);
});

test("development_continue: si una tool del harness cerró el turno a propósito, espera al próximo", async (t) => {
	const f = await developmentFixture(t, { foundations: ASK_ALL }); await f.start(); await f.explore();
	f.remote.confirmations = false;
	await f.emit("agent_start", { type: "agent_start" });
	const output = await f.action({ action: "refresh" }) as { terminate?: boolean };
	assert.equal(output.terminate, true);
	assert.equal(continued(await f.emit("agent_before_settle", settle())), false);
	await f.emit("agent_start", { type: "agent_start" });
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
});

test("development_continue: con subagentes en background espera su aviso en vez de retomar", async (t) => {
	const f = await developmentFixture(t); await f.start();
	await f.emitBus("omi:subagents", { phase: "start", id: "bg-1", details: { mode: "single", results: [] } });
	assert.equal(continued(await f.emit("agent_before_settle", settle())), false);
	await f.emitBus("omi:subagents", { phase: "end", id: "bg-1", details: { mode: "single", results: [] } });
	assert.ok(continued(await f.emit("agent_before_settle", settle())));
});
