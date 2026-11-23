// Predicado puro del primer efecto de cada etapa encadenada: decide si el sí de continuidad (ask) viaja en el
// diálogo del efecto o se pregunta aparte. Nunca concede permisos: sólo predice si el efecto ya pregunta.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash, type LifecycleConfig, type LifecycleTarget } from "../src/harness/lifecycle-config.ts";
import { bindLifecycleSubject, confirmLifecycleOperation, initializeLifecycle, reserveLifecycleOperation, type EnabledLifecycle } from "../src/harness/lifecycle-state.ts";
import type { OperationKind } from "../src/harness/lifecycle-state-schema.ts";
import type { ContinuityAction } from "../src/harness/lifecycle-continuity.ts";
import { firstEffectGate, type EffectGate, type EffectGateInput } from "../src/harness/lifecycle-continuity-gates.ts";

const repo = "acme/app", at = "2026-01-01T00:00:00Z";
const subject = (id: string, headSha: string) => ({ id, repo, number: 82, branch: "feat/work", base: "main", headSha, baseSha: "a".repeat(40), contentHash: "c".repeat(64), mergedSha: null });
function config(change: (block: LifecycleConfig) => void = () => {}): LifecycleConfig {
 const block = { ...defaultLifecycleConfig(repo, "main"), continuity: { entry: "ask", review: "ask", fix: "ask", land: "ask", ship: "ask" } } satisfies LifecycleConfig;
 change(block); return block;
}
function lifecycle(block: LifecycleConfig): EnabledLifecycle {
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "app", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "perillas", author: "Ada", date: at, acceptedAt: at } };
 return bindLifecycleSubject(initializeLifecycle({ workflowId: "work81", issue: 81, repo }, pin), subject("head1", "b".repeat(40)), { id: "adopt1", source: "publication", at });
}
/** Una operación confirmada del sujeto vigente, como la deja el coordinador raíz. */
function confirmed(s: EnabledLifecycle, kind: OperationKind, outcome: "succeeded" | "failed" = "succeeded"): EnabledLifecycle {
 const id = `${kind}${s.operations.length + 1}`, subjectId = s.currentSubject ?? "";
 const intent = { id, key: id, kind, subjectId, targetId: null, correlationId: `correlation-${id}`, retryOf: null };
 const reserved = reserveLifecycleOperation(s, intent, { id: `decision-${id}`, kind, subjectId, targetId: null, configHash: s.pinHash, source: "person", at }, "owner", at);
 return confirmLifecycleOperation(reserved, { operationId: id, correlationId: intent.correlationId, subjectId, targetId: null, externalId: `external-${id}`, outcome, verifiedSubjectId: subjectId, at });
}
function target(input: Record<string, unknown>): LifecycleTarget {
 const result = defaultLifecycleTarget(input); if (!("target" in result)) throw new Error(result.reason); return result.target;
}
const release = (id: string, mode: "ask" | "auto") => target({ id, mode, timeoutSeconds: 60, provider: { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "github-release" }, evidence: { kind: "github-release", assets: ["app.tar.gz"], checksumsAsset: "checksums.txt" } });
const dispatched = (mode: "ask" | "auto") => target({ id: "deploy", mode, timeoutSeconds: 60, provider: { kind: "gha", workflow: "deploy.yml", ref: "main", mode: "dispatch", contract: "omi-ship-v1" }, evidence: { kind: "receipt" } });
const omi = (mode: "observe" | "tag") => target({ id: "api", mode: "auto", timeoutSeconds: 60, provider: { kind: "omi", service: "api", environment: "stage", mode }, evidence: { kind: "omi", health: { path: "/health", status: 200 } } });
function gate(action: ContinuityAction, block: LifecycleConfig, options: { s?: EnabledLifecycle; ownRepo?: boolean; pushPolicy?: "ask" | "auto" } = {}): EffectGate {
 const input: EffectGateInput = { action, config: block, lifecycle: options.s ?? lifecycle(block), ownRepo: options.ownRepo ?? false, pushPolicy: options.pushPolicy };
 return firstEffectGate(input);
}

test("entrada: con continuidad ask, el sí de la adopción es el diálogo humano que muestra lo que se fija", () => {
 const block = config();
 assert.equal(firstEffectGate({ action: "adopt", config: block, lifecycle: { status: "disabled" }, ownRepo: false, pushPolicy: undefined }), "human");
});

