import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { OmiClient } from "../src/client/http.ts";
import { omiShipContext, omiRequest } from "../src/harness/omi-ship-context.ts";
import { execFileSync } from "node:child_process";
import { publicationCheckout } from "../src/harness/publication-checkout.ts";
import { PublicationFactSchema } from "../src/harness/omi-ship-schema.ts";
import { join } from "node:path";
import { tempDir } from "./helpers/io.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { sourceHash, parseWorkflow } from "../src/harness/model.ts";
import { recordShipVerification, completeShip } from "../src/harness/ship-state.ts";
import { readWorkflow, updateWorkflow } from "../src/harness/store.ts";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash } from "../src/harness/lifecycle-config.ts";
import * as life from "../src/harness/lifecycle-state.ts";
import { acceptObservedMerge } from "../src/harness/lifecycle-land.ts";
import { verifyOmiShip, publishOmiVersion, deployOmiVersion, recordOmiPublication } from "../src/harness/lifecycle-omi-ship.ts";
import { linkedProject, humanless, allowAll, type Linked } from "./helpers/project.ts";
import { fakeRunner } from "./helpers/runner.ts";
import { processRunner, type Runner } from "../src/core/exec.ts";
const at = "2026-01-01T00:00:00Z", repo = "acme/tienda", base = "a".repeat(40), head = "b".repeat(40), mergedSha = "c".repeat(40), nonce = "12345678-1234-4234-8234-123456789abc";
function shipping(kind: "ship" | "deploy" | "publish" | "promote" = "ship", environment: "stage" | "prod" = "stage", mode: "observe" | "direct" | "tag" = kind === "ship" ? "observe" : "direct", commitField: string | null = "commit", repository = "acme/tienda") {
 const repo = repository;
 const target = defaultLifecycleTarget({ id: "api", mode: "auto", timeoutSeconds: 60, provider: { kind: "omi", service: "api", environment, mode }, evidence: { kind: "omi", health: { path: "/health", status: 200 }, version: { path: "/version", versionField: "version", ...(commitField ? { commitField } : {}) } } }); assert.ok("target" in target);
 const block = defaultLifecycleConfig(repo, "main"); block.ship = { status: "configured", targets: [target.target] };
 const pin = { key: { kbUrl: "https://kb.example.test/mcp", product: "tienda", repo }, accepted: { block, blockHash: lifecycleHash(block), docId: "pin", author: "Ada", date: at, acceptedAt: at } };
 let lifecycle = life.initializeLifecycle({ workflowId: "root", issue: 42, repo }, pin);
 lifecycle = life.bindLifecycleSubject(lifecycle, { id: "subject", repo, number: 42, branch: "feat/work", base: "main", headSha: head, baseSha: base, contentHash: "e".repeat(64), mergedSha: null }, { id: "adopt", source: "person", at });
 let r = createWorkflow({ number: 42, title: "Change", body: "Scope", url: `https://github.com/${repo}/issues/42`, hash: sourceHash("Change", "Scope") }, { root: "/fixture", commonDir: "/fixture/.git", branch: "feat/work", baseCommit: base }, "root", at);
 r.lifecycle = lifecycle; r.publication = { status: "opened", head, url: `https://github.com/${repo}/pull/42`, number: 42 }; r.pullRequest = { number: 42, url: r.publication.url, head, branch: "feat/work", base: "main", ownership: "adopted" };
 r = acceptObservedMerge(r, { number: 42, state: "closed", draft: false, merged: true, merge_commit_sha: mergedSha, head: { sha: head, ref: "feat/work", repo: { full_name: repo } }, base: { sha: base, ref: "main", repo: { full_name: repo } } }, { source: "external", at }); assert.ok(r.lifecycle.status === "enabled"); const subjectId = r.lifecycle.currentSubject; assert.ok(subjectId);
 r.lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "omi1", key: "omi1", kind, subjectId, targetId: "api", correlationId: nonce, retryOf: null }, { id: "omi-decision", kind, subjectId, targetId: "api", configHash: r.lifecycle.pinHash, source: "person", at }, "process", at); return r;
}
const deployment = (environment = "stage", status = "exitoso") => ({ id: "dep_fixture", service: "api", environment, from_version: "1.0.0", to_version: "1.1.0", status, steps: [], target_instances: 1, created_at: at });
function prepare(linked: Linked, environment = "stage") {
 const service = linked.project.services.get("api")?.view; assert.ok(service); service.versions = [{ tag: "1.1.0", prerelease: false }]; const env = service.environments.find(e => e.name === environment); assert.ok(env);
 env.current_version = "1.1.0"; env.state = "activo"; env.hostname = "api.omi.test"; env.last_deployment = deployment(environment);
 return { service, environment: env };
}
function ports(linked: Linked, response: unknown = { version: "1.1.0", commit: mergedSha }) {
 const requests: { url: string; headers: unknown }[] = [];
 const fetcher: typeof fetch = async (url, options) => { requests.push({ url: String(url), headers: options?.headers }); return new Response(String(url).endsWith("/health") ? "ok" : JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } }); };
 return { runtime: linked.runtime(), version: "1.1.0", signal: AbortSignal.timeout(5000), timeoutSeconds: 60, now: () => 0, fetch: fetcher, beforeMutation: async () => {}, recordRequest: async (_value: unknown) => {}, recordQueued: async (_value: unknown) => {}, recordDeployment: async (_value: unknown) => {}, requests };
}

