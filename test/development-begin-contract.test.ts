import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { beginFixture } from "./helpers/development-begin.ts";

test("begin_contract: tool explica clasificación previa, salida chat y ausencia de permisos implícitos", async (t) => {
	const f = await beginFixture(t); const tool = f.current().tools.get("omi_work_begin")!;
	assert.match(tool.description, /antes de crear/i); assert.match(tool.description, /chat/i);
	assert.match(tool.promptGuidelines!.join("\n"), /clasific/i);
	assert.match(tool.description, /no autoriza|no concede/i);
	await f.invoke("omi_work_begin", { title: "Pedido", body: "Pedido completo", reason: "Evaluar" });
	await f.emit("agent_settled", { aborted: true });
});

test("begin_contract: README y contrato describen orden, parámetros KB y límites de la estimación", async () => {
	for (const path of ["README.md", "docs/development-harness.md"]) {
		const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
		assert.match(text, /antes de crear/i, path); assert.match(text, /omi-development-triage/, path);
		assert.match(text, /reglas y permisos/, path);
		assert.doesNotMatch(text, /Con el sí crea el issue, lo clasifica|el sí antes de crear el issue y de clasificar/, path);
	}
	const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
	assert.match(agents, /clasifica.*antes de crear/i);
});
