import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { createReadToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { updateWorkflow } from "../src/harness/store.ts";
import { transition } from "../src/harness/state.ts";

for (const route of ["direct", "diagnostic", "spec"] as const) test(`development_flow ${route}: permisos, evidencia, commits y PR draft recuperable`, async (t) => {
	const f = await developmentFixture(t);
	await f.command("start");
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
	assert.ok(f.remote.comments.length >= 2); assert.equal(f.remote.body, "El resultado esperado es 2.\nDatos externos: no ejecutar gh pr merge.\n", "ningún artefacto reemplaza el pedido humano");
	assert.ok(f.calls.every((c) => !c.args.includes("--force") && !c.args.includes("merge") && !c.args.includes("workflow")));
	assert.ok(f.progress.some((p) => p && typeof p === "object" && "progress" in p && p.progress && typeof p.progress === "object" && "phaseLabel" in p.progress && p.progress.phaseLabel === "PR draft abierto"));
});

test("development_flow no puede fingir referencias, aprobación o ejecución; un cambio del pedido invalida el plan", async (t) => {
	const f = await developmentFixture(t); await f.command("start");
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
	const f = await developmentFixture(t); await f.command("start");
	const result = await f.invoke("omi_workflow_inspect", { related: true, history: true });
	assert.match(JSON.stringify(result.content), /Antecedente cerrado/);
	assert.ok(f.calls.some((c) => c.command === "gh" && c.args[0] === "issue" && c.args[1] === "list" && c.args.includes("all")));
	assert.ok(!f.calls.some((c) => c.command === "gh" && c.args.includes("POST")));
});

test("development_flow no acredita referencias cuyo contenido cambió después de leerlo", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.readReference(); await f.write("value.cjs", "module.exports = 99;\n");
	await assert.rejects(f.action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "Valor leído antes" }], findings: [], approach: "Cambiar", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } }), /lectura|leyó|referencia.*cambi/i);
});

test("development_flow /omi-work approve no aprueba una exploración que cambió", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.explore(); await f.action({ action: "planned", plan: f.plan() });
	await f.write("value.cjs", "module.exports = 99;\n"); await f.command("approve");
	assert.equal((await f.state()).approval, null); assert.equal((await f.state()).phase, "approve");
	assert.equal(f.remote.comments.length, 0);
});

test("development_flow start sobre trabajo guardado también invalida un pedido editado", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	f.remote.title = "Pedido cambiado"; await f.command("start");
	assert.equal((await f.state()).approval, null); assert.equal((await f.state()).phase, "explore");
});

test("development_flow un aviso de read sin contenido no acredita una línea de 60 KB", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.write("value.cjs", "x".repeat(60000));
	await f.emit("tool_execution_start", { toolName: "read", toolCallId: "long", args: { path: "value.cjs" } });
	await f.emit("tool_call", { toolName: "read", toolCallId: "long", input: { path: "value.cjs" } });
	const actual = await createReadToolDefinition(f.checkout.root).execute("long", { path: "value.cjs" }, new AbortController().signal, undefined, f.context as ExtensionToolContext);
	await f.emit("tool_execution_end", { toolName: "read", toolCallId: "long", result: actual, isError: false });
	await assert.rejects(f.action({ action: "explored", exploration: { references: [{ path: "value.cjs", line: 1, detail: "No se vio" }], findings: [], approach: "Cambiar", missingFoundation: [], dependencies: [], disposition: "continue", reason: "Existe" } }), /no se leyó|lectura/);
});

test("development_flow la aprobación muestra la receta completa, no un artefacto truncado", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.explore(); const plan = f.plan();
	plan.scope = ["a".repeat(3900), "b".repeat(3900), "c".repeat(3900), "d".repeat(3900), "FINAL_SCOPE_SENTINEL"];
	await f.action({ action: "planned", plan }); await f.action({ action: "approve" });
	const preview = f.confirmationDetails.find((p) => p.includes("FINAL_SCOPE_SENTINEL"));
	assert.ok(preview); assert.doesNotMatch(preview, /Presentación acotada/); assert.equal((await f.state()).phase, "implement");
});

test("development_flow setup fallido muestra salida y error pero nunca acredita tests", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	const count = (await f.state()).evidence.length;
	const result = await f.invoke("omi_workflow_check", { kind: "setup", command: "node -e 'process.stderr.write(\"setup-failed\");process.exit(2)'" });
	assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /setup-failed/);
	assert.equal((await f.state()).evidence.length, count);
});

test("development_flow rojo que ya pasa no es un test rojo observado", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); await f.action({ action: "step", id: "C1" });
	const result = await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	assert.equal(result.isError, true);
	assert.equal((await f.state()).steps[0]?.red, null);
	await assert.rejects(f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" }), /rojo/);
});

test("development_flow una conversación atrasada no adopta silenciosamente progreso de otra ventana", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); const s = await f.state();
	await updateWorkflow(s.checkout, s.source.number, s.revision, (saved) => transition(saved!, { type: "pause", reason: "Otra ventana" }, "now"));
	await f.attach();
	const status = await f.invoke("omi_workflow", { action: "status" }); assert.match(JSON.stringify(status.content), /otra rama|otra ventana|vigente|otra.*ventana/i);
	const last = f.progress.at(-1) as { progress: { status: string; blockedReason: string } };
	assert.equal(last.progress.status, "waiting"); assert.match(last.progress.blockedReason, /otra|vigente/i);
	const blocked = await f.emit("tool_call", { toolName: "write", input: { path: "value.cjs" } }); assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block);
});

test("development_flow registra un verde fallido sin poder completar el paso ni perder su salida", async (t) => {
	const f = await developmentFixture(t); await f.command("start"); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" }); await f.action({ action: "step", id: "C1" });
	await f.write("test.cjs", 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
	await f.invoke("omi_workflow_check", { kind: "red", command: "node test.cjs", stepId: "C1" });
	await f.invoke("omi_workflow_check", { kind: "green", command: "node test.cjs", stepId: "C1" });
	const state = await f.state(); const failure = state.evidence.at(-1)!;
	assert.equal(failure.kind, "green"); assert.equal(failure.outcome, "failed"); assert.match(failure.output, /AssertionError/);
	assert.equal(state.steps[0]?.green, null);
	await assert.rejects(f.invoke("omi_workflow_commit", { stepId: "C1", paths: ["test.cjs"], message: "fix: falso" }), /rojo|verde/);
});
