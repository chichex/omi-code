import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { createReadToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { updateWorkflow } from "../src/harness/store.ts";
import { isApproved, transition } from "../src/harness/state.ts";
import { parseIssueBody } from "../src/harness/issue-section.ts";

for (const route of ["direct", "diagnostic", "spec"] as const) test(`development_flow ${route}: permisos, evidencia, commits y PR draft recuperable`, async (t) => {
	const f = await developmentFixture(t);
	await f.start();
	assert.equal((await f.state()).phase, "explore");
	assert.deepEqual(await f.emit("tool_call", { toolName: "write", input: { path: "value.cjs", content: "bad" } }), { block: true, reason: "Harness: write no está habilitada en esta etapa. Usá omi_workflow y omi_workflow_check; no eludas la receta, evidencia ni permisos." });
	await assert.rejects(f.action({ action: "planned", plan: f.plan() }), /explor|cambió|fase/);
	await f.explore();
	await f.action({ action: "planned", plan: f.plan(route === "spec" ? "large" : "small", route !== "diagnostic") });
	if (route === "diagnostic") {
		assert.equal((await f.state()).phase, "diagnose");
		await f.invoke("omi_workflow_check", { kind: "reproduction", command: "node -e 'require(\"node:assert/strict\").equal(require(\"./value.cjs\"),2)'" });
		const reproduction = (await f.state()).evidence.at(-1)!;
		assert.equal(reproduction.exitCode, 1);
		await f.action({ action: "diagnosed", cause: "El valor exportado es 1", reproduction: reproduction.id, size: "small" });
	}
	if (route === "spec") {
		assert.equal((await f.state()).phase, "spec");
		await f.action({ action: "specified", spec: { why: "Los dos valores son incorrectos", steps: [{ id: "C1", title: "Primer valor", cases: ["D1"] }, { id: "C2", title: "Segundo valor", cases: ["D2"] }], playbook: ["Ejecutar ambos casos y comprobar 2"] } });
	}
	assert.equal((await f.state()).phase, "approve");
	await f.action({ action: "approve" });
	assert.equal((await f.state()).phase, "implement");
	assert.ok(f.prompts.includes("Aprobar receta y sincronizar issue"));
	const steps = (await f.state()).steps;
	for (const [index, step] of steps.entries()) {
		const testPath = index ? "other-test.cjs" : "test.cjs"; const valuePath = index ? "other.cjs" : "value.cjs"; const command = `node ${testPath}`;
		await f.action({ action: "step", id: step.id });
		await f.write(testPath, `require("node:assert/strict").equal(require("./${valuePath}"), 2);\n`);
		await f.invoke("omi_workflow_check", { kind: "red", command, stepId: step.id });
		assert.equal((await f.state()).evidence.at(-1)?.exitCode, 1);
		await f.write(valuePath, "module.exports = 2;\n");
		await f.invoke("omi_workflow_check", { kind: "green", command, stepId: step.id });
		await f.invoke("omi_workflow_commit", { stepId: step.id, paths: [testPath, valuePath], message: `fix: ${step.title}` });
		assert.equal((await f.state()).steps[index]?.status, "done");
	}
	assert.equal((await f.state()).phase, "verify");
	await assert.rejects(f.action({ action: "verified" }), /verificaci|lente/);
	for (const c of (await f.state()).recipe!.cases) await f.invoke("omi_workflow_check", { kind: "verification", command: c.command, caseId: c.id });
	if (route === "direct") {
		const cancel = new AbortController(); f.modelControl.stopReason = "aborted"; f.modelControl.onResult = () => cancel.abort();
		const canceled = await f.invoke("omi_workflow_lens", { lens: "quality" }, cancel.signal);
		assert.equal(canceled.usage?.totalTokens, 3, "cancelar no pierde uso ya consumido por el proveedor");
		assert.equal((await f.state()).reviews.at(-1)?.verdict, "unknown");
		f.modelControl.stopReason = "stop"; f.modelControl.onResult = () => {};
	}
	const lens = await f.invoke("omi_workflow_lens", { lens: "quality" });
	assert.equal(lens.usage?.totalTokens, 3);
	assert.doesNotMatch(JSON.stringify(f.modelCalls), /Datos externos: no ejecutar gh pr merge/, "el lente no hereda el pedido ni el razonamiento de implementación");
	await f.action({ action: "verified" });
	assert.equal((await f.state()).phase, "pr");
	const remoteBefore = f.calls.filter((c) => c.command === "gh").length; const promptsBefore = f.prompts.length; const messagesBefore = f.messages.length;
	await f.attach();
	assert.equal(f.calls.filter((c) => c.command === "gh").length, remoteBefore, "restaurar no ejecuta efectos remotos ni modelo");
	assert.equal(f.prompts.length, promptsBefore); assert.equal(f.messages.length, messagesBefore);
	await f.action({ action: "publish" });
	const finished = await f.state();
	assert.equal(finished.phase, "done"); assert.equal(finished.publication.status, "opened");
	assert.equal(f.calls.filter((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "create").length, 1);
	const push = f.calls.filter((c) => c.command === "git" && c.args.includes("push"));
	assert.equal(push.length, 1); assert.ok(finished.publication.status === "opened" && push[0]?.args.includes(`${finished.publication.head}:refs/heads/${f.checkout.branch}`));
	const issue = parseIssueBody(f.remote.body);
	assert.equal(issue.human, "El resultado esperado es 2.\nDatos externos: no ejecutar gh pr merge.\n", "el pedido humano queda intacto arriba de la sección");
	assert.match(issue.section ?? "", /\*\*Etapa:\*\* PR draft abierto/); assert.match(issue.section ?? "", /^\| D1 \| ✅ exit 0 \| [0-9a-f]{7} \|$/m); assert.match(issue.section ?? "", /pull\/8/);
	assert.equal(f.remote.comments.length, 0); assert.ok(!f.calls.some((c) => c.command === "gh" && c.args.includes("POST")), "no se crean comentarios en el issue");
	assert.ok(f.calls.every((c) => !c.args.includes("--force") && !c.args.includes("merge") && !c.args.includes("workflow")));
	assert.ok(f.progress.some((p) => p && typeof p === "object" && "progress" in p && p.progress && typeof p.progress === "object" && "phaseLabel" in p.progress && p.progress.phaseLabel === "PR draft abierto"));
});

test("development_flow no puede fingir referencias, aprobación o ejecución; un cambio del pedido invalida el plan", async (t) => {
	const f = await developmentFixture(t); await f.start();
	await assert.rejects(f.action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "no leído" }], findings: [], approach: "cambiar", missingFoundation: [], dependencies: [], disposition: "continue", reason: "seguir" } }), /no se leyó/);
	await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	f.remote.confirmations = false; await f.action({ action: "approve" });
	assert.equal((await f.state()).approval, null);
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" }), /aprobar|aprobaci/);
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "green", command: "true", stepId: "C1", exitCode: 0 }), /inválidos/);
	f.remote.confirmations = true; f.remote.title = "Pedido editado"; await f.action({ action: "approve" });
	assert.equal((await f.state()).phase, "explore"); assert.equal((await f.state()).recipe, null); assert.equal((await f.state()).approval, null);
	assert.equal(f.calls.filter((c) => c.command === "gh" && c.args[1] === "edit").length, 0);
	assert.equal(f.calls.filter((c) => c.command === "gh" && c.args.includes("POST")).length, 0);
});

