import assert from "node:assert/strict";
import { test } from "node:test";
import { processIo } from "../src/cli/io.ts";

for (const home of ["", ".", "relative/home"]) {
	test(`processIo rechaza HOME no absoluto: ${JSON.stringify(home)}`, (t) => {
		const previous = process.env.HOME;
		t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
		process.env.HOME = home;
		assert.throws(() => processIo(), /HOME.*absoluta/);
	});
}
