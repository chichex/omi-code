import assert from "node:assert/strict";
import { test } from "node:test";
import { processRunner } from "../src/core/exec.ts";

// El hijo parte cada carácter entre dos escrituras separadas por una pausa: la pipe los entrega en chunks distintos.
const splitWriter = `
const { writeSync } = require("node:fs");
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
const split = (fd, text, at) => { for (let i = 0; i < 4; i++) { const bytes = Buffer.from(text); writeSync(fd, bytes.subarray(0, at)); pause(); writeSync(fd, bytes.subarray(at)); pause(); } };
split(1, "í", 1); split(2, "😀", 3);
`;

test("processRunner decodifica stdout y stderr una sola vez: un carácter multibyte partido entre chunks llega entero", async () => {
	const result = await processRunner.run(process.execPath, ["-e", splitWriter]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "í".repeat(4));
	assert.equal(result.stderr, "😀".repeat(4));
});