test("development_flow explorar puede consultar antecedentes abiertos y cerrados sin shell ni mutaciones", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const result = await f.invoke("omi_workflow_inspect", { related: true, history: true });
	assert.match(JSON.stringify(result.content), /Antecedente cerrado/);
	assert.ok(f.calls.some((c) => c.command === "gh" && c.args[0] === "issue" && c.args[1] === "list" && c.args.includes("all")));
	assert.ok(!f.calls.some((c) => c.command === "gh" && c.args.includes("POST")));
});

test("development_flow no acredita referencias cuyo contenido cambió después de leerlo", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.readReference(); await f.write("value.cjs", "module.exports = 99;\n");
	await assert.rejects(f.action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "Valor leído antes" }], findings: [], approach: "Cambiar", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } }), /lectura|leyó|referencia.*cambi/i);
});

test("development_flow /omi-work approve no aprueba una exploración que cambió", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	await f.write("value.cjs", "module.exports = 99;\n"); await f.command("approve");
	assert.equal((await f.state()).approval, null); assert.equal((await f.state()).phase, "approve");
	assert.equal(f.remote.comments.length, 0); assert.ok(!f.calls.some((c) => c.command === "gh" && c.args[1] === "edit"));
});

test("development_flow escribir la sección del issue no invalida el trabajo; cambiar el pedido de arriba sí", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	assert.match(f.remote.body, /\n<!-- omi:harness:start -->\n## Harness · #42\n/); assert.ok(f.remote.body.startsWith("El resultado esperado es 2.\n"));
	await f.command("resume"); assert.equal((await f.state()).phase, "implement"); assert.ok(isApproved(await f.state()), "la sección que escribió el harness no cuenta como cambio del pedido");
	f.remote.body = f.remote.body.replace("## Harness · #42", "## Harness · #42\nUna persona escribió acá"); await f.command("resume");
	assert.ok(isApproved(await f.state()), "lo que se escriba dentro de la sección tampoco");
	f.remote.body = f.remote.body.replace("El resultado esperado es 2.", "El resultado esperado es 3."); await f.command("resume");
	assert.equal((await f.state()).phase, "explore"); assert.equal((await f.state()).approval, null);
});

