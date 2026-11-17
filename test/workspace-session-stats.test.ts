import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionStats } from "../src/tui/workspace/session-stats.ts";

const meta = { id: "entry", parentId: null, timestamp: new Date(0).toISOString() };
const usage = (input = 100, output = 10, cacheRead = 300, cost = .2): Usage => ({ input, output, cacheRead, cacheWrite: 20, totalTokens: input + output + cacheRead + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const assistant = (value: Usage): SessionEntry => ({ ...meta, type: "message", message: { role: "assistant", content: [], api: "anthropic-messages", provider: "test", model: "test", stopReason: "stop", timestamp: 0, usage: value } });

test("sesión: totales de la rama activa, último costo y usos auxiliares sin duplicar nested calls", () => {
	const entries: SessionEntry[] = [
		{ ...meta, type: "message", message: { role: "user", content: "Hola", timestamp: 0 } },
		assistant(usage()), assistant(usage(200, 30, 500, .4)),
		{ ...meta, type: "message", message: { role: "toolResult", toolCallId: "tool", toolName: "subagent", content: [], isError: false, timestamp: 0, usage: usage(30, 5, 0, .1) } },
		{ ...meta, type: "usage", kind: "cache_warm", model: "test", provider: "test", usage: usage(0, 0, 40, .05) },
		{ ...meta, type: "compaction", summary: "Compactado", firstKeptEntryId: "entry", tokensBefore: 1000, usage: usage(10, 5, 0, .15) },
	];
	const stats = sessionStats(entries);
	assert.equal(stats.input, 340); assert.equal(stats.output, 50); assert.equal(stats.cacheRead, 840); assert.equal(stats.cacheWrite, 100);
	assert.ok(Math.abs(stats.cost - .9) < 1e-10); assert.equal(stats.lastCost, .4); assert.equal(stats.responses, 2);
	assert.equal(sessionStats(entries.slice(0, 2)).cost, .2, "no suma entradas de otras ramas que no recibe");
	assert.equal(sessionStats(entries.slice(2, 3)).lastCost, .4, "cambiar modelo no reinicia el costo de sesión");
});

test("sesión vacía y metadatos no inventan consumo ni costos", () => {
	assert.deepEqual(sessionStats([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastCost: 0, responses: 0 });
	assert.equal(sessionStats([{ ...meta, type: "custom", customType: "private", data: { usage: usage(999) } }]).input, 0);
	const stats = sessionStats([assistant(usage(NaN, -10, Infinity, NaN))]);
	assert.equal(stats.input, 0); assert.equal(stats.output, 0); assert.equal(stats.cacheRead, 0); assert.equal(stats.cost, 0);
});
