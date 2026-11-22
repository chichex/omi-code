// D15 · progreso honesto: fases reales Review/Land/Ship/Entregado con rondas, presupuesto, checks, hallazgos y
// bloqueos; un legacy en done sigue siendo «PR draft abierto». Proyección pura: sin red, Git ni modelo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { sourceHash, type Evidence, type Plan, type WorkflowV2 } from "../src/harness/model.ts";
import { PHASES, PHASES_V1 } from "../src/harness/phases.ts";
import { lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { adoptPostPrWorkflow } from "../src/harness/lifecycle-corrections.ts";
import { acceptObservedMerge } from "../src/harness/lifecycle-land.ts";
import { recordShipVerification, completeShip } from "../src/harness/ship-state.ts";
import { developmentProgress } from "../src/tui/development-view.ts";
import { WorkflowProgressMonitor, workflowProgressDetail, workflowProgressPanel, workflowProgressView } from "../src/tui/workspace/workflow-progress.ts";
import { AT, lifecycleConfig } from "./helpers/lifecycle.ts";

const repo = "acme/app", base = "a".repeat(40), head = "b".repeat(40), fingerprint = "c".repeat(64), merged = "f".repeat(40), release = "d".repeat(40);
const plan: Plan = { classification: { type: "add", size: "small", risk: "low", riskAreas: [], causeKnown: true }, objective: "Feature", approach: "Extend", scope: ["app"], outOfScope: ["infra"], cases: [{ id: "D1", description: "works", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
const send = (r: WorkflowV2, event: Parameters<typeof transition>[1]) => transition(r, event, AT);
const evidence = (kind: Evidence["kind"]): Evidence => ({ id: kind, kind, stepId: ["red", "green"].includes(kind) ? "C1" : null, caseId: "D1", command: "npm test", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "observed", head, fingerprint, startedAt: AT, finishedAt: AT });
function draft(): WorkflowV2 {
 let r = createWorkflow({ number: 42, title: "Feature", body: "Scope", url: `https://github.com/${repo}/issues/42`, hash: sourceHash("Feature", "Scope") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", AT);
 r = send(r, { type: "explored", exploration: { references: [{ path: "app.ts", line: 1, detail: "entry" }], findings: [], approach: "extend", missingFoundation: [], dependencies: [], disposition: "continue", reason: "ready" } }); r = send(r, { type: "inferences", inferences: [] }); r = send(r, { type: "planned", plan }); r = send(r, { type: "approved" }); r = send(r, { type: "step_started", id: "C1" });
 r = send(r, { type: "evidence", evidence: evidence("red") }); r = send(r, { type: "evidence", evidence: evidence("green") }); r = send(r, { type: "step_completed", id: "C1", commit: head, fingerprint }); r = send(r, { type: "evidence", evidence: evidence("verification") }); r = send(r, { type: "verified", fingerprint });
 r = send(r, { type: "publishing", head, bodyHash: "body" }); return send(r, { type: "published", head, url: `https://github.com/${repo}/pull/42`, number: 42 });
}
const pin = (change?: Parameters<typeof lifecycleConfig>[1]) => { const block = lifecycleConfig(repo, change); return { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: AT, acceptedAt: AT } }; };
const subject = { id: "subject", repo, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: fingerprint, mergedSha: null };
function reviewed(change?: Parameters<typeof lifecycleConfig>[1]): WorkflowV2 {
 const r = adoptPostPrWorkflow(draft(), pin(change), subject, { id: "adopt", source: "person", at: AT }); assert.ok(r.lifecycle.status === "enabled");
 let s = life.reserveLifecycleOperation(r.lifecycle, { id: "review1", key: "review1", kind: "review", subjectId: "subject", targetId: null, correlationId: "review-correlation-1", retryOf: null }, { id: "review-decision", kind: "review", subjectId: "subject", targetId: null, configHash: r.lifecycle.pinHash, source: "person", at: AT }, "process", AT);
 s = life.confirmLifecycleOperation(s, { operationId: "review1", correlationId: "review-correlation-1", subjectId: "subject", targetId: null, verifiedSubjectId: "subject", externalId: "github:42", outcome: "succeeded", at: AT });
 s = life.ingestLifecycleFinding(s, { id: "F1", provider: "github", externalId: "501", operationId: "review1", subjectId: "subject", text: "Falta manejar el error", severity: "unknown", resolved: false, outdated: false, at: AT });
 s.checks.push({ id: "check-1001", subjectId: "subject", context: "cierre", appId: 15368, state: "success", externalId: "1001", at: AT });
 return { ...r, lifecycle: s };
}
function shipped(state: "verified" | "not-applicable"): WorkflowV2 {
 const change = state === "not-applicable" ? (b: Parameters<NonNullable<Parameters<typeof lifecycleConfig>[1]>>[0]) => { b.ship = { status: "not-applicable", targets: [] }; } : undefined;
 const r = adoptPostPrWorkflow(draft(), pin(change), subject, { id: "adopt", source: "person", at: AT });
 const pr = { number: 42, state: "closed", draft: false, merged: true, merge_commit_sha: merged, head: { sha: head, ref: "feat/work", repo: { full_name: repo } }, base: { sha: base, ref: "main", repo: { full_name: repo } } };
 let m = acceptObservedMerge(r, pr, { source: "external", at: AT }); assert.ok(m.lifecycle.status === "enabled");
 if (state === "not-applicable") return completeShip(m, AT);
 const current = m.lifecycle.currentSubject!;
 m.lifecycle = life.reserveLifecycleOperation(m.lifecycle, { id: "ship1", key: "ship1", kind: "ship", subjectId: current, targetId: "release", correlationId: "ship-correlation-0001", retryOf: null }, { id: "ship-decision", kind: "ship", subjectId: current, targetId: "release", configHash: m.lifecycle.pinHash, source: "person", at: AT }, "process", AT);
 const proof = { kind: "github-release", subjectId: current, targetId: "release", operationId: "ship1", configHash: m.lifecycle.pinHash, integratedSha: merged, probes: { health: "not-configured", version: "not-configured" }, repo, releaseId: 2002, tag: "v0.2.0", commitSha: release, runId: 1002, runAttempt: 1, checksumsId: 11, assets: [{ id: 10, name: "app-linux-x64.tar.gz", size: 3, sha256: "e".repeat(64) }] };
 m = recordShipVerification(m, "ship1", { state: "verified", proof, reason: "" }, AT);
 return completeShip(m, AT);
}
const text = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const themes = ["dark", "light"].map(name => getThemeByName(name)!);

test("legacy en done sigue siendo «PR draft abierto», sin fases nuevas ni entrega aparente", () => {
 const legacy = draft(); assert.equal(legacy.lifecycle.status, "disabled"); assert.equal(legacy.status, "complete");
 const p = developmentProgress(legacy);
 assert.equal(p.phaseLabel, "PR draft abierto"); assert.deepEqual(p.stages?.map(s => s.id), PHASES_V1.map(x => x.id));
 assert.match(text(p.lifecycle ?? []), /No hubo Review, Land ni Ship verificados/);
 for (const theme of themes) {
  const all = [text(workflowProgressView(theme, p, 72)), text(workflowProgressPanel(theme, p, 41, 40)), JSON.stringify(workflowProgressDetail(p))].join("\n");
  assert.doesNotMatch(all, /Entrega verificada|Entregado|Review del PR|Land · merge/);
  assert.match(all, /PR draft abierto/); assert.match(all, /No hubo Review, Land ni Ship/);
 }
});

test("Review muestra fases reales, ronda, presupuesto, checks, hallazgos y bloqueos observados", () => {
 const p = developmentProgress(reviewed());
 assert.equal(p.phaseLabel, "Review del PR"); assert.deepEqual(p.stages?.map(s => s.id), PHASES.map(x => x.id));
 assert.equal(p.stages?.find(s => s.current)?.id, "review"); assert.equal(p.stages?.find(s => s.id === "delivered")?.status, "pending");
 const lines = text(p.lifecycle ?? []);
 assert.match(lines, /Lifecycle · Review · PR #42/); assert.match(lines, /intentos 1\/12/); assert.match(lines, /rondas 0\/2/);
 assert.match(lines, /Checks del SHA actual: 1\/1 OK/); assert.match(lines, /Hallazgos: 1 pendiente/); assert.match(lines, /Bloqueo: F1/);
 assert.match(lines, /Ship release: espera el merge/);
 const detail = JSON.stringify(workflowProgressDetail(p)); assert.match(detail, /Hallazgos: 1 pendiente/);
});

test("Entregado sólo con recibos verificados; Ship no aplica termina sin aparentar entrega", () => {
 const delivered = developmentProgress(shipped("verified"));
 assert.equal(delivered.phaseLabel, "Entrega verificada"); assert.equal(delivered.stages?.find(s => s.id === "delivered")?.current, true);
 assert.match(text(delivered.lifecycle ?? []), /Resultado: entrega verificada/); assert.match(text(delivered.lifecycle ?? []), /Ship release: verified/);
 const skipped = developmentProgress(shipped("not-applicable"));
 assert.notEqual(skipped.phaseLabel, "Entrega verificada"); assert.notEqual(skipped.stages?.find(s => s.id === "delivered")?.status, "done");
 assert.match(text(skipped.lifecycle ?? []), /Ship no aplica/); assert.doesNotMatch(text(skipped.lifecycle ?? []), /entrega verificada/i);
});

test("temas y paneles bajos: el bloqueo gana y nada desborda el ancho", () => {
 const p = { ...developmentProgress(reviewed()), blockedReason: "Hay hallazgos pendientes" };
 for (const theme of themes) for (const width of [24, 41]) {
  const tall = workflowProgressPanel(theme, p, width, 40);
  assert.ok(tall.every(row => visibleWidth(row) <= width)); assert.match(text(tall), /hallazgos 1/i);
  const low = workflowProgressPanel(theme, p, width, 3);
  assert.ok(low.length <= 3); assert.ok(low.every(row => visibleWidth(row) <= width)); assert.match(text(low).split("\n").at(-1) ?? "", /^! Hay hallazgos/);
  assert.ok(workflowProgressView(theme, p, width).every(row => visibleWidth(row) === width));
 }
});

test("el bus conserva las líneas del lifecycle como copia defensiva", () => {
 const monitor = new WorkflowProgressMonitor(), p = developmentProgress(reviewed());
 assert.equal(monitor.consume({ progress: p }), true);
 const git = { root: "/fixture", gitDir: "/fixture/.git", commonDir: "/fixture/.git", mainRoot: "/fixture", linked: false, branch: "feat/work", detached: false, changes: [], changeCount: 0, tracking: false, ahead: undefined, behind: undefined };
 const copy = monitor.current("/fixture", git); assert.ok(copy?.lifecycle?.length); copy.lifecycle[0] = "mutado";
 assert.match(monitor.current("/fixture", git)?.lifecycle?.[0] ?? "", /Lifecycle · Review/);
});
