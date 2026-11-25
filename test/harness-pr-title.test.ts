// Título del PR draft: un commit convencional, porque el squash a main usa el título del PR como asunto
// y scripts/next-release.ts decide la versión por ese asunto (caso real: #93 salió como parche).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceHash, type Recipe, type WorkflowV2 } from "../src/harness/model.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { defaultLifecycleConfig, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import { initializeLifecycle } from "../src/harness/lifecycle-state.ts";
import { pullRequestTitle } from "../src/harness/pr-title.ts";

const at = "2026-01-01T00:00:00Z", repo = "acme/repo";
type RecipeType = Recipe["classification"]["type"];
function workflow(title: string, type: RecipeType | null): WorkflowV2 {
 const w = createWorkflow({ number: 42, title, body: "Pedido", url: `https://github.com/${repo}/issues/42`, hash: sourceHash(title, "Pedido") }, { root: "/repo", commonDir: "/repo/.git", branch: "feat/issue-42-trabajo", baseCommit: "a".repeat(40) }, "w", at);
 if (type) w.recipe = { route: "direct", classification: { type, size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Objetivo", approach: "Enfoque", scope: [], outOfScope: [], cases: [{ id: "D1", description: "Caso", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
 return w;
}
function stacked(w: WorkflowV2): WorkflowV2 {
 const pull = (title: string, i: number) => ({ title, steps: [`C${i + 1}`], branch: `${w.checkout.branch}-${i + 1}`, base: i ? `${w.checkout.branch}-${i}` : "main", head: String(i + 1).repeat(40), number: null, url: null, status: "planned" as const });
 return { ...w, publication: { status: "pending", head: "2".repeat(40), bodyHash: "body", at, stack: [pull("Modelo", 0), pull("Vista", 1)] } };
}
// El checkout de recuperación activo es el que publica: el estado que arma el fix-forward para publishDraft.
function fixForward(w: WorkflowV2): WorkflowV2 {
 const block = defaultLifecycleConfig(repo, "main");
 const lifecycle = initializeLifecycle({ workflowId: w.id, issue: 42, repo }, { key: { kbUrl: "https://kb.example.test/mcp", product: "repo", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } });
 const checkout = { root: "/fix-forward", commonDir: "/fix-forward/.git", branch: "fix/recovery-43", baseCommit: "c".repeat(40) };
 lifecycle.recoveryWorkspaces = [{ id: "workspace1", operationId: "fix1", failureDeliveryId: "delivery:ship1:1", sourceSubjectId: "subject", targetId: "delivery", configHash: "e".repeat(64), checkout, base: "main", baseSha: "c".repeat(40), scopeHash: "f".repeat(64), scopeSource: "person", stepId: "C2", evidenceOffset: 0, reviewOffset: 0, at, status: "verified", head: "d".repeat(40), fingerprint: "f".repeat(64), pushOperationId: null, pullRequest: null }];
 lifecycle.activeRecoveryId = "workspace1";
 return { ...w, lifecycle, checkout };
}

test("el tipo de la receta aprobada va adelante del título del issue; una Mejora es feat", () => {
 const title = "Guiar la configuración de Foundations y lifecycle en la TUI";
 const expected: Record<RecipeType, string> = { add: "feat", improve: "feat", fix: "fix", chore: "chore" };
 for (const [type, prefix] of Object.entries(expected) as [RecipeType, string][]) assert.equal(pullRequestTitle(workflow(title, type)), `${prefix}: ${title}`, type);
});

test("un título de issue que ya es un commit convencional queda igual, también con scope o !", () => {
 for (const title of ["fix(harness): PRs en Markdown legible", "feat!: Cambio incompatible", "docs: Guía del harness", "refactor(tui)!: Partir el panel"]) assert.equal(pullRequestTitle(workflow(title, "add")), title);
});

test("lo que el gate de commits no acepta como convencional lleva el tipo de la receta", () => {
 for (const title of ["Fix: mayúscula", "feature: tipo inexistente", "feat:sin espacio", "feat(Harness): scope en mayúsculas"]) assert.equal(pullRequestTitle(workflow(title, "fix")), `fix: ${title}`);
});

test("sin receta el título queda como hasta ahora", () => {
 assert.equal(pullRequestTitle(workflow("Trabajo", null)), "Trabajo");
});

test("en un stack el tipo va una sola vez, al principio del título completo de cada PR", () => {
 const w = stacked(workflow("Trabajo grande", "add"));
 assert.equal(pullRequestTitle(w, { index: 0 }), "feat: Trabajo grande · PR 1/2: Modelo");
 assert.equal(pullRequestTitle(w, { index: 1 }), "feat: Trabajo grande · PR 2/2: Vista");
 assert.equal(pullRequestTitle(stacked(workflow("fix(tui): Trabajo grande", "add")), { index: 0 }), "fix(tui): Trabajo grande · PR 1/2: Modelo");
});

test("el PR de un fix-forward siempre es fix: corrige un PR ya mergeado, sea cual sea la receta o el título", () => {
 assert.equal(pullRequestTitle(fixForward(workflow("Change", "add"))), "fix: Change");
 assert.equal(pullRequestTitle(fixForward(workflow("feat(tienda)!: Change", "add"))), "fix: Change", "sin el tipo, el scope ni el ! del original");
 assert.equal(pullRequestTitle(fixForward(workflow("fix: Change", "fix"))), "fix: Change");
 assert.equal(pullRequestTitle(fixForward(workflow("Change", null))), "fix: Change");
 const original = fixForward(workflow("Change", "add")); assert.equal(pullRequestTitle({ ...original, checkout: workflow("Change", "add").checkout }), "feat: Change", "la publicación desde el checkout original no es el fix-forward");
});

test("el título nunca pasa los 256 caracteres de GitHub: se recorta el resumen y se conservan el tipo y el sufijo del stack", () => {
 const exact = "a".repeat(256), chars = (text: string) => Array.from(text).length;
 const single = pullRequestTitle(workflow(exact, "add"));
 assert.equal(chars(single), 256); assert.ok(single.startsWith("feat: a"), single.slice(0, 10)); assert.ok(single.endsWith("a…"), "recorte visible");
 assert.equal(pullRequestTitle(workflow("a".repeat(250), "add")), `feat: ${"a".repeat(250)}`, "si entra, queda entero");
 const wide = pullRequestTitle(workflow("😀".repeat(255), "fix"));
 assert.equal(chars(wide), 256, "cuenta caracteres, no unidades UTF-16"); assert.ok(wide.length > 256 && Array.from(wide).every(c => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff), "sin cortar un par sustituto"); assert.ok(wide.startsWith("fix: 😀"));
 const stack = pullRequestTitle(stacked(workflow("b".repeat(256), "add")), { index: 1 });
 assert.equal(chars(stack), 256); assert.ok(stack.startsWith("feat: b")); assert.ok(stack.endsWith("b… · PR 2/2: Vista"), stack.slice(-25));
 const forward = pullRequestTitle(fixForward(workflow(`feat: ${"c".repeat(250)}`, "add")));
 assert.equal(forward, `fix: ${"c".repeat(250)}`, "el fix-forward cambia el tipo y entra justo");
 assert.equal(chars(pullRequestTitle(fixForward(workflow("d".repeat(256), "add")))), 256);
});
