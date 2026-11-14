import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { OmiClient } from "../src/client/http.ts";
import type { OmiError } from "../src/core/errors.ts";

/** Un servidor que nunca responde: sólo termina cuando el cliente corta. */
const hanging: typeof fetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});

test("cliente_un pedido puede fijar su propio plazo en vez del general de 30 s", async () => {
	const client = new OmiClient({ apiUrl: "http://omi.test", fetch: hanging });
	const outcome = await Promise.race([
		client.request("POST", "/lento", Type.Object({}), { body: {}, timeoutMs: 20 }).then(
			() => "respondió",
			(error: OmiError) => error.code,
		),
		sleep(2_000).then(() => "sigue esperando"),
	]);
	assert.equal(outcome, "api_unreachable");
});
