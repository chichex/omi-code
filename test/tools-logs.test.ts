import assert from "node:assert/strict";
import { test } from "node:test";
import { readSse } from "../src/client/sse.ts";
import type { OmiError } from "../src/core/errors.ts";
import { linkedProject } from "./helpers/project.ts";

const logs = { service: "api", environment: "stage" };

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ event: string | undefined; data: string }[]> {
	const frames: { event: string | undefined; data: string }[] = [];
	for await (const frame of readSse(stream)) frames.push(frame);
	return frames;
}

test("readSse_arma marcos aunque lleguen cortados en cualquier byte", async () => {
	const text = "retry: 3000\n\nevent: attached\ndata: 1\n\n: ping\n\ndata: hola mundo\n\nevent: stream-error\ndata: se cortó\n\n";
	const expected = [
		{ event: "attached", data: "1" },
		{ event: undefined, data: "hola mundo" },
		{ event: "stream-error", data: "se cortó" },
	];
	assert.deepEqual(await collect(streamOf(text)), expected);
	assert.deepEqual(await collect(streamOf(...text.match(/[\s\S]{1,3}/g)!)), expected);
});

test("readSse_no parte un carácter multibyte cortado entre chunks", async () => {
	const bytes = new TextEncoder().encode("data: ñandú\n\n");
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
			controller.close();
		},
	});
	assert.deepEqual(await collect(stream), [{ event: undefined, data: "ñandú" }]);
});

test("omi_logs_tail_devuelve líneas hasta que se cierra el stream", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logFrames.push("data: uno\n\n", ": ping\n\n", "data: dos\n\n");
	const result = await linked.call("omi_logs_tail", logs);
	assert.deepEqual(result.data, { lines: ["uno", "dos"], stopped: "closed", agent: "attached" });
});

test("omi_logs_tail_corta por cantidad de líneas", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logStaysOpen = true;
	linked.workloads.logFrames.push("data: uno\n\n", "data: dos\n\n", "data: tres\n\n");
	const result = await linked.call("omi_logs_tail", { ...logs, lines: 2 });
	assert.deepEqual((result.data as { lines: string[]; stopped: string }), { lines: ["uno", "dos"], stopped: "lines", agent: "attached" });
});

test("omi_logs_tail_corta por duración con el stream abierto", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logStaysOpen = true;
	linked.workloads.logFrames.push("data: uno\n\n");
	const started = Date.now();
	const result = await linked.call("omi_logs_tail", { ...logs, durationSeconds: 0.05 });
	assert.ok(Date.now() - started < 2_000);
	assert.deepEqual((result.data as { stopped: string; lines: string[] }).lines, ["uno"]);
	assert.equal((result.data as { stopped: string }).stopped, "duration");
});

test("omi_logs_tail_informa un stream-error sin perder lo leído", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logFrames.push("data: uno\n\n", "event: stream-error\ndata: kubectl logs: se cortó\n\n");
	const result = await linked.call("omi_logs_tail", logs);
	assert.equal(result.failed, true);
	assert.deepEqual(result.data, { lines: ["uno"], stopped: "error", agent: "attached", error: "kubectl logs: se cortó" });
});

test("omi_logs_tail_emite cada línea como progreso", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.logFrames.push("data: uno\n\n");
	const progress: string[] = [];
	await linked.call("omi_logs_tail", logs, { progress: (text) => progress.push(text) });
	assert.deepEqual(progress, ["uno"]);
});

test("omi_logs_tail_un error previo al stream sale como error de la API", async (t) => {
	const linked = await linkedProject(t);
	linked.project.services.get("api")?.view.environments.pop();
	await assert.rejects(
		linked.call("omi_logs_tail", { service: "api", environment: "prod" }),
		(error: OmiError) => error.code === "environment_not_found",
	);
});

test("omi_crash_logs_trae el detalle de una captura por id", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.instanceLogs.push({ id: "ilog_1", deployment_id: "dep_1", lines: ["panic: boom"] });
	const result = await linked.call("omi_crash_logs", { ...logs, instanceLogId: "ilog_1" });
	const data = result.data as { logs: { id: string; lines: string[] }[] };
	assert.deepEqual(data.logs[0]?.lines, ["panic: boom"]);
	assert.match(result.text, /panic: boom/);
});

test("omi_crash_logs_sin id trae la captura más reciente", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.instanceLogs.push({ id: "ilog_2", lines: ["nuevo"] }, { id: "ilog_1", lines: ["viejo"] });
	const result = await linked.call("omi_crash_logs", logs);
	const data = result.data as { logs: { id: string }[]; captures: { id: string }[] };
	assert.deepEqual(data.logs.map((log) => log.id), ["ilog_2"]);
	assert.deepEqual(data.captures.map((capture) => capture.id), ["ilog_2", "ilog_1"]);
});

test("omi_crash_logs_filtra por deployment", async (t) => {
	const linked = await linkedProject(t);
	linked.workloads.instanceLogs.push({ id: "ilog_2", deployment_id: "dep_2", lines: ["otro"] }, { id: "ilog_1", deployment_id: "dep_1", lines: ["este"] });
	const result = await linked.call("omi_crash_logs", { ...logs, deploymentId: "dep_1" });
	assert.deepEqual((result.data as { logs: { lines: string[] }[] }).logs[0]?.lines, ["este"]);
});

test("omi_crash_logs_sin capturas lo dice", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_crash_logs", logs);
	assert.match(result.text, /[Ss]in capturas/);
});
