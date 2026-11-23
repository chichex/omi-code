import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryKb } from "./helpers/mock-kb.ts";
import { acceptLifecycleConfig } from "./helpers/lifecycle.ts";
import { batchProblem, type AskResult, type QuestionBatch } from "../src/tui/questions/batch.ts";
import { detectLifecycle } from "../src/harness/lifecycle-detect.ts";
import { lifecycleOnboardingStatus, runLifecycleOnboarding, shouldOfferLifecycleOnboarding } from "../src/harness/lifecycle-onboarding.ts";
import { readLifecycle } from "../src/harness/lifecycle-kb.ts";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash, renderLifecycleBlock, type LifecycleConfig } from "../src/harness/lifecycle-config.ts";
import { lifecycleTrustDir, readLifecycleTrust, type LifecycleKey } from "../src/harness/lifecycle-trust.ts";

const key: LifecycleKey = { kbUrl: "https://kb.example.test/mcp", product: "app", repo: "acme/app" };
const now = () => "2026-01-01T00:00:00Z";
const signal = () => AbortSignal.timeout(5000);
async function repo(t: TestContext) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "omi-onboarding-"))); t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, ".github/workflows"), { recursive: true }); await mkdir(join(root, ".omi"));
 await writeFile(join(root, ".github/workflows/release.yml"), "on:\n  push:\n    tags: ['v*']\n  workflow_dispatch:\njobs:\n  release:\n    steps:\n      - run: gh release create\n");
 await writeFile(join(root, ".github/workflows/ci.yaml"), "on: [pull_request]\n");
 await writeFile(join(root, "outside.yml"), "on: workflow_dispatch\n"); await symlink(join(root, "outside.yml"), join(root, ".github/workflows/linked.yml"));
 await writeFile(join(root, ".github/workflows/huge.yml"), `on: workflow_dispatch\n${"#".repeat(300 * 1024)}\n`);
 await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --test", deploy: "curl -H 'Authorization: Bearer SECRET' https://deploy" } }));
 await writeFile(join(root, "Dockerfile"), "FROM node:22\n");
 await writeFile(join(root, ".omi/project.json"), JSON.stringify({ version: 1, organizationSlug: "acme", projectSlug: "tienda", services: [{ name: "api", path: ".", port: 3000, dockerfile: "Dockerfile" }] }));
 return root;
}
async function snapshot(root: string): Promise<string[]> {
 const out: string[] = [];
 const walk = async (dir: string): Promise<void> => { for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const path = join(dir, entry.name); const info = await stat(path).catch(() => null); out.push(`${relative(root, path)}:${info?.mtimeMs}:${entry.isFile() ? (await readFile(path, "utf8")).length : "-"}`); if (entry.isDirectory()) await walk(path); } };
 await walk(root); return out;
}
// La persona responde por la tanda compartida; Esc es cancelled. Cada tanda debe ser válida para la TUI.
function script(answers: (string[] | "esc" | { text: string })[]) {
 const seen: QuestionBatch[] = [];
 const ask = async (batch: QuestionBatch): Promise<AskResult> => {
  assert.equal(batchProblem(batch), undefined); seen.push(batch);
  const replies = batch.questions.map(() => answers.shift()); if (replies.some(r => r === "esc" || r === undefined)) return { status: "cancelled" };
  return { status: "answered", answers: batch.questions.map((q, i) => { const r = replies[i]!; return typeof r === "object" && "text" in r ? { id: q.id, question: q.question, options: [], text: r.text } : { id: q.id, question: q.question, options: r as string[], text: null }; }) };
 };
 return { ask, seen };
}
// Workflow mínimo con los marcadores que valida el runtime de omi-review-v1.
const REVIEW_WORKFLOW = `name: Review
run-name: "\${{ inputs.correlation_id != '' && format('omi-review-v1 PR #{0} {1}', inputs.pr, inputs.correlation_id) || format('Review PR #{0}', inputs.pr) }}"
on:
  workflow_dispatch:
    inputs:
      pr:
        required: true
      expected_head_sha:
        required: false
      correlation_id:
        required: false
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: omi-review-v1-\${{ inputs.correlation_id }}-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: out/review.json
`;
async function fixture(t: TestContext, files: Record<string, string> = {}) {
 const root = await repo(t); for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
 const home = await realpath(await mkdtemp(join(tmpdir(), "omi-onboarding-home-"))); t.after(() => rm(home, { recursive: true, force: true }));
 const kb = memoryKb({ products: ["app"] }), trustDir = lifecycleTrustDir(home), detection = await detectLifecycle(root, signal());
 const deps = (ask: (batch: QuestionBatch) => Promise<AskResult>) => ({ kb, key, cwd: root, base: "main", trustDir, detection, ask, now, signal: signal() });
 const status = async () => lifecycleOnboardingStatus(await readLifecycle(kb, key, root, signal()), await readLifecycleTrust(trustDir, key), detection);
 return { root, home, kb, trustDir, detection, deps, status };
}

