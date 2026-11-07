import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { handlerTemplate } from "../src/jobs/handler.ts";
import { tempDir } from "./helpers/io.ts";

test("la plantilla Python verifica firma y frescura en el runtime real", async (t) => {
	const dir = await tempDir(t);
	await writeFile(join(dir, "handler.py"), handlerTemplate("python", "/jobs/x"));
	const result = execFileSync("python3", ["-c", `
import handler, hashlib, hmac, json
handler.time.time = lambda: 1793858403
answers = []
for ts in ["1793858403", "1793858102", "1793858704", "invalid", "", "9" * 5000]:
    signature = "sha256=" + hmac.new(b"clave", (ts + ".hola").encode(), hashlib.sha256).hexdigest()
    answers.append(handler.verify_omi_job({"X-Omi-Timestamp": ts, "X-Omi-Signature": signature}, b"hola"))
print(json.dumps(answers))
`], { cwd: dir, env: { ...process.env, OMI_TRIGGER_SECRET: "clave" }, encoding: "utf8" });
	assert.deepEqual(JSON.parse(result), [true, false, false, false, false, false]);
});
