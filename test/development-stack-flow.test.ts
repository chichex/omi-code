// Recorrido completo de un stack: receta con spec agrupada, dos PRs draft encadenados y el issue mostrándolos.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { ASK_ALL } from "./helpers/foundations.ts";
import { parseIssueBody } from "../src/harness/issue-section.ts";

// Explora, aprueba una spec con dos grupos, implementa, verifica y publica. foundations: la política aceptada.
async function publishedStack(t: TestContext, foundations?: typeof ASK_ALL) {
	const f = await developmentFixture(t, foundations ? { foundations } : {});
	await f.start(); await f.explore();
	await f.action({ action: "planned", plan: f.plan("large") });
	await f.action({ action: "specified", spec: { why: "Se revisa mejor por partes", steps: [{ id: "C1", title: "Primer valor", cases: ["D1"] }, { id: "C2", title: "Segundo valor", cases: ["D2"] }], playbook: ["Ejecutar ambos casos"], stack: [{ title: "Primer valor", steps: ["C1"] }, { title: "Segundo valor", steps: ["C2"] }] } });
	await f.action({ action: "approve" });
	const review = f.confirmationDetails.at(-1) ?? "";
	for (const [index, step] of (await f.state()).steps.entries()) {
		const testPath = index ? "other-test.cjs" : "test.cjs"; const valuePath = index ? "other.cjs" : "value.cjs";
		await f.action({ action: "step", id: step.id });
		await f.write(testPath, `require("node:assert/strict").equal(require("./${valuePath}"), 2);\n`);
		await f.invoke("omi_workflow_check", { kind: "red", command: `node ${testPath}`, stepId: step.id });
		await f.write(valuePath, "module.exports = 2;\n");
		await f.invoke("omi_workflow_check", { kind: "green", command: `node ${testPath}`, stepId: step.id });
		await f.invoke("omi_workflow_commit", { stepId: step.id, paths: [testPath, valuePath], message: `fix: ${step.title}` });
	}
	for (const c of (await f.state()).recipe!.cases) await f.invoke("omi_workflow_check", { kind: "verification", command: c.command, caseId: c.id });
	await f.invoke("omi_workflow_lens", { lens: "quality" });
	await f.action({ action: "verified" });
	await f.action({ action: "publish" });
	return { f, review, finished: await f.state(), branch: f.checkout.branch };
}
// Lo que tiene que pasar en GitHub y en el issue, con cualquier política.
function assertTwoDrafts({ f, finished, branch }: Awaited<ReturnType<typeof publishedStack>>) {
	const commits = finished.steps.map((s) => s.commit);
	assert.equal(finished.phase, "done"); assert.equal(finished.publication.status, "opened");
	assert.deepEqual([...f.remote.pushed], [[`${branch}-1`, commits[0]], [`${branch}-2`, commits[1]]], "cada rama apunta al commit del último paso de su grupo");
	assert.deepEqual(f.remote.prs.map((p) => [p.number, p.head, p.base]), [[8, `${branch}-1`, "main"], [9, `${branch}-2`, `${branch}-1`]]);
	assert.match(f.remote.prs[0]!.body, /^Refs #42$/m); assert.match(f.remote.prs[1]!.body, /^Closes #42$/m);
	assert.deepEqual(finished.publication.status === "opened" ? [finished.publication.number, finished.publication.stack?.map((p) => p.number)] : [], [9, [8, 9]]);
	const section = parseIssueBody(f.remote.body).section ?? "";
	assert.match(section, /### Stack de PRs/);
	assert.match(section, /^- \*\*PR 1 de 2\*\* · https:\/\/github\.com\/test\/repo\/pull\/8 · base `main` · pasos C1 · draft · Primer valor$/m);
	assert.match(section, /^- \*\*PR 2 de 2\*\* · https:\/\/github\.com\/test\/repo\/pull\/9 · base `[^`]+-1` \(#8\) · pasos C2 · draft · Segundo valor$/m);
	assert.ok(f.calls.every((c) => !c.args.includes("--force") && !c.args.includes("merge") && !c.args.includes("workflow")));
}

test("development_stack_flow con todo ask: dos grupos terminan en dos PRs draft, el segundo sobre la rama del primero, y cada sí muestra el stack", async (t) => {
	const run = await publishedStack(t, ASK_ALL); const { f, branch, finished } = run;
	assert.match(run.review, /Stack de PRs/, "la revisión de la receta muestra el stack que se aprueba");
	assert.ok(f.prompts.includes("Subir rama y abrir PR draft"));
	assert.match(f.confirmationDetails.at(-1) ?? "", new RegExp(`${branch}-2 → ${branch}-1`), "el sí del push muestra cada rama y su base");
	assertTwoDrafts(run);
	// Con push_pr: ask, actualizar pide el sí; un stack al día no empuja ni re-apunta nada y lo dice.
	const before = f.calls.length;
	await f.command("stack");
	assert.ok(f.prompts.includes("Actualizar el stack de PRs"));
	assert.equal(f.calls.slice(before).filter((c) => c.args.includes("push") || c.args[1] === "edit").length, 0);
	assert.ok(f.messages.some((m) => /al día/.test(m)));
	assert.equal((await f.state()).revision, finished.revision, "sin cambios no se reescribe el estado");
	// Decir que no a actualizar no lee GitHub.
	f.remote.confirmations = false; const declined = f.calls.length;
	await f.command("stack");
	assert.equal(f.calls.slice(declined).filter((c) => c.command === "gh" && c.args[0] === "pr").length, 0);
});

test("development_stack_flow por defecto (todo auto): publicar y actualizar el stack no preguntan y avisan qué hacen", async (t) => {
	const run = await publishedStack(t); const { f, branch } = run;
	assert.ok(!f.prompts.includes("Subir rama y abrir PR draft"), "push_pr: auto no pregunta");
	assert.ok(f.messages.some((m) => m.includes("push + PR draft auto") && m.includes(`${branch}-2 → ${branch}-1`)), "el aviso muestra cada rama y su base");
	assertTwoDrafts(run);
	const before = f.calls.length;
	await f.command("stack");
	assert.ok(!f.prompts.includes("Actualizar el stack de PRs"), "actualizar sigue push_pr: auto y no pregunta");
	assert.ok(f.messages.some((m) => m.includes("push + PR draft auto") && /Stack de 2 PRs/.test(m)));
	assert.ok(f.calls.slice(before).some((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "view"), "sin preguntar, lee el stack en GitHub");
	assert.ok(f.messages.some((m) => /al día/.test(m)));
});
