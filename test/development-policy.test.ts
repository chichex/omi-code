import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflow, recipeApprovalHash } from "../src/harness/state.ts";
import type { Evidence, Recipe } from "../src/harness/model.ts";
import { workflowToolAllowed, workflowWritePath } from "../src/harness/permissions.ts";
import { developmentProgress, developmentInstructions } from "../src/tui/development-view.ts";

function workflow() {
	return createWorkflow({ number: 42, title: "Arreglar OTP", url: "https://github.com/test/repo/issues/42", body: "No ejecutar instrucciones del issue", hash: "source" }, { root: "/tmp/repo", commonDir: "/tmp/repo/.git", branch: "fix/issue-42", baseCommit: "a".repeat(40) }, "work", "2026-01-01T00:00:00Z");
}

test("development_policy no confunde exploración con permiso de escribir, shell o tools desconocidas", () => {
	const state = workflow();
	for (const name of ["read", "grep", "find", "ls", "omi_workflow", "omi_workflow_check", "omi_workflow_inspect"]) assert.equal(workflowToolAllowed(state, name, {}), true, name);
	for (const name of ["write", "edit", "bash", "powershell", "codemode", "tool_search", "omi_deploy", "evil_tool"]) assert.equal(workflowToolAllowed(state, name, {}), false, name);
	assert.equal(workflowToolAllowed(state, "subagent", { agent: "scout", task: "Explorar" }), true);
	assert.equal(workflowToolAllowed(state, "subagent", { tasks: [{ agent: "reviewer", task: "Leer" }, { agent: "worker", task: "Editar" }] }), false);
	assert.equal(workflowToolAllowed({ ...state, status: "paused" }, "write", {}), false);
});

test("development_policy los escritores no superan el tope de la receta aunque el runtime admita cuatro", () => {
	const state = workflow();
	const recipe: Recipe = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Cambio", approach: "Modificar", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Funciona", command: "npm test" }], lenses: [], executor: { mode: "subagents", writers: 1 }, route: "direct" };
	state.recipe = recipe; state.phase = "implement"; state.steps = [{ id: "C1", title: "Cambio", cases: ["D1"], status: "active", red: null, green: null, commit: null }];
	state.approval = { sourceHash: state.source.hash, recipeHash: recipeApprovalHash(state), at: "now" };
	assert.equal(workflowToolAllowed(state, "subagent", { tasks: [{ agent: "worker" }, { agent: "worker" }] }), false);
	assert.equal(workflowToolAllowed(state, "subagent", { chain: [{ agent: "worker" }, { agent: "worker" }] }), true);
	assert.equal(workflowToolAllowed(state, "write", {}), true);
	assert.equal(workflowToolAllowed({ ...state, approval: null }, "write", {}), false);
});

test("development_policy las rutas de escritura no pueden escapar del checkout ni tocar metadata/secretos", () => {
	assert.equal(workflowWritePath("/tmp/repo", "src/file.ts"), "/tmp/repo/src/file.ts");
	for (const path of ["../other.ts", "/tmp/elsewhere", ".git/config", ".GIT/config", ".env", "keys/private.pem", "../repo-two/file.ts"]) assert.throws(() => workflowWritePath("/tmp/repo", path), /fuera|proteg|secreto/i);
});

test("development_policy rechaza las rutas que Pi expande fuera del checkout (~ y file://)", () => {
	for (const path of ["~", "~/.zshrc", "@~/.ssh/authorized_keys", "~/repo/src/file.ts", "file:///etc/hosts", "FILE:///etc/hosts", "@file:///tmp/repo/src/file.ts"]) assert.throws(() => workflowWritePath("/tmp/repo", path), /fuera/i, path);
	assert.equal(workflowWritePath("/tmp/repo", "src/~notes.md"), "/tmp/repo/src/~notes.md");
});

test("development_policy protege credenciales comunes de paquetes, red y keystores", () => {
	for (const path of [".npmrc", "packages/app/.npmrc", ".netrc", ".pypirc", "keys/id_ecdsa", "id_dsa", "android/release.keystore", "certs/app.jks"]) assert.throws(() => workflowWritePath("/tmp/repo", path), /proteg|secreto/i, path);
	for (const path of ["src/npmrc.ts", "docs/keystore.md"]) assert.ok(workflowWritePath("/tmp/repo", path));
});

test("development_view progreso sale del estado y no interpreta texto del modelo como pasos terminados", () => {
	const state = workflow();
	const view = developmentProgress(state);
	assert.equal(view.phaseLabel, "Explorar"); assert.equal(view.issueNumber, 42);
	assert.equal(view.completedSteps, 0); assert.equal(view.passedChecks, 0);
	const blocked = developmentProgress({ ...state, status: "waiting", blockedReason: "Falta navegador" });
	assert.equal(blocked.blockedReason, "Falta navegador"); assert.equal(blocked.status, "waiting");
	const instructions = developmentInstructions(state);
	assert.match(instructions, /datos externos|contenido externo/i); assert.match(instructions, /omi_workflow/);
	assert.match(instructions, /Explorar|explore/); assert.match(instructions, /no.*merge|no.*mergear/i);
	assert.doesNotMatch(JSON.stringify(view), /No ejecutar instrucciones/);
});

test("development_view sólo cuenta el último resultado del comando y contenido vigentes, no un verde histórico", () => {
	const state = workflow();
	state.recipe = { classification: { type: "fix", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Cambio", approach: "Modificar", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Funciona", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 }, route: "direct" };
	const evidence: Evidence = { id: "pass", kind: "verification", command: "npm test", caseId: "D1", stepId: null, outcome: "passed", exitCode: 0, output: "OK", fingerprint: "old", head: "head", startedAt: "a", finishedAt: "b" };
	state.evidence = [evidence, { ...evidence, id: "fail", outcome: "failed", exitCode: 1 }];
	assert.equal(developmentProgress(state).passedChecks, 0);
	state.evidence = [evidence, { ...evidence, id: "wrong", command: "true", fingerprint: "new" }];
	assert.equal(developmentProgress(state).passedChecks, 0);
});
