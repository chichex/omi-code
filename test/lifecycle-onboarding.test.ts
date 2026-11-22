import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { memoryKb } from "./helpers/mock-kb.ts";
import { batchProblem, type AskResult, type QuestionBatch } from "../src/tui/questions/batch.ts";
import { detectLifecycle } from "../src/harness/lifecycle-detect.ts";
import { lifecycleOnboardingStatus, runLifecycleOnboarding, shouldOfferLifecycleOnboarding } from "../src/harness/lifecycle-onboarding.ts";
import { readLifecycle } from "../src/harness/lifecycle-kb.ts";
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
async function fixture(t: TestContext) {
 const root = await repo(t), home = await realpath(await mkdtemp(join(tmpdir(), "omi-onboarding-home-"))); t.after(() => rm(home, { recursive: true, force: true }));
 const kb = memoryKb({ products: ["app"] }), trustDir = lifecycleTrustDir(home), detection = await detectLifecycle(root, signal());
 const deps = (ask: (batch: QuestionBatch) => Promise<AskResult>) => ({ kb, key, cwd: root, base: "main", trustDir, detection, ask, now, signal: signal() });
 const status = async () => lifecycleOnboardingStatus(await readLifecycle(kb, key, root, signal()), await readLifecycleTrust(trustDir, key));
 return { root, home, kb, trustDir, detection, deps, status };
}

test("detector sólo lee workflows/scripts/manifiestos/vínculo, sin ejecutar ni seguir symlinks ni copiar valores", async t => {
 const root = await repo(t), before = await snapshot(root);
 const found = await detectLifecycle(root, signal());
 assert.deepEqual(found.workflows, [{ file: "ci.yaml", dispatch: false, release: false }, { file: "release.yml", dispatch: true, release: true }]);
 assert.deepEqual(found.scripts, ["deploy", "test"]); assert.deepEqual(found.manifests, ["Dockerfile", "package.json"]);
 assert.deepEqual(found.omi, { organization: "acme", project: "tienda", services: ["api"] });
 assert.deepEqual(found.skipped.sort(), [".github/workflows/huge.yml", ".github/workflows/linked.yml"]);
 assert.doesNotMatch(JSON.stringify(found), /SECRET|curl|node --test/, "valores de scripts no entran al contexto");
 assert.deepEqual(await snapshot(root), before, "detectar no escribe ni toca el repo");
 const empty = await realpath(await mkdtemp(join(tmpdir(), "omi-onboarding-empty-"))); t.after(() => rm(empty, { recursive: true, force: true }));
 assert.deepEqual(await detectLifecycle(empty, signal()), { workflows: [], scripts: [], manifests: [], omi: null, skipped: [] });
});

test("oferta contextual: sólo al entrar al harness sin configuración; consultas simples/needs-info no preguntan", async t => {
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
 const f = await fixture(t), declined = script([["Este repo no necesita Ship"], ["No guardar"]]);
 assert.deepEqual(await runLifecycleOnboarding(f.deps(declined.ask)), { kind: "declined" }); assert.ok(!f.kb.calls.some(c => c.tool === "guardar")); assert.equal((await f.status()).status, "unconfigured");
 const summary = declined.seen[1]!.questions[0]!; assert.match(summary.detail ?? "", /ship\.status: unconfigured → not-applicable/); assert.equal(summary.recommended, false, "aceptar nunca es la opción por defecto");
 const accepted = script([["Este repo no necesita Ship"], ["Guardar y aceptar"]]); const outcome = await runLifecycleOnboarding(f.deps(accepted.ask));
 assert.ok(outcome.kind === "saved"); assert.equal(outcome.pin.block.ship.status, "not-applicable"); assert.equal((await f.status()).status, "not-applicable");
});

test("configurar desde lo detectado guarda KB y acepta tras el resumen, sin ejecutar workflow ni deploy", async t => {
 const f = await fixture(t);
 const answers: (string[] | { text: string })[] = [["Configurar ahora"], ["OMI · api · stage"], { text: "/health" }, ["Detener (stop)"], ["Preguntar antes (ask)"], ["Guardar y aceptar"]];
 const run = script(answers); const outcome = await runLifecycleOnboarding(f.deps(run.ask)); assert.ok(outcome.kind === "saved");
 const mechanisms = run.seen[1]!.questions.find(q => q.id === "mechanism")!.options.map(o => o.label); assert.ok(mechanisms.includes("GitHub Actions · release.yml")); assert.ok(mechanisms.includes("OMI · api · stage")); assert.ok(mechanisms.includes("Manual (sin destino verificable)"));
 assert.deepEqual(outcome.pin.block.ship, { status: "configured", targets: [{ id: "omi-api-stage", mode: "ask", timeoutSeconds: 1800, maxRetries: 0, onFailure: { action: "stop", mode: "ask" }, provider: { kind: "omi", service: "api", environment: "stage", mode: "observe" }, evidence: { kind: "omi", health: { path: "/health", status: 200 } } }] });
 assert.equal((await f.status()).status, "configured"); assert.deepEqual(new Set(f.kb.calls.map(c => c.tool)), new Set(["mis_productos", "buscar", "leer", "guardar"])); assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
 assert.match(run.seen.at(-1)!.questions[0]!.detail ?? "", /no ejecuta review, merge, workflows ni deploy/);
 const gha = await fixture(t), ship = script([["Configurar ahora"], ["GitHub Actions · release.yml"], ["Recibo del proveedor"], ["Detener (stop)"], ["Automático (auto)"], ["Guardar y aceptar"]]); const saved = await runLifecycleOnboarding(gha.deps(ship.ask)); assert.ok(saved.kind === "saved");
 assert.deepEqual(saved.pin.block.ship.targets[0]?.provider, { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "omi-ship-v1" }); assert.equal(saved.pin.block.ship.targets[0]?.mode, "auto");
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