test("observe OMI verifica current/deployment y health/version.commit sin enviar Bearer al destino", async t => {
 const linked = await linkedProject(t); prepare(linked); const p = ports(linked); p.runtime = linked.runtime({ guard: humanless() });
 const result = await verifyOmiShip(shipping(), "omi1", p); assert.equal(result.state, "verified"); assert.ok(result.proof); assert.equal(result.proof.kind, "omi"); assert.match(JSON.stringify(result.proof), /endpoint/); assert.equal(linked.mutations().length, 0);
 assert.deepEqual(p.requests.map(r => new URL(r.url).pathname), ["/health", "/version"]); assert.ok(p.requests.every(r => r.headers === undefined || !JSON.stringify(r.headers).toLowerCase().includes("authorization")));
});
for (const problem of ["wrong-commit", "missing-commit", "wrong-version", "deployment-failed", "wrong-service"]) test(`${problem}: semver/deployment solos no prueban entrega del commit`, async t => {
 const linked = await linkedProject(t), view = prepare(linked); const p = ports(linked, problem === "wrong-commit" ? { version: "1.1.0", commit: head } : problem === "missing-commit" ? { version: "1.1.0" } : problem === "wrong-version" ? { version: "1.0.0", commit: mergedSha } : undefined);
 if (problem === "deployment-failed") view.environment.last_deployment = deployment("stage", "fallido");
 if (problem === "wrong-service") view.service.name = "foreign";
 const result = await verifyOmiShip(shipping(), "omi1", p); assert.notEqual(result.state, "verified"); assert.equal(linked.mutations().length, 0);
});

test("health no pasa por run/API exitosos, redirección y paths inexistentes quedan sin aprobar", async t => {
 const linked = await linkedProject(t); prepare(linked);
 for (const status of [302, 404, 500]) { const p = ports(linked); p.fetch = async () => new Response("not healthy", { status }); assert.notEqual((await verifyOmiShip(shipping(), "omi1", p)).state, "verified"); }
});

test("deploy stage usa guard existente y una idempotencyKey durable antes de API; auto no eleva permisos", async t => {
 const linked = await linkedProject(t); prepare(linked); const p = ports(linked); p.runtime = linked.runtime({ guard: humanless(true) }); let claimed = false;
 p.recordRequest = async () => { claimed = true; }; const result = await deployOmiVersion(shipping("deploy"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } });
 assert.equal(result.state, "confirmed"); assert.equal(claimed, true); const request = linked.omi.requests.find(r => r.method === "POST" && r.path.endsWith("/deployments")); assert.ok(request); assert.equal(request.idempotencyKey, nonce); assert.deepEqual(request.body, { version: "1.1.0" });
});
for (const action of ["deploy", "promote"] as const) test(`${action} prod siempre confirma persona; no UI/declinar no mutan`, async t => {
 const linked = await linkedProject(t), env = prepare(linked, "prod"); env.environment.promotion = { version: "1.1.0" };
 for (const guard of [humanless(true), { ...allowAll(), ask: async () => false }]) {
  const p = ports(linked); p.runtime = linked.runtime({ guard }); await assert.rejects(deployOmiVersion(shipping(action, "prod"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } })); assert.equal(linked.mutations().length, 0);
 }
});