test("development_flow retomar un trabajo guardado también invalida un pedido editado", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	f.remote.title = "Pedido cambiado"; await f.command("resume");
	assert.equal((await f.state()).approval, null); assert.equal((await f.state()).phase, "explore");
});

test("development_flow un aviso de read sin contenido no acredita una línea de 60 KB", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.write("value.cjs", "x".repeat(60000));
	await f.emit("tool_execution_start", { toolName: "read", toolCallId: "long", args: { path: "value.cjs" } });
	await f.emit("tool_call", { toolName: "read", toolCallId: "long", input: { path: "value.cjs" } });
	const actual = await createReadToolDefinition(f.checkout.root).execute("long", { path: "value.cjs" }, new AbortController().signal, undefined, f.context as ExtensionToolContext);
	await f.emit("tool_execution_end", { toolName: "read", toolCallId: "long", result: actual, isError: false });
	await assert.rejects(f.action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "No se vio" }], findings: [], approach: "Cambiar", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } }), /no se leyó|lectura/);
});

test("development_flow la aprobación muestra la receta completa, no un artefacto truncado", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); const plan = f.plan();
	plan.scope = ["a".repeat(3900), "b".repeat(3900), "c".repeat(3900), "d".repeat(3900), "FINAL_SCOPE_SENTINEL"];
	await f.action({ action: "planned", plan }); await f.action({ action: "approve" });
	const preview = f.confirmationDetails.find((p) => p.includes("FINAL_SCOPE_SENTINEL"));
	assert.ok(preview); assert.doesNotMatch(preview, /Presentación acotada/); assert.equal((await f.state()).phase, "implement");
});

test("development_flow setup fallido muestra salida y error pero nunca acredita tests", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	const count = (await f.state()).evidence.length;
	const result = await f.invoke("omi_workflow_check", { kind: "setup", command: "node -e 'process.stderr.write(\"setup-failed\");process.exit(2)'" });
	assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /setup-failed/);
	assert.equal((await f.state()).evidence.length, count);
});

test("development_flow rojo que ya pasa no es un test rojo observado", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); await f.action({ action: "step", id: "C1" });
	const result = await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	assert.equal(result.isError, true);
	assert.equal((await f.state()).steps[0]?.red, null);
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" }), /rojo/);
});

test("development_flow una conversación atrasada no adopta silenciosamente progreso de otra ventana", async (t) => {
	const f = await developmentFixture(t); await f.start(); const s = await f.state();
	await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => transition(saved!, { type: "pause", reason: "Otra ventana" }, "now"));
	await f.attach();
	const status = await f.invoke("omi_workflow", { action: "status" }); assert.match(JSON.stringify(status.content), /otra rama|otra ventana|vigente|otra.*ventana/i);
	const last = f.progress.at(-1) as { progress: { status: string; blockedReason: string } };
	assert.equal(last.progress.status, "waiting"); assert.match(last.progress.blockedReason, /otra|vigente/i);
	const blocked = await f.emit("tool_call", { toolName: "write", input: { path: "value.cjs" } }); assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block);
});