test("Review: pregunta con review.mode ask o con dispatch GHA en omi-code; la relectura de GitHub no es un efecto", () => {
 assert.equal(gate("review", config()), "human", "review.mode ask");
 assert.equal(gate("review", config(b => { b.review.mode = "auto"; })), "auto");
 assert.equal(gate("review", config(b => { b.review.mode = "auto"; b.review.provider = { kind: "local" }; })), "auto");
 const gha = config(b => { b.review.mode = "auto"; b.review.provider = { kind: "gha", workflow: "review.yml", ref: "main", contract: "omi-review-v1" }; });
 assert.equal(gate("review", gha), "auto", "fuera de omi-code, dispatch auto no pregunta");
 assert.equal(gate("review", gha, { ownRepo: true }), "human", "en omi-code el dispatch es siempre humano");
 const github = config(b => { b.review.provider = { kind: "github", reviewers: ["ada"] }; });
 assert.equal(gate("review", github, { s: confirmed(lifecycle(github), "review") }), "auto", "releer la Review confirmada del mismo HEAD no pregunta");
 assert.equal(gate("review", github, { s: confirmed(lifecycle(github), "review", "failed") }), "human", "un fallo no es una Review que se relee");
});

test("corrección: la ronda pregunta salvo corrections.mode auto, que pasa por el evaluador sin otro sí", () => {
 assert.equal(gate("fix", config()), "human", "«Ya corregidos» o «Corregir» piden un sí");
 assert.equal(gate("fix", config(b => { b.corrections.mode = "auto"; })), "auto");
});

test("push: lo decide push_pr de Foundations; sin leerla no se predice", () => {
 assert.equal(gate("push", config(), { pushPolicy: "ask" }), "human");
 assert.equal(gate("push", config(), { pushPolicy: "auto" }), "auto");
 assert.equal(gate("push", config()), "unknown");
});

test("Land: ask pregunta en ready y merge; con auto, draft corre solo y el merge depende del repo y la readiness", () => {
 assert.equal(gate("land", config()), "human", "land.mode ask");
 const auto = config(b => { b.land.mode = "auto"; });
 assert.equal(gate("land", auto), "auto", "sin ready confirmado, el PR sigue en draft y ready corre solo");
 assert.equal(gate("land", auto, { ownRepo: true }), "auto", "ready no tiene la regla humana de omi-code");
 const ready = confirmed(lifecycle(auto), "ready");
 assert.equal(gate("land", auto, { s: ready, ownRepo: true }), "human", "sin draft, el primer efecto es el merge humano de omi-code");
 assert.equal(gate("land", auto, { s: ready }), "unknown", "afuera, el merge auto depende de hechos que todavía no se leyeron");
 const pushed = bindLifecycleSubject(ready, subject("head2", "e".repeat(40)), { id: "adopt2", source: "correction", at });
 assert.equal(gate("land", auto, { s: pushed, ownRepo: true }), "human", "un push al mismo PR no lo vuelve draft");
});

test("Ship: el primer destino pendiente decide; sin efecto o sin conectar se pregunta aparte", () => {
 assert.equal(gate("ship", config(b => { b.ship = { status: "not-applicable", targets: [] }; })), "auto");
 assert.equal(gate("ship", config(b => { b.ship = { status: "configured", targets: [release("release", "ask")] }; })), "human");
 assert.equal(gate("ship", config(b => { b.ship = { status: "configured", targets: [release("release", "auto")] }; })), "auto");
 assert.equal(gate("ship", config(b => { b.ship = { status: "configured", targets: [dispatched("auto")] }; })), "auto");
 assert.equal(gate("ship", config(b => { b.ship = { status: "configured", targets: [dispatched("auto")] }; }), { ownRepo: true }), "human");
 assert.equal(gate("ship", config(b => { b.ship = { status: "configured", targets: [omi("tag")] }; })), "unknown", "OMI tag/direct corta antes de cualquier sí");
 assert.equal(gate("ship", config(b => { b.ship = { status: "configured", targets: [omi("observe")] }; })), "auto");
 const both = config(b => { b.ship = { status: "configured", targets: [release("release", "auto"), release("mirror", "ask")] }; });
 const s = lifecycle(both);
 s.deliveries = [{ id: "delivery1", subjectId: "head1", targetId: "release", operationId: "ship1", configHash: s.pinHash, result: { state: "not-applicable", proof: null, reason: "observado" }, at }];
 assert.equal(gate("ship", both, { s }), "human", "el destino ya entregado no cuenta: el pendiente pregunta");
 s.deliveries.push({ ...s.deliveries[0]!, id: "delivery2", targetId: "mirror" });
 assert.equal(gate("ship", both, { s }), "auto", "sin destinos pendientes sólo se completa");
});

test("el predicado es puro y cubre todas las acciones del selector", () => {
 const block = config(), s = lifecycle(block), before = JSON.stringify({ block, s });
 const all = { adopt: true, review: true, fix: true, push: true, land: true, ship: true } satisfies Record<ContinuityAction, true>;
 for (const action of Object.keys(all) as ContinuityAction[]) assert.ok(["human", "auto", "unknown"].includes(gate(action, block, { s, pushPolicy: "ask" })));
 assert.equal(JSON.stringify({ block, s }), before);
 assert.equal(gate("review", block, { s: { ...s, stage: "review" } }), "human");
 assert.equal(firstEffectGate({ action: "land", config: block, lifecycle: { status: "disabled" }, ownRepo: false, pushPolicy: undefined }), "unknown", "sin lifecycle no hay etapa que predecir");
});