test("deploy prod permitido conserva confirms propios, no receta/omi_ask ni modo auto como permiso", async t => {
 const linked = await linkedProject(t); prepare(linked, "prod"); let asks = 0;
 const p = ports(linked); p.runtime = linked.runtime({ guard: { ...allowAll(), ask: async () => { asks++; return true; } } });
 assert.equal((await deployOmiVersion(shipping("deploy", "prod"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } })).state, "confirmed"); assert.equal(asks, 1);
});

test("promoción que cambió mientras confirma la persona invalida la decisión sin POST", async t => {
 const linked = await linkedProject(t), view = prepare(linked, "prod"); view.environment.promotion = { version: "1.1.0" }; const p = ports(linked);
 p.runtime = linked.runtime({ guard: { ...allowAll(), ask: async () => { view.environment.promotion = { version: "1.2.0", blocked_reason: "changed" }; return true; } } });
 await assert.rejects(deployOmiVersion(shipping("promote", "prod"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } })); assert.equal(linked.mutations().length, 0);
});

test("respuesta perdida/queued ID se conservan y no se repite una mutación OMI", async t => {
 const linked = await linkedProject(t); prepare(linked); linked.omi.queueNext(1); let observedQueue = "";
 const p = ports(linked); p.recordQueued = async value => { assert.ok(value && typeof value === "object" && "mutationId" in value && typeof value.mutationId === "string"); observedQueue = value.mutationId; };
 const result = await deployOmiVersion(shipping("deploy"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } }); assert.equal(result.state, "confirmed"); assert.ok(observedQueue); assert.equal(linked.omi.requests.filter(r => r.method === "POST" && r.path.endsWith("/deployments")).length, 1);
});

test("deployment inicial se conserva antes del polling y una identidad ajena no se confirma", async t => {
 const linked = await linkedProject(t); prepare(linked); let observed = "";
 const p = ports(linked); const result = await deployOmiVersion(shipping("deploy"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha }, recordDeployment: async started => { observed = started.id; } }); assert.equal(result.state, "confirmed"); assert.ok(observed);
 linked.omi.route("POST /api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}/environments/{environmentName}/deployments", () => ({ status: 200, body: { ...deployment(), service: "foreign", to_version: "1.2.0" } }));
 assert.notEqual((await deployOmiVersion(shipping("deploy"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } })).state, "confirmed");
});

test("redirect 307 de stage a prod no reenvía POST ni Bearer sin guardrail prod", async t => {
 const linked = await linkedProject(t); prepare(linked); const prefix = "/api/v1/organizations/org_acme/projects/tienda/services/api/environments";
 linked.omi.route("POST /api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}/environments/{environmentName}/deployments", (_request, params) => params.environmentName === "stage" ? { status: 307, headers: { Location: `${prefix}/prod/deployments` } } : { status: 200, body: deployment("prod") });
 const p = ports(linked); p.runtime = linked.runtime({ guard: humanless(true) });
 assert.notEqual((await deployOmiVersion(shipping("deploy"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } })).state, "confirmed"); assert.ok(!linked.omi.requests.some(r => r.method === "POST" && r.path.endsWith("/prod/deployments")));
});

