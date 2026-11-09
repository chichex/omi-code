import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { askOrCancel, processIo, type QuestionReader } from "../src/cli/io.ts";

for (const home of ["", ".", "relative/home"]) {
	test(`processIo rechaza HOME no absoluto: ${JSON.stringify(home)}`, (t) => {
		const previous = process.env.HOME;
		t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
		process.env.HOME = home;
		assert.throws(() => processIo(), /HOME.*absoluta/);
	});
}

class FakeReader extends EventEmitter implements QuestionReader {
	closed = 0;
	readonly pending: Promise<string>;
	constructor(pending: Promise<string>) {
		super();
		this.pending = pending;
	}
	question(): Promise<string> {
		return this.pending;
	}
	close(): void {
		this.closed += 1;
		this.emit("close");
	}
}

test("askOrCancel devuelve la respuesta y cierra el readline", async () => {
	const reader = new FakeReader(Promise.resolve("s"));
	assert.equal(await askOrCancel(reader, "¿?"), "s");
	assert.ok(reader.closed > 0);
});

test("askOrCancel cancela si el readline se cierra y la pregunta queda pendiente, como en Bun", async () => {
	const reader = new FakeReader(new Promise<string>(() => {}));
	const answer = askOrCancel(reader, "¿?");
	reader.emit("close");
	await assert.rejects(answer, /entrada cancelada/);
});

test("askOrCancel unifica el rechazo de Node en el mismo error", async () => {
	const reader = new FakeReader(Promise.reject(new Error("Aborted with Ctrl+D")));
	await assert.rejects(askOrCancel(reader, "¿?"), /entrada cancelada/);
});