test("detector sólo lee workflows/scripts/manifiestos/vínculo, sin ejecutar ni seguir symlinks ni copiar valores", async t => {
 const root = await repo(t), before = await snapshot(root);
 const found = await detectLifecycle(root, signal());
 assert.deepEqual(found.workflows, [{ file: "ci.yaml", dispatch: false, release: false, contract: null }, { file: "release.yml", dispatch: true, release: true, contract: null }]);
 assert.deepEqual(found.scripts, ["deploy", "test"]); assert.deepEqual(found.manifests, ["Dockerfile", "package.json"]);
 assert.deepEqual(found.omi, { organization: "acme", project: "tienda", services: ["api"] });
 assert.deepEqual(found.skipped.sort(), [".github/workflows/huge.yml", ".github/workflows/linked.yml"]);
 assert.doesNotMatch(JSON.stringify(found), /SECRET|curl|node --test/, "valores de scripts no entran al contexto");
 assert.deepEqual(await snapshot(root), before, "detectar no escribe ni toca el repo");
 const empty = await realpath(await mkdtemp(join(tmpdir(), "omi-onboarding-empty-"))); t.after(() => rm(empty, { recursive: true, force: true }));
 assert.deepEqual(await detectLifecycle(empty, signal()), { workflows: [], scripts: [], manifests: [], omi: null, skipped: [] });
});

test("oferta contextual: al entrar al harness sin configuración; consultas simples/needs-info no preguntan", async t => {
 const f = await fixture(t), status = await f.status(); assert.equal(status.status, "unconfigured"); const local = await readLifecycleTrust(f.trustDir, key);
 assert.equal(shouldOfferLifecycleOnboarding("harness", status, local), true);
 assert.equal(shouldOfferLifecycleOnboarding("simple", status, local), false); assert.equal(shouldOfferLifecycleOnboarding("needs-info", status, local), false);
});

test("Esc cancela sin escribir ni desactivar; Más adelante posterga durable por repo/revisión y no insiste", async t => {
 const f = await fixture(t), esc = script(["esc"]);
 assert.deepEqual(await runLifecycleOnboarding(f.deps(esc.ask)), { kind: "cancelled" }); assert.equal(esc.seen.length, 1);
 assert.deepEqual(await readLifecycleTrust(f.trustDir, key), { kind: "missing" }); assert.ok(!f.kb.calls.some(c => c.tool === "guardar"));
 const first = await f.status(); assert.equal(first.status, "unconfigured"); assert.equal(shouldOfferLifecycleOnboarding("harness", first, await readLifecycleTrust(f.trustDir, key)), true, "Esc no desactiva ni posterga");
 const options = esc.seen[0]!.questions[0]!.options.map(o => o.label); assert.deepEqual(options, ["Configurar ahora", "Más adelante", "Este repo no necesita Ship"]);
 const later = script([["Más adelante"]]); const deferred = await runLifecycleOnboarding(f.deps(later.ask)); assert.equal(deferred.kind, "deferred");
 const local = await readLifecycleTrust(f.trustDir, key); assert.ok(local.kind === "valid"); assert.equal(local.record.accepted, null); assert.equal(local.record.deferred?.revision, first.revision);
 const after = await f.status(); assert.equal(after.status, "unconfigured", "postergar no es no-aplica"); assert.equal(shouldOfferLifecycleOnboarding("harness", after, local), false, "no insiste en cada prompt");
 assert.ok(!f.kb.calls.some(c => c.tool === "guardar"), "postergar no escribe la KB");
 f.kb.perillas("app", "# Perillas de app\n\nOtra revisión\n"); const changed = await f.status(); assert.notEqual(changed.revision, first.revision); assert.equal(shouldOfferLifecycleOnboarding("harness", changed, local), true, "revisión faltante nueva vuelve a ofrecer");
 const again = script(["esc"]); await runLifecycleOnboarding(f.deps(again.ask)); assert.equal(again.seen.length, 1, "init explícito pregunta aunque haya postergación");
});