for (const status of [200, 500]) test(`omi-api ${status} corta bodies por bytes antes de JSON/esquema, incluidos errores`, async () => {
 let cancelled = false, pulls = 0;
 const client = new OmiClient({ apiUrl: "https://api.omi.test", token: "fixture-only", maxResponseBytes: 1024, fetch: async () => new Response(new ReadableStream({ pull(controller) { if (pulls++ > 0) controller.close(); else controller.enqueue(new TextEncoder().encode(JSON.stringify({ fixture: "x".repeat(20000) }))); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status }) });
 await assert.rejects(client.request("GET", "/me", Type.Unknown()), /salida|tamaño|bytes|límite/i); assert.equal(cancelled, true);
});

test("Runner espera terminación y escala SIGTERM de un hijo silencioso que lo ignora", async t => {
 const directory = await tempDir(t), file = join(directory, "ready"), controller = new AbortController(); let pid = 0;
 const running = processRunner.run(process.execPath, ["-e", `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},20)`], { signal: controller.signal }).then(() => null, error => error as unknown);
 try {
  for (let i = 0; i < 100 && !pid; i++) { pid = await readFile(file, "utf8").then(Number, () => 0); if (!pid) await new Promise(resolve => setTimeout(resolve, 20)); } assert.ok(pid); controller.abort(); assert.ok(await running); assert.throws(() => process.kill(pid, 0));
 } finally { if (pid) try { process.kill(pid, "SIGKILL"); } catch {} }
});

// Muerto = no existe o quedó zombie: en Linux init recoge al huérfano un instante después del close,
// y mientras tanto kill(pid, 0) todavía lo encuentra. Un proceso que sigue corriendo nunca pasa.
async function exited(pid: number, ms = 1000): Promise<boolean> {
 for (const end = Date.now() + ms; ;) {
  try { process.kill(pid, 0); } catch { return true; }
  const stat = process.platform === "linux" ? await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "") : "";
  if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return true;
  if (Date.now() >= end) return false;
  await new Promise(resolve => setTimeout(resolve, 10));
 }
}

test("cancelación corta grupo de helpers aunque padre salga y descendiente conserve stdout", async t => {
 const directory = await tempDir(t), file = join(directory, "helper-pid"), controller = new AbortController(); let helper = 0;
 const child = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},20)`;
 const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},20)`;
 const pending = processRunner.run(process.execPath, ["-e", parent], { signal: controller.signal }).then(() => null, error => error as unknown);
 try {
  for (let i = 0; i < 100 && !helper; i++) { helper = await readFile(file, "utf8").then(Number, () => 0); if (!helper) await new Promise(resolve => setTimeout(resolve, 20)); } assert.ok(helper); controller.abort();
  const result = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("descendiente sobrevivió al deadline")), 1200))]); assert.ok(result); assert.ok(await exited(helper), "el descendiente sigue corriendo");
 } finally { if (helper) try { process.kill(helper, "SIGKILL"); } catch {} }
});

test("OMI durable permite entrega demostrada, pero origen atestiguado nunca equivale a delivered", async t => {
 const linked = await linkedProject(t); prepare(linked);
 const original = shipping(), result = await verifyOmiShip(original, "omi1", ports(linked)); const recorded = recordShipVerification(original, "omi1", result, at); assert.equal(completeShip(recorded, at).phase, "delivered");
 const forged = structuredClone(recorded); assert.ok(forged.lifecycle.status === "enabled"); const proof = forged.lifecycle.deliveries?.[0]?.result.proof; assert.ok(proof?.kind === "omi" && proof.origin.kind === "endpoint"); proof.origin.commitSha = head; assert.throws(() => parseWorkflow(JSON.stringify(forged)));
 const external = shipping("ship", "stage", "observe", null), p = ports(linked, { version: "1.1.0" });
 const attested = await verifyOmiShip(external, "omi1", { ...p, attestation: { source: "person", subjectId: `merged:42:${mergedSha}`, targetId: "api", integratedSha: mergedSha, version: "1.1.0", reason: "Vínculo humano fixture; sin origen demostrado", at } }); assert.equal(attested.state, "verified", attested.reason);
 const final = completeShip(recordShipVerification(external, "omi1", attested, at), at); assert.equal(final.phase, "ship"); assert.ok(final.lifecycle.status === "enabled"); assert.equal(final.lifecycle.completion?.outcome, "externally-attested");
});

test("recibo de otra imagen/registry o digest actual no acredita entrega por el mismo semver", async t => {
 const linked = await linkedProject(t); prepare(linked); let r = shipping("publish", "stage", "direct", null); const p = ports(linked, { version: "1.1.0" }); const c = await omiShipContext(r, "omi1", p); assert.ok(r.lifecycle.status === "enabled"); r.lifecycle.operations[0]!.shipRequest = omiRequest(c, "publish-direct", "1.1.0");
 const receipt = { id: "pub1", operationId: "omi1", subjectId: c.sub.id, targetId: "api", configHash: c.op.configHash, version: "1.1.0", commitSha: mergedSha, image: c.view.kit.image, digest: `sha256:${"d".repeat(64)}`, destination: c.destination, via: "direct", at };
 r = recordOmiPublication(r, "omi1", receipt, at); assert.ok(r.lifecycle.status === "enabled"); r.lifecycle = life.reserveLifecycleOperation(r.lifecycle, { id: "verify2", key: "verify2", kind: "ship", subjectId: c.sub.id, targetId: "api", correlationId: nonce + "2", retryOf: null }, { id: "verify2-decision", kind: "ship", subjectId: c.sub.id, targetId: "api", configHash: c.op.configHash, source: "person", at }, "process", at);
 const deps = { ...p, publication: { kind: "publication" as const, id: "pub1", version: "1.1.0", commitSha: mergedSha, image: receipt.image, digest: receipt.digest } };
 linked.project.services.get("api")!.view.kit = { ...c.view.kit, image: "other-registry.omi.test/acme/api" };
 assert.notEqual((await verifyOmiShip(r, "verify2", deps)).state, "verified");
 linked.project.services.get("api")!.view.kit = c.view.kit;
 deps.runtime = linked.runtime({ runner: fakeRunner((cmd, args) => cmd === "regctl" && args[1] === "digest" ? { stdout: `sha256:${"f".repeat(64)}` } : {}), readSecret: async () => "fixture-only" });
 assert.notEqual((await verifyOmiShip(r, "verify2", deps)).state, "verified");
 let secrets = 0, logins = 0; linked.project.services.get("api")!.view.kit = { ...c.view.kit, registry_hostname: "unrelated-registry.omi.test" };
 deps.runtime = linked.runtime({ runner: fakeRunner((cmd, args) => { if (cmd === "regctl" && args[1] === "login") logins++; return {}; }), readSecret: async () => { secrets++; return "fixture-only"; } });
 assert.notEqual((await verifyOmiShip(r, "verify2", deps)).state, "verified"); assert.equal(logins, 0); assert.equal(secrets, 0, "no leer credencial para un hostname que no corresponde a la imagen");
});

