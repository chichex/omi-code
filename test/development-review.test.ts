import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLensResult } from "../src/tui/development-review.ts";

test("development_lenses un resultado inválido o con hallazgos no puede declararse aprobado", () => {
	assert.deepEqual(parseLensResult('{"verdict":"pass","findings":[]}'), { verdict: "pass", findings: [] });
	assert.deepEqual(parseLensResult('{"verdict":"pass","findings":["src/a.ts:4: permiso ausente"]}'), { verdict: "fail", findings: ["src/a.ts:4: permiso ausente"] });
	for (const raw of ["no JSON", "{}", '{"verdict":"approved","findings":[]}', '{"verdict":"pass","findings":[],"execute":"rm -rf"}']) assert.throws(() => parseLensResult(raw), /lente|formato/i);
});