test("development_flow registra un verde fallido sin poder completar el paso ni perder su salida", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
	await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	const state = await f.state(); const failure = state.evidence.at(-1)!;
	assert.equal(failure.kind, "green"); assert.equal(failure.outcome, "failed"); assert.match(failure.output, /AssertionError/);
	assert.equal(state.steps[0]?.green, null);
	await assert.rejects(f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs"], message: "fix: falso" }), /rojo|verde/);
});

async function implemented(t: import("node:test").TestContext) {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 2" });
	return f;
}

test("development_flow una vuelta de corrección con Git real agrega un paso con rojo, verde y commit propios", async (t) => {
	const f = await implemented(t);
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" });
	await f.action({ action: "retry", reason: "El lente pidió cubrir el valor 3" });
	const retried = await f.state();
	assert.equal(retried.phase, "implement"); assert.equal(retried.steps[0]?.status, "done"); assert.equal(retried.steps[1]?.id, "C2"); assert.equal(retried.steps[1]?.status, "pending");
	const firstCommit = retried.steps[0]?.commit;
	await f.action({ action: "step", id: "C2" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 3);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C2" });
	assert.equal((await f.state()).steps[1]?.red, (await f.state()).evidence.at(-1)?.id);
	await f.write("value.cjs", "module.exports = 3;\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C2" });
	await f.invoke("omi_workflow_commit", { stepId: "C2", paths: ["test.cjs", "value.cjs"], message: "fix: devolver 3" });
	const corrected = await f.state();
	assert.equal(corrected.phase, "verify"); assert.equal(corrected.round, 1); assert.ok(corrected.steps[1]?.commit); assert.notEqual(corrected.steps[1]?.commit, firstCommit);
	await f.invoke("omi_workflow_check", { kind: "verification", command: "node test.cjs", caseId: "D1" }); await f.invoke("omi_workflow_lens", { lens: "quality" });
	await f.action({ action: "verified" }); assert.equal((await f.state()).phase, "pr");
});

test("development_flow el modelo no puede volver a explorar sin un sí humano; la persona sí con /omi-work refresh", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	f.remote.confirmations = false; const prompts = f.prompts.length;
	const declined = await f.action({ action: "refresh" });
	assert.equal(f.prompts.length, prompts + 1, "refresh del modelo pide confirmación"); assert.equal(declined.terminate, true);
	assert.equal((await f.state()).phase, "implement"); assert.ok((await f.state()).approval);
	f.remote.confirmations = true; await f.action({ action: "refresh" });
	assert.equal((await f.state()).phase, "explore"); assert.equal((await f.state()).approval, null);
	await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	const before = f.prompts.length; await f.command("refresh");
	assert.equal(f.prompts.length, before, "el comando humano no pide otra confirmación"); assert.equal((await f.state()).phase, "explore");
});

test("development_flow declinar /omi-work approve no vuelve a disparar al modelo", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	f.remote.confirmations = false; const messages = f.messages.length;
	await f.command("approve");
	assert.equal((await f.state()).approval, null);
	assert.ok(!f.messages.slice(messages).some((m) => m.startsWith("Continuá el harness")), "un no humano no reenvía el pedido de aprobar");
});

test("development_flow /omi-work stop sale también de un trabajo pausado y restaura las tools", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.command("pause");
	assert.equal((await f.state()).status, "paused");
	await f.command("stop");
	assert.equal(await f.emit("tool_call", { toolName: "bash", input: { command: "true" } }), undefined, "sin harness activo, bash vuelve a estar disponible");
	assert.equal((await f.state()).status, "paused");
});

test("development_flow los paths del commit son literales: un pathspec mágico no stagea el repo", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.write("value.cjs", "module.exports = 2;\n"); await f.write("credentials.local", "secret\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await assert.rejects(f.invoke("omi_workflow_commit", { stepId: "C1", paths: [":(top)"], message: "fix: todo" }));
	const { execFileSync } = await import("node:child_process");
	assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: f.checkout.root, encoding: "utf8" }), "", "el índice queda como estaba");
});