test("probes que no respetan AbortSignal no cuelgan el host ni acreditan entrega", async t => {
 const linked = await linkedProject(t); prepare(linked); const p = ports(linked); p.signal = AbortSignal.timeout(50); p.fetch = () => new Promise(() => {});
 const result = await Promise.race([verifyOmiShip(shipping(), "omi1", p), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe bloqueó host")), 300))]); assert.equal(result.state, "unknown");
});

test("claim CAS OMI y cola sobreviven reload; segundo caller/mismo request no reenvía", async t => {
 const linked = await linkedProject(t); prepare(linked); await mkdir(join(linked.repo, ".git")); const original = shipping("deploy"); original.checkout = { ...original.checkout, root: linked.repo, commonDir: join(linked.repo, ".git") }; original.revision = 0;
 await updateWorkflow(original.checkout, 42, undefined, () => original); linked.omi.queueNext(1);
 const p = ports(linked), { recordRequest: _claim, recordQueued: _queue, recordDeployment: _started, ...real } = p; const deps = { ...real, workflowStore: { checkout: original.checkout, issue: 42, operationId: "omi1" }, publication: { kind: "endpoint" as const, version: "1.1.0", commitSha: mergedSha } };
 const results = await Promise.allSettled([deployOmiVersion(original, "omi1", deps), deployOmiVersion(original, "omi1", deps)]); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
 const saved = await readWorkflow(original.checkout, 42); assert.ok(saved?.lifecycle.status === "enabled"); assert.equal(saved.lifecycle.operations[0]?.shipRequest?.kind, "omi"); assert.ok(saved.lifecycle.operations[0]?.queued?.[0]?.mutationId); assert.ok(saved.lifecycle.operations[0]?.deployments?.[0]?.id);
 await assert.rejects(deployOmiVersion(saved, "omi1", deps)); assert.equal(linked.omi.requests.filter(r => r.method === "POST" && r.path.endsWith("/deployments")).length, 1);
});

test("claim rechaza trabajo cuya fuente cambia después del gate y antes de emitir API", async t => {
 const linked = await linkedProject(t); prepare(linked); await mkdir(join(linked.repo, ".git")); const original = shipping("deploy"); original.checkout = { ...original.checkout, root: linked.repo, commonDir: join(linked.repo, ".git") }; original.revision = 0; await updateWorkflow(original.checkout, 42, undefined, () => original);
 const p = ports(linked), { recordRequest: _claim, recordQueued: _queue, recordDeployment: _started, ...real } = p;
 const deps = { ...real, workflowStore: { checkout: original.checkout, issue: 42, operationId: "omi1" }, publication: { kind: "endpoint" as const, version: "1.1.0", commitSha: mergedSha }, beforeMutation: async () => {
  const saved = await readWorkflow(original.checkout, 42); assert.ok(saved); await updateWorkflow(original.checkout, 42, saved.revision, state => { assert.ok(state); return { ...state, revision: state.revision + 1, source: { ...state.source, title: "Scope changed", hash: sourceHash("Scope changed", state.source.body) } }; });
 } };
 await assert.rejects(deployOmiVersion(original, "omi1", deps)); assert.equal(linked.mutations().length, 0);
});

test("stage sin autorización y publicación omi-code en ambos modos no producen efectos", async t => {
 const linked = await linkedProject(t); prepare(linked); const p = ports(linked); p.runtime = linked.runtime({ guard: humanless(false) });
 await assert.rejects(deployOmiVersion(shipping("deploy"), "omi1", { ...p, publication: { kind: "endpoint", version: "1.1.0", commitSha: mergedSha } })); assert.equal(linked.mutations().length, 0);
 for (const mode of ["direct", "tag"] as const) { let checkouts = 0; await assert.rejects(publishOmiVersion(shipping("publish", "stage", mode, "commit", "chichex/omi-code"), "omi1", { ...ports(linked), fixedCheckout: async () => { checkouts++; throw new Error("no snapshot expected"); } })); assert.equal(checkouts, 0); }
});

test("checkout real separado fija commit integrado sin mover HEAD/config/archivos originales ni ejecutar hooks", async t => {
 const root = await tempDir(t), env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" };
 const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env, encoding: "utf8" }).trim(); git("init", "-b", "work"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
 await writeFile(join(root, "app.txt"), "integrated fixture"); git("add", "."); git("commit", "-m", "feat: integrated"); const integrated = git("rev-parse", "HEAD"); await writeFile(join(root, "app.txt"), "worktree original"); git("commit", "-am", "fix: original"); const original = git("rev-parse", "HEAD"), config = await readFile(join(root, ".git/config"), "utf8");
 const state = shipping("publish"); state.checkout = { ...state.checkout, root, commonDir: join(root, ".git") };
 const snapshot = await publicationCheckout(state, integrated, { run: (cmd, args, options) => { assert.ok(!args.includes("fetch") && !args.includes("push"), "fixture Git nunca accede a red"); return processRunner.run(cmd, args, options); } }, AbortSignal.timeout(5000));
 try { assert.equal(snapshot.commitSha, integrated); assert.notEqual(snapshot.root, root); assert.equal(await readFile(join(snapshot.root, "app.txt"), "utf8"), "integrated fixture"); assert.equal(git("rev-parse", "HEAD"), original); assert.equal(await readFile(join(root, "app.txt"), "utf8"), "worktree original"); assert.equal(await readFile(join(root, ".git/config"), "utf8"), config); } finally { await snapshot.release(); }
});

test("Runner de publicación puede cortar stdout/stderr sin acumular ni aprobar salida parcial", async () => {
 await assert.rejects(processRunner.run(process.execPath, ["-e", "process.stdout.write('fixture'.repeat(20000))"], { maxOutputBytes: 1024, signal: AbortSignal.timeout(3000) }), /output|salida|límite/i);
});

for (const mode of ["direct", "tag"] as const) test(`publish ${mode} usa checkout separado del merge y labels remotos reales, no HEAD móvil`, async t => {
 const linked = await linkedProject(t), fixed = await tempDir(t); await writeFile(join(fixed, "Dockerfile"), "FROM scratch"); await mkdir(join(fixed, ".github/workflows"), { recursive: true }); await writeFile(join(fixed, ".github/workflows/omi-api.yml"), "# fixture only");
 const calls: { command: string; args: string[]; cwd: string | undefined }[] = []; let claimed = false;
 const runner: Runner = { run: async (command, args, options = {}) => {
  calls.push({ command, args, cwd: options.cwd });
  if (command === "docker" || command === "regctl" && args[0] === "image" && args[1] === "import") assert.equal(claimed, true);
  if (command === "docker" && args[0] === "build") { assert.ok(args.includes("--iidfile"), "build debe fijar identidad inmutable, no tag Docker compartido"); await writeFile(args[args.indexOf("--iidfile") + 1]!, `sha256:${"e".repeat(64)}`); }
  if (command === "docker" && args[0] === "save") assert.equal(args[1], `sha256:${"e".repeat(64)}`, "guardar la imagen construida por ID, nunca resolver otra vez el tag local");
  if (command === "git" && args.includes("--verify")) return { code: 1, stdout: "", stderr: "" };
  if (command === "git" && args[0] === "rev-parse") return { code: 0, stderr: "", stdout: options.cwd === fixed ? mergedSha : head };
  if (command === "git" && args[0] === "grep") return { code: 0, stderr: "", stdout: "app.ts\n" };
  if (command === "regctl" && args[1] === "digest") return { code: 0, stderr: "", stdout: `sha256:${"d".repeat(64)}\n` };
  if (command === "regctl" && args[1] === "config") return { code: 0, stderr: "", stdout: JSON.stringify({ config: { Labels: { "org.opencontainers.image.revision": mergedSha, "org.opencontainers.image.version": "1.1.0" } } }) };
  return { code: 0, stdout: "", stderr: "" };
 } };
 const p = ports(linked); p.runtime = linked.runtime({ runner, guard: humanless(true), readSecret: async () => "fixture-only" }); p.recordRequest = async () => { assert.equal(claimed, false); claimed = true; };
 const result = await publishOmiVersion(shipping("publish", "stage", mode), "omi1", { ...p, fixedCheckout: async commit => { assert.equal(commit, mergedSha); return { root: fixed, commitSha: mergedSha, release: async () => {} }; } });
 assert.equal(result.state, "published"); assert.ok(result.receipt); assert.equal(result.receipt.commitSha, mergedSha); assert.equal(result.receipt.digest, `sha256:${"d".repeat(64)}`); assert.ok(Value.Check(PublicationFactSchema, result.receipt), "recibo debe poder persistir bajo esquema cerrado");
 assert.ok(!calls.some(c => c.cwd === linked.repo && ["checkout", "switch", "reset", "tag"].includes(c.args[0] ?? "")));
 if (mode === "direct") { const build = calls.find(c => c.command === "docker" && c.args[0] === "build"); assert.equal(build?.cwd, fixed); assert.ok(build.args.includes(`org.opencontainers.image.revision=${mergedSha}`)); }
 else assert.ok(calls.some(c => c.command === "git" && c.args[0] === "tag" && c.args.includes(mergedSha)));
});

test("Dockerfile fuera del checkout por symlink se rechaza antes de secretos/build/publicación", async t => {
 const linked = await linkedProject(t), fixed = await tempDir(t), outside = await tempDir(t); await writeFile(join(outside, "Dockerfile"), "# fixture fuera del snapshot"); await symlink(join(outside, "Dockerfile"), join(fixed, "Dockerfile")); let secrets = 0, builds = 0;
 const runner = fakeRunner((cmd, args) => { if (cmd === "docker") builds++; return cmd === "git" && args[0] === "rev-parse" ? { stdout: mergedSha } : cmd === "git" && args[0] === "grep" ? { stdout: "app.ts" } : {}; });
 const p = ports(linked); p.runtime = linked.runtime({ runner, readSecret: async () => { secrets++; return "fixture-only"; } });
 const result = await publishOmiVersion(shipping("publish"), "omi1", { ...p, fixedCheckout: async () => ({ root: fixed, commitSha: mergedSha, release: async () => {} }) }); assert.equal(result.state, "unknown"); assert.equal(builds, 0); assert.equal(secrets, 0);
});

test("publicación no fabrica provenance si registry digest/OCI revision son errados", async t => {
 const linked = await linkedProject(t), fixed = await tempDir(t); await writeFile(join(fixed, "Dockerfile"), "FROM scratch");
 let registryRead = false;
 const runner: Runner = { run: async (command, args) => {
  if (command === "docker" && args[0] === "build") await writeFile(args[args.indexOf("--iidfile") + 1]!, `sha256:${"e".repeat(64)}`);
  let stdout = "";
  if (command === "git" && args[0] === "rev-parse") stdout = mergedSha;
  if (command === "git" && args[0] === "grep") stdout = "app.ts";
  if (command === "regctl" && args[1] === "digest") stdout = `sha256:${"d".repeat(64)}`;
  if (command === "regctl" && args[1] === "config") { registryRead = true; stdout = JSON.stringify({ config: { Labels: { "org.opencontainers.image.revision": head, "org.opencontainers.image.version": "1.1.0" } } }); }
  return { code: 0, stdout, stderr: "" };
 } };
 const p = ports(linked); p.runtime = linked.runtime({ runner, guard: humanless(true), readSecret: async () => "fixture-only" });
 const result = await publishOmiVersion(shipping("publish"), "omi1", { ...p, fixedCheckout: async () => ({ root: fixed, commitSha: mergedSha, release: async () => {} }) }); assert.equal(result.state, "unknown"); assert.equal(result.receipt, null); assert.equal(registryRead, true, "rechazar por OCI revision incorrecta, no por preflight previo");
});