test("no-aplica explícito requiere resumen y aceptación; ausencia de release no es no-aplica", async t => {
 const f = await fixture(t), declined = script([["Este repo no necesita Ship"], ["Mantener continuidad actual"], ["No guardar"]]);
 assert.deepEqual(await runLifecycleOnboarding(f.deps(declined.ask)), { kind: "declined" }); assert.ok(!f.kb.calls.some(c => c.tool === "guardar")); assert.equal((await f.status()).status, "unconfigured");
 const summary = declined.seen[2]!.questions[0]!; assert.match(summary.detail ?? "", /ship\.status: unconfigured → not-applicable/); assert.equal(summary.recommended, false, "aceptar nunca es la opción por defecto");
 const accepted = script([["Este repo no necesita Ship"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]); const outcome = await runLifecycleOnboarding(f.deps(accepted.ask));
 assert.ok(outcome.kind === "saved"); assert.equal(outcome.pin.block.ship.status, "not-applicable"); assert.equal((await f.status()).status, "not-applicable");
});

test("configurar desde lo detectado guarda KB y acepta tras el resumen, sin ejecutar workflow ni deploy", async t => {
 const f = await fixture(t);
 const answers: (string[] | { text: string })[] = [["Configurar ahora"], ["OMI · api · stage"], { text: "/health" }, ["Detener (stop)"], ["Preguntar antes (ask)"], ["Mantener continuidad actual"], ["Guardar y aceptar"]];
 const run = script(answers); const outcome = await runLifecycleOnboarding(f.deps(run.ask)); assert.ok(outcome.kind === "saved");
 const mechanisms = run.seen[1]!.questions.find(q => q.id === "mechanism")!.options.map(o => o.label); assert.ok(mechanisms.includes("GitHub Actions · release.yml")); assert.ok(mechanisms.includes("OMI · api · stage")); assert.ok(mechanisms.includes("Manual (sin destino verificable)"));
 assert.deepEqual(outcome.pin.block.ship, { status: "configured", targets: [{ id: "omi-api-stage", mode: "ask", timeoutSeconds: 1800, maxRetries: 0, onFailure: { action: "stop", mode: "ask" }, provider: { kind: "omi", service: "api", environment: "stage", mode: "observe" }, evidence: { kind: "omi", health: { path: "/health", status: 200 } } }] });
 assert.equal((await f.status()).status, "configured"); assert.deepEqual(new Set(f.kb.calls.map(c => c.tool)), new Set(["mis_productos", "buscar", "leer", "guardar"])); assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
 assert.match(run.seen.at(-1)!.questions[0]!.detail ?? "", /no ejecuta review, merge, workflows ni deploy/);
 const gha = await fixture(t), ship = script([["Configurar ahora"], ["GitHub Actions · release.yml"], ["Recibo del proveedor"], ["Detener (stop)"], ["Automático (auto)"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]); const saved = await runLifecycleOnboarding(gha.deps(ship.ask)); assert.ok(saved.kind === "saved");
 assert.deepEqual(saved.pin.block.ship.targets[0]?.provider, { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "omi-ship-v1" }); assert.equal(saved.pin.block.ship.targets[0]?.mode, "auto");
});

test("continuidad opt-in configura cinco etapas, separa permisos y guardar no inicia efectos", async t => {
 const f = await fixture(t), before = await snapshot(f.root);
 const run = script([["Este repo no necesita Ship"], ["Configurar continuidad"], ["Automático (auto)"], ["Preguntar antes (ask)"], ["Manual (comando explícito)"], ["Automático (auto)"], ["Manual (comando explícito)"], ["Guardar y aceptar"]]);
 const outcome = await runLifecycleOnboarding(f.deps(run.ask)); assert.ok(outcome.kind === "saved");
 assert.deepEqual(outcome.pin.block.continuity, { entry: "auto", review: "ask", fix: "manual", land: "auto", ship: "manual" });
 assert.equal(outcome.pin.block.corrections.mode, "ask", "continuidad no cambia autorización de efectos");
 assert.deepEqual(run.seen[1]!.questions[0]!.options.map(o => o.label), ["Mantener continuidad actual", "Configurar continuidad"]);
 const detail = run.seen.at(-1)!.questions[0]!.detail ?? "";
 assert.match(detail, /continuity.entry: auto/); assert.match(detail, /Foundations/); assert.match(detail, /merge.*dispatch.*human/i);
 assert.deepEqual(await snapshot(f.root), before); assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
});

test("mantener legacy conserva hash, cancelar o rechazar no guarda y deshabilitar sólo cambia futuro", async t => {
 const f = await fixture(t), legacy = defaultLifecycleConfig(key.repo, "main"); legacy.ship = { status: "not-applicable", targets: [] };
 f.kb.perillas("app", renderLifecycleBlock(legacy));
 const keep = script([["Este repo no necesita Ship"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]);
 const kept = await runLifecycleOnboarding(f.deps(keep.ask)); assert.ok(kept.kind === "saved");
 assert.equal(kept.pin.blockHash, lifecycleHash(legacy)); assert.equal(Object.hasOwn(kept.pin.block, "continuity"), false);
 for (const replies of [ [ ["Este repo no necesita Ship"], "esc" ], [ ["Este repo no necesita Ship"], ["Configurar continuidad"], "esc" ] ] as (string[] | "esc")[][]) {
  const writes = f.kb.calls.filter(c => c.tool === "guardar").length;
  assert.equal((await runLifecycleOnboarding(f.deps(script(replies).ask))).kind, "cancelled");
  assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, writes);
 }
 const enabled = structuredClone(legacy); enabled.continuity = { entry: "auto", review: "auto", fix: "ask", land: "manual", ship: "manual" };
 f.kb.perillas("app", renderLifecycleBlock(enabled));
 const unchanged = await runLifecycleOnboarding(f.deps(script([["Este repo no necesita Ship"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]).ask));
 assert.ok(unchanged.kind === "saved"); assert.equal(unchanged.pin.blockHash, lifecycleHash(enabled));
 const off = script([["Este repo no necesita Ship"], ["Detener en draft (legacy)"], ["Guardar y aceptar"]]);
 const disabled = await runLifecycleOnboarding(f.deps(off.ask)); assert.ok(disabled.kind === "saved"); assert.equal(disabled.pin.blockHash, lifecycleHash(legacy));
 assert.match(off.seen.at(-1)!.questions[0]!.detail ?? "", /no revierte efectos/);
});

test("KB caída o sin acceso no es ausencia: no pregunta, no posterga ni sobrescribe", async t => {
 for (const broken of ["down", "no-access"] as const) {
  const f = await fixture(t); if (broken === "down") f.kb.available = "KB caída"; else f.kb.access = [];
  const status = await f.status(); assert.equal(status.status, "unavailable"); assert.equal(status.revision, null); assert.equal(shouldOfferLifecycleOnboarding("harness", status, { kind: "missing" }), false);
  const wizard = script([["Más adelante"]]); const outcome = await runLifecycleOnboarding(f.deps(wizard.ask));
  assert.equal(outcome.kind, "unavailable"); assert.equal(wizard.seen.length, 0); assert.deepEqual(await readLifecycleTrust(f.trustDir, key), { kind: "missing" }); assert.ok(!f.kb.calls.some(c => c.tool === "guardar"));
 }
 const f = await fixture(t); f.kb.perillas("app", "```omi-development-lifecycle\n{\"repo\":\"acme/app\",\"version\":9}\n```\n");
 assert.equal((await f.status()).status, "invalid"); const wizard = script([["Configurar ahora"]]); assert.equal((await runLifecycleOnboarding(f.deps(wizard.ask))).kind, "invalid"); assert.equal(wizard.seen.length, 0, "inválido requiere revisión humana, no se pisa");
});

const REVIEW = "GitHub Actions · claude-review.yml (omi-review-v1)";
const reviewRepo = (t: TestContext) => fixture(t, { ".github/workflows/claude-review.yml": REVIEW_WORKFLOW });
const legacyBlock = (change: (block: LifecycleConfig) => void = () => {}) => { const block = defaultLifecycleConfig(key.repo, "main"); block.ship = { status: "not-applicable", targets: [] }; change(block); return block; };

test("detector reconoce omi-review-v1 sólo con todos los marcadores del runtime, también en el claude-review.yml real", async t => {
 const f = await reviewRepo(t);
 assert.deepEqual(f.detection.workflows.find(w => w.file === "claude-review.yml"), { file: "claude-review.yml", dispatch: true, release: false, contract: "omi-review-v1" });
 const partial: [string, string][] = [
  ["sin-run-name.yml", REVIEW_WORKFLOW.replace(/^run-name:.*\n/m, "")],
  ["sin-head.yml", REVIEW_WORKFLOW.replace(/      expected_head_sha:\n        required: false\n/, "")],
  ["sin-correlacion.yml", REVIEW_WORKFLOW.replace(/      correlation_id:\n        required: false\n/, "")],
  ["sin-attempt.yml", REVIEW_WORKFLOW.replace("-${{ github.run_attempt }}", "")],
  ["sin-recibo.yml", REVIEW_WORKFLOW.replace("review.json", "salida.json")],
  ["sin-dispatch.yml", REVIEW_WORKFLOW.replace("workflow_dispatch", "pull_request")],
 ];
 for (const [file, text] of partial) assert.notEqual(text, REVIEW_WORKFLOW, file);
 const g = await fixture(t, Object.fromEntries(partial.map(([file, text]) => [`.github/workflows/${file}`, text])));
 for (const [file] of partial) assert.equal(g.detection.workflows.find(w => w.file === file)?.contract, null, file);
 const own = await detectLifecycle(fileURLToPath(new URL("..", import.meta.url)), signal());
 assert.equal(own.workflows.find(w => w.file === "claude-review.yml")?.contract, "omi-review-v1");
 assert.deepEqual(own.workflows.filter(w => w.contract !== null).map(w => w.file), ["claude-review.yml"], "release, CI y bump no son review");
});

test("Review: con omi-review-v1 detectado y sin config recomienda GHA y guarda la identidad del esquema; Ship no lo ofrece", async t => {
 const f = await reviewRepo(t);
 const run = script([["Configurar ahora"], ["Manual (sin destino verificable)"], ["Recibo del proveedor"], ["Detener (stop)"], ["Preguntar antes (ask)"], [REVIEW], ["Default del workflow"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]);
 const outcome = await runLifecycleOnboarding(f.deps(run.ask)); assert.ok(outcome.kind === "saved");
 const mechanisms = run.seen[1]!.questions.find(q => q.id === "mechanism")!.options.map(o => o.label);
 assert.ok(mechanisms.includes("GitHub Actions · release.yml")); assert.ok(!mechanisms.some(m => m.includes("claude-review.yml")), "un workflow de review no es destino de Ship");
 const review = run.seen[2]!.questions[0]!; assert.equal(run.seen[2]!.title, "Review del PR");
 assert.deepEqual(review.options.map(o => o.label), [REVIEW, "Revisor local"]); assert.equal(review.recommended, true, "GHA detectado va primero y recomendado");
 const model = run.seen[3]!.questions[0]!; assert.deepEqual(model.options.map(o => o.label), ["Default del workflow", "Sonnet (claude-sonnet-5-5)"]); assert.equal(model.recommended, true);
 assert.deepEqual(outcome.pin.block.review.provider, { kind: "gha", workflow: "claude-review.yml", ref: "main", contract: "omi-review-v1" });
 assert.equal(outcome.pin.block.review.mode, "ask", "elegir el proveedor no cambia el permiso del efecto");
 const detail = run.seen.at(-1)!.questions[0]!.detail ?? "";
 assert.match(detail, /review\.provider\.kind: local → gha/); assert.match(detail, /review\.provider\.workflow: claude-review\.yml/); assert.match(detail, /Review: GitHub Actions · claude-review\.yml@main · modelo: default del workflow/);
 const writes = f.kb.calls.filter(c => c.tool === "guardar").length;
 for (const replies of [[["Este repo no necesita Ship"], "esc"], [["Este repo no necesita Ship"], [REVIEW], "esc"]] as (string[] | "esc")[][]) assert.equal((await runLifecycleOnboarding(f.deps(script(replies).ask))).kind, "cancelled", "Esc en Review o en el modelo cancela");
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, writes, "cancelar no guarda");
});

test("Review: elegir Sonnet fija model en el provider, lo muestra en el resumen y mantener conserva el hash", async t => {
 const f = await reviewRepo(t), legacy = legacyBlock(); f.kb.perillas("app", renderLifecycleBlock(legacy));
 const sonnet = script([["Mantener Ship actual"], [REVIEW], ["Sonnet (claude-sonnet-5-5)"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]);
 const saved = await runLifecycleOnboarding(f.deps(sonnet.ask)); assert.ok(saved.kind === "saved");
 assert.deepEqual(saved.pin.block.review.provider, { kind: "gha", workflow: "claude-review.yml", ref: "main", contract: "omi-review-v1", model: "claude-sonnet-5-5" });
 assert.deepEqual(sonnet.seen[1]!.questions[0]!.options.map(o => o.label), [REVIEW, "Mantener revisor local"], "con revisor local, GHA recomendado y mantener como alternativa");
 const detail = sonnet.seen.at(-1)!.questions[0]!.detail ?? ""; assert.match(detail, /review\.provider\.model: claude-sonnet-5-5/); assert.match(detail, /modelo: claude-sonnet-5-5/);
 const keep = script([["Mantener Ship actual"], ["Mantener GitHub Actions · claude-review.yml"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]);
 const kept = await runLifecycleOnboarding(f.deps(keep.ask)); assert.ok(kept.kind === "saved"); assert.equal(kept.pin.blockHash, saved.pin.blockHash);
 const options = keep.seen[1]!.questions[0]!.options.map(o => o.label); assert.deepEqual(options, ["Mantener GitHub Actions · claude-review.yml", REVIEW, "Revisor local"], "con GHA actual, mantener es la recomendada");
 const back = await runLifecycleOnboarding(f.deps(script([["Mantener Ship actual"], ["Revisor local"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]).ask));
 assert.ok(back.kind === "saved"); assert.deepEqual(back.pin.block.review.provider, { kind: "local" }); assert.equal(back.pin.blockHash, lifecycleHash(legacy));
 f.kb.perillas("app", renderLifecycleBlock(legacyBlock(b => { b.review.provider = { kind: "gha", workflow: "claude-review.yml", ref: "main", contract: "omi-review-v1", model: "claude-sonnet-5-5", effort: "high" }; })));
 const reset = await runLifecycleOnboarding(f.deps(script([["Mantener Ship actual"], [REVIEW], ["Default del workflow"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]).ask));
 assert.ok(reset.kind === "saved"); assert.deepEqual(reset.pin.block.review.provider, { kind: "gha", workflow: "claude-review.yml", ref: "main", contract: "omi-review-v1", effort: "high" }, "el default quita model y conserva el effort que el wizard no pregunta");
});

test("Mantener Ship actual conserva destinos personalizados sin reingresarlos; sin GHA detectado no pregunta Review", async t => {
 const f = await fixture(t), target = defaultLifecycleTarget({ id: "gha-deploy", mode: "auto", timeoutSeconds: 900, maxRetries: 2, onFailure: { action: "rollback", mode: "ask" }, provider: { kind: "gha", workflow: "deploy.yml", ref: "main", mode: "observe", contract: "omi-ship-v1", rollback: { workflow: "rollback.yml", ref: "main", contract: "omi-ship-v1" } }, evidence: { kind: "receipt", health: { path: "/health", status: 200 } } });
 assert.ok("target" in target);
 const block = legacyBlock(b => { b.ship = { status: "configured", targets: [target.target] }; b.continuity = { entry: "ask", review: "ask", fix: "ask", land: "manual", ship: "manual" }; }); f.kb.perillas("app", renderLifecycleBlock(block));
 const run = script([["Mantener Ship actual"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]);
 const outcome = await runLifecycleOnboarding(f.deps(run.ask)); assert.ok(outcome.kind === "saved");
 assert.deepEqual(run.seen[0]!.questions[0]!.options.map(o => o.label), ["Mantener Ship actual", "Configurar ahora", "Más adelante", "Este repo no necesita Ship"]);
 assert.match(run.seen[0]!.questions[0]!.options[0]!.description, /gha-deploy/);
 assert.deepEqual(run.seen.map(b => b.title), ["Ship de acme/app", "Continuidad del lifecycle", "Resumen antes de guardar"], "sin alternativa de Review no hay pregunta");
 assert.deepEqual(outcome.pin.block.ship, block.ship); assert.equal(outcome.pin.blockHash, lifecycleHash(block));
});

test("legacy aceptada se ofrece por recomendaciones; Más adelante posterga esa revisión y guardar sin tomarlas no insiste", async t => {
 const f = await reviewRepo(t), legacy = legacyBlock();
 await acceptLifecycleConfig(f.kb, f.home, f.root, legacy);
 const accepted = await f.status(), local = await readLifecycleTrust(f.trustDir, key);
 assert.equal(accepted.status, "not-applicable"); assert.equal(accepted.revision, `lifecycle:${lifecycleHash(legacy)}`);
 assert.deepEqual(accepted.recommendations.map(r => r.kind), ["continuity", "review-gha"]);
 assert.equal(accepted.recommendations[0]!.message, "Continuidad sin configurar: el trabajo para en el PR draft");
 assert.match(accepted.recommendations[1]!.message, /claude-review\.yml.*omi-review-v1/);
 assert.equal(shouldOfferLifecycleOnboarding("harness", accepted, local), true);
 assert.equal(shouldOfferLifecycleOnboarding("simple", accepted, local), false); assert.equal(shouldOfferLifecycleOnboarding("needs-info", accepted, local), false);
 const keep = script([["Mantener Ship actual"], ["Mantener revisor local"], ["Mantener continuidad actual"], ["Guardar y aceptar"]]);
 const kept = await runLifecycleOnboarding(f.deps(keep.ask)); assert.ok(kept.kind === "saved"); assert.equal(kept.pin.blockHash, lifecycleHash(legacy));
 assert.match(keep.seen[0]!.questions[0]!.detail ?? "", /Continuidad sin configurar/);
 assert.match(keep.seen.at(-1)!.questions[0]!.detail ?? "", /Recomendaciones sin tomar[\s\S]*posterga/);
 const after = await readLifecycleTrust(f.trustDir, key); assert.ok(after.kind === "valid"); assert.equal(after.record.deferred?.revision, accepted.revision);
 assert.equal(shouldOfferLifecycleOnboarding("harness", await f.status(), after), false, "guardar sin tomarlas posterga esa revisión");
 const full = await runLifecycleOnboarding(f.deps(script([["Mantener Ship actual"], [REVIEW], ["Default del workflow"], ["Configurar continuidad"], ["Preguntar antes (ask)"], ["Preguntar antes (ask)"], ["Preguntar antes (ask)"], ["Manual (comando explícito)"], ["Manual (comando explícito)"], ["Guardar y aceptar"]]).ask));
 assert.ok(full.kind === "saved"); const done = await f.status();
 assert.deepEqual(done.recommendations, []); assert.equal(shouldOfferLifecycleOnboarding("harness", done, await readLifecycleTrust(f.trustDir, key)), false, "sin recomendaciones no se ofrece");
 const g = await reviewRepo(t); await acceptLifecycleConfig(g.kb, g.home, g.root, legacy);
 const revision = (await g.status()).revision, later = script([["Más adelante"]]); assert.equal((await runLifecycleOnboarding(g.deps(later.ask))).kind, "deferred");
 const deferred = await readLifecycleTrust(g.trustDir, key); assert.ok(deferred.kind === "valid"); assert.equal(deferred.record.deferred?.revision, revision);
 assert.equal(deferred.record.accepted?.blockHash, lifecycleHash(legacy), "postergar no toca la aceptación");
 assert.equal(shouldOfferLifecycleOnboarding("harness", await g.status(), deferred), false, "no insiste con la misma revisión");
});

test("recomendaciones: sin GHA detectado sólo continuidad; con continuidad y GHA ya elegido, ninguna; KB caída, ninguna", async t => {
 const f = await fixture(t); assert.deepEqual((await f.status()).recommendations.map(r => r.kind), ["continuity"], "sin configurar también avisa que para en draft");
 await acceptLifecycleConfig(f.kb, f.home, f.root, legacyBlock(b => { b.continuity = { entry: "ask", review: "ask", fix: "ask", land: "manual", ship: "manual" }; }));
 const configured = await f.status(); assert.deepEqual(configured.recommendations, []); assert.equal(shouldOfferLifecycleOnboarding("harness", configured, await readLifecycleTrust(f.trustDir, key)), false);
 const g = await reviewRepo(t); await acceptLifecycleConfig(g.kb, g.home, g.root, legacyBlock(b => { b.review.provider = { kind: "github", reviewers: ["ada"] }; b.continuity = { entry: "ask", review: "ask", fix: "ask", land: "manual", ship: "manual" }; }));
 assert.deepEqual((await g.status()).recommendations, [], "GitHub explícito no se reemplaza por recomendación");
 const down = await reviewRepo(t); down.kb.available = "KB caída"; assert.deepEqual((await down.status()).recommendations, []);
});