test("development_flow /omi-work stop sale de un harness bloqueado por estado inválido y lo muestra en el status", async (t) => {
	const f = await developmentFixture(t); await f.start();
	const { workflowPath } = await import("../src/harness/store.ts"); const { readFile, writeFile } = await import("node:fs/promises");
	const path = workflowPath(f.checkout, 42); const original = await readFile(path, "utf8");
	const corrupt = original.replace(/"version":\s*\d+/, '"version": 999');
	assert.notEqual(corrupt, original, "la fixture introduce una versión futura de verdad");
	await writeFile(path, corrupt);
	await f.attach();
	assert.ok(f.statuses.at(-1)?.includes("bloqueado"), "el bloqueo se ve aunque no haya estado");
	assert.ok(await f.emit("tool_call", { toolName: "bash", input: { command: "true" } }), "bloqueado no habilita bash");
	await f.command("stop");
	assert.equal(await f.emit("tool_call", { toolName: "bash", input: { command: "true" } }), undefined);
	assert.equal(await f.emit("user_bash", {}), undefined);
	await f.attach();
	assert.equal(await f.emit("tool_call", { toolName: "bash", input: { command: "true" } }), undefined, "al recargar la sesión sigue fuera del harness");
});

test("development_flow aprobar ofrece resumen y comandos completos autorizados sin volver a preguntar", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan("large") });
	await f.action({ action: "specified", spec: { why: "Dos valores", steps: [{ id: "C1", title: "Ambos", cases: ["D1", "D2"] }], playbook: ["Probar"] } });
	await f.action({ action: "approve" });
	const description = f.confirmationDetails[f.prompts.lastIndexOf("Aprobar receta y sincronizar issue")] ?? "";
	assert.match(f.reviewScreens[0]!, /Resumen/); assert.match(f.reviewScreens[0]!, /Objetivo/);
	assert.match(description, /sin volver a preguntar/); assert.match(description, /Pruebas y comandos exactos/);
	for (const c of (await f.state()).recipe!.cases) { assert.ok(description.includes(c.id)); assert.ok(description.includes(c.description)); assert.ok(description.includes(c.command)); }
	assert.match(description, /commits locales/); assert.match(description, /No autoriza push, merge/);
});

test("development_flow un directorio con un archivo protegido no deja el índice contaminado", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n'); await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	const { mkdir } = await import("node:fs/promises"); await mkdir(`${f.checkout.root}/d`); await f.write("d/.env", "TOKEN=x\n"); await f.write("d/a.txt", "a\n");
	await f.write("value.cjs", "module.exports = 2;\n"); await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	await assert.rejects(f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["d", "test.cjs", "value.cjs"], message: "fix: todo" }), /proteg|secreto/);
	const { execFileSync } = await import("node:child_process");
	assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: f.checkout.root, encoding: "utf8" }), "", "lo stageado por el intento se deshace");
});

test("development_flow tras declinar la aprobación el modelo re-planifica y se vuelve a pedir el sí", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	f.remote.confirmations = false; await f.action({ action: "approve" }); assert.equal((await f.state()).phase, "approve");
	await f.action({ action: "planned", plan: { ...f.plan(), objective: "Devolver 2 con el ajuste pedido" } });
	assert.equal((await f.state()).recipe?.objective, "Devolver 2 con el ajuste pedido");
	f.remote.confirmations = true; await f.action({ action: "approve" }); assert.equal((await f.state()).phase, "implement");
});

test("development_flow un pedido que no entra en el PR draft de GitHub falla al iniciar, antes de autorizar", async (t) => {
	const f = await developmentFixture(t); f.remote.body = "x".repeat(70000); const prompts = f.prompts.length;
	await f.start();
	assert.equal(f.prompts.length, prompts, "no se pide autorizar un trabajo que no se podrá aprobar"); assert.ok(f.messages.some((m) => /GitHub|grande/i.test(m)));
	const { readWorkflow } = await import("../src/harness/store.ts"); assert.equal(await readWorkflow(f.checkout, 42), undefined);
});

test("development_flow una respuesta humana demasiado larga se rechaza con un mensaje claro", async (t) => {
	const f = await developmentFixture(t); await f.start(); await f.readReference();
	await f.action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "Valor" }], findings: [], approach: "Corregir", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } });
	await f.action({ action: "inferences", inferences: [{ id: "I1", kind: "what", question: "¿Alcance?", recommended: "chico", confidence: 10, irreversible: false, references: [] }] });
	f.remote.answer = "r".repeat(4001);
	await assert.rejects(f.action({ action: "ask", id: "I1" }), /4\.000|larga/);
	assert.equal((await f.state()).inferences[0]?.resolution, "pending");
});
