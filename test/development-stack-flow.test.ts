// Recorrido completo de un stack: receta con spec agrupada, dos PRs draft encadenados y el issue mostrándolos.
import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentFixture } from "./helpers/development.ts";
import { parseIssueBody } from "../src/harness/issue-section.ts";

test("development_stack_flow: dos grupos de pasos terminan en dos PRs draft, el segundo sobre la rama del primero", async (t) => {
	const f = await developmentFixture(t);
	await f.start(); await f.explore();
	await f.action({ action: "planned", plan: f.plan("large") });
	await f.action({ action: "specified", spec: { why: "Se revisa mejor por partes", steps: [{ id: "C1", title: "Primer valor", cases: ["D1"] }, { id: "C2", title: "Segundo valor", cases: ["D2"] }], playbook: ["Ejecutar ambos casos"], stack: [{ title: "Primer valor", steps: ["C1"] }, { title: "Segundo valor", steps: ["C2"] }] } });
	await f.action({ action: "approve" });
	assert.match(f.confirmationDetails.at(-1) ?? "", /Stack de PRs/, "la revisión de la receta muestra el stack que se aprueba");
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
	const finished = await f.state(); const branch = f.checkout.branch; const commits = finished.steps.map((s) => s.commit);
	assert.equal(finished.phase, "done"); assert.equal(finished.publication.status, "opened");
	assert.match(f.confirmationDetails.at(-1) ?? "", new RegExp(`${branch}-2 → ${branch}-1`), "el sí del push muestra cada rama y su base");
	assert.deepEqual([...f.remote.pushed], [[`${branch}-1`, commits[0]], [`${branch}-2`, commits[1]]], "cada rama apunta al commit del último paso de su grupo");
	assert.deepEqual(f.remote.prs.map((p) => [p.number, p.head, p.base]), [[8, `${branch}-1`, "main"], [9, `${branch}-2`, `${branch}-1`]]);
	assert.match(f.remote.prs[0]!.body, /^Refs #42$/m); assert.match(f.remote.prs[1]!.body, /^Closes #42$/m);
	assert.deepEqual(finished.publication.status === "opened" ? [finished.publication.number, finished.publication.stack?.map((p) => p.number)] : [], [9, [8, 9]]);
	const section = parseIssueBody(f.remote.body).section ?? "";
	assert.match(section, /### Stack de PRs/);
	assert.match(section, /^- \*\*PR 1 de 2\*\* · https:\/\/github\.com\/test\/repo\/pull\/8 · base `main` · pasos C1 · draft · Primer valor$/m);
	assert.match(section, /^- \*\*PR 2 de 2\*\* · https:\/\/github\.com\/test\/repo\/pull\/9 · base `[^`]+-1` \(#8\) · pasos C2 · draft · Segundo valor$/m);
	assert.ok(f.calls.every((c) => !c.args.includes("--force") && !c.args.includes("merge") && !c.args.includes("workflow")));
	// Actualizar un stack al día pide el sí, no empuja ni re-apunta nada y lo dice.
	const before = f.calls.length;
	await f.command("stack");
	assert.ok(f.prompts.includes("Actualizar el stack de PRs"));
	assert.equal(f.calls.slice(before).filter((c) => c.args.includes("push") || c.args[1] === "edit").length, 0);
	assert.ok(f.messages.some((m) => /al día/.test(m)));
	assert.equal((await f.state()).revision, finished.revision, "sin cambios no se reescribe el estado");
});
