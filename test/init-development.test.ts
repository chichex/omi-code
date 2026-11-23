import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { saveCredentials } from "../src/auth/credentials.ts";
import { initCommand } from "../src/cli/commands/init.ts";
import { developmentInit, type DevelopmentHost } from "../src/cli/init-development.ts";
import { headlessKbHost } from "../src/cli/development-host.ts";
import { credentialsPath } from "../src/core/paths.ts";
import { lifecycleTrustDir, readLifecycleTrust } from "../src/harness/lifecycle-trust.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { memoryKb, mockKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { acceptLifecycleConfig } from "./helpers/lifecycle.ts";
import { defaultLifecycleConfig } from "../src/harness/lifecycle-config.ts";
import { serviceView, startMockOmi } from "./helpers/mock-omi.ts";

const key = { kbUrl: "https://kb.example.test/mcp", product: "app", repo: "acme/app" };
const READS = new Set(["mis_productos", "buscar", "leer"]);
async function gitRepo(t: TestContext): Promise<string> {
 const repo = await tempDir(t); const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
 git("init", "-q"); git("remote", "add", "origin", "git@github.com:acme/app.git"); git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
 await mkdir(join(repo, ".github/workflows"), { recursive: true }); await writeFile(join(repo, ".github/workflows/release.yml"), "on:\n  workflow_dispatch:\n");
 return repo;
}
async function tree(root: string): Promise<string[]> {
 const out: string[] = []; const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); out.push(`${path}:${(await stat(path)).mtimeMs}`); if (entry.isDirectory()) await walk(path); } };
 await walk(root); return out.sort();
}
function fakeHost(kb: MemoryKb | undefined) {
 const host = { created: 0, closed: 0, factory: async (): Promise<DevelopmentHost> => { host.created++; return { kb, close: async () => { host.closed++; } }; } };
 return host;
}
async function development(t: TestContext, options: { interactive?: boolean; answers?: string[]; env?: Record<string, string> } = {}) {
 const home = await tempDir(t), repo = await gitRepo(t), kb = memoryKb({ products: ["app"] }), host = fakeHost(kb);
 const io = testIo({ homeDir: home, cwd: repo, interactive: options.interactive ?? false, answers: options.answers ?? [], ...(options.env ? { env: options.env } : {}) });
 return { home, repo, kb, host, io, run: (args: string[]) => developmentInit(args, io, { host: host.factory }) };
}
// Grafo estático de imports desde init.ts: la ruta legacy no arrastra Pi, la TUI ni el lifecycle/KB.
async function staticGraph(entry: string): Promise<string[]> {
 const seen = new Set<string>(), pending = [entry];
 while (pending.length) {
  const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) { const spec = match[1]!; if (spec.startsWith(".")) pending.push(resolve(dirname(file), spec)); else seen.add(spec); }
 }
 return [...seen];
}

test("ruta legacy con flags, bare no interactivo y JSON no cargan el host de desarrollo ni la KB", async t => {
 const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), graph = await staticGraph(join(root, "src/cli/commands/init.ts"));
 const heavy = graph.filter(m => /@earendil-works|\/src\/tui\/|lifecycle-|init-development|development-host|kb-client/.test(m)); assert.deepEqual(heavy, [], "imports estáticos pesados en la ruta legacy");
 const home = await tempDir(t), repo = await tempDir(t), omi = await startMockOmi(t); omi.sessions.set("prs_test", "active");
 await saveCredentials(credentialsPath(home), { apiUrl: omi.url, token: "prs_test", expiresAt: "2026-11-12T00:00:00Z", user: { id: "usr_ada", name: "Ada", email: "ada@omi.test" }, defaultOrganizationSlug: "acme" });
 const project = { id: "prj_tienda", name: "tienda", slug: "tienda", services: new Map() }; project.services.set("api", serviceView(project, "api", 8080, "stage", "acme")); omi.projects.set("tienda", project);
 let loaded = 0; const deps = { development: async () => { loaded++; return async () => 0; } };
 const io = testIo({ homeDir: home, cwd: repo });
 assert.equal(await initCommand(["--project", "tienda", "--service", "api", "--json"], io, deps), 0, io.errors()); assert.equal(JSON.parse(io.output()).link.projectSlug, "tienda");
 for (const args of [[], ["--json"]]) { const bare = testIo({ homeDir: home, cwd: repo }); await assert.rejects(initCommand(args, bare, deps), /falta slug del proyecto/); assert.deepEqual(bare.prompts, []); }
 const tty = testIo({ homeDir: home, cwd: repo, interactive: true, answers: ["tienda", "api"] }); assert.equal(await initCommand(["--json"], tty, deps), 0, tty.errors()); assert.equal(tty.prompts.length, 2, "bare --json conserva el diagnóstico/preguntas legacy");
 assert.equal(loaded, 0);
});

test("bare interactivo es modular: 1 vincula como antes y 2 abre desarrollo con carga diferida", async t => {
 const home = await tempDir(t), repo = await tempDir(t); let loaded: string[][] = [];
 const deps = { development: async () => async (args: string[]) => { loaded.push(args); return 0; } };
 const io = testIo({ homeDir: home, cwd: repo, interactive: true, answers: ["2"] });
 assert.equal(await initCommand([], io, deps), 0); assert.deepEqual(loaded, [["--development"]]); assert.equal(io.prompts.length, 1); assert.match(io.output(), /Vínculo con OMI[\s\S]*Desarrollo/);
 loaded = []; const cancel = testIo({ homeDir: home, cwd: repo, interactive: true, answers: ["9"] }); await assert.rejects(initCommand([], cancel, deps), /módulo/i); assert.deepEqual(loaded, []);
 const legacy = testIo({ homeDir: home, cwd: repo, interactive: true, answers: ["1", "tienda"] }); await assert.rejects(initCommand([], legacy, deps), /sin respuesta preparada: nombre del service/); assert.deepEqual(legacy.prompts.slice(1, 2), ["slug del proyecto [" + repo.split("/").at(-1) + "]: "], "1 sigue la ruta legacy de preguntas"); assert.deepEqual(loaded, []);
});

test("--development --check --json sólo lee: sin prompts, escrituras ni login, y distingue KB caída de ausencia", async t => {
 for (const interactive of [false, true]) {
  const f = await development(t, { interactive }), before = [...await tree(f.home), ...await tree(f.repo)];
  assert.equal(await f.run(["--development", "--check", "--json"]), 0, f.io.errors());
  const report = JSON.parse(f.io.output()); assert.equal(report.status, "unconfigured"); assert.equal(report.repo, "acme/app"); assert.equal(report.product, "app"); assert.equal(report.canStartEffects, false); assert.deepEqual(report.detection.workflows, [{ file: "release.yml", dispatch: true, release: false, contract: null }]); assert.deepEqual(report.recommendations, [{ kind: "continuity", message: "Continuidad sin configurar: el trabajo para en el PR draft" }]);
  assert.deepEqual(f.io.prompts, []); assert.deepEqual([...await tree(f.home), ...await tree(f.repo)], before, "check no escribe home ni repo"); assert.ok(f.kb.calls.every(c => READS.has(c.tool)), "sólo lecturas KB");
  assert.deepEqual([f.host.created, f.host.closed], [1, 1], "host diferido abierto y cerrado explícitamente");
 }
 const down = await development(t); down.kb.available = "KB caída"; assert.equal(await down.run(["--development", "--check", "--json"]), 0);
 const report = JSON.parse(down.io.output()); assert.equal(report.status, "unavailable"); assert.match(report.reason, /caída/); assert.deepEqual(await readLifecycleTrust(lifecycleTrustDir(down.home), key), { kind: "missing" });
});

test("--development sin UI sale 2 sin abrir el host; los flags no conceden permisos", async t => {
 for (const [options, args] of [[{}, ["--development"]], [{ interactive: true, env: { OMI_AGENT_SESSION: "1" } }, ["--development"]], [{ interactive: true }, ["--development", "--yes"]], [{ interactive: true }, ["--development", "--project", "x"]]] as const) {
  const f = await development(t, options); await assert.rejects(f.run([...args]), (error: unknown) => error instanceof Error && "exitCode" in error && error.exitCode === 2);
  assert.equal(f.host.created, 0); assert.deepEqual(f.io.prompts, []); assert.ok(!f.kb.calls.length);
 }
});

test("--development interactivo usa el wizard compartido sin modelo: Enter cancela, guardar exige el sí", async t => {
 const esc = await development(t, { interactive: true, answers: [""] }); assert.equal(await esc.run(["--development"]), 0, esc.io.errors());
 assert.match(esc.io.output(), /no se guardó nada/i); assert.deepEqual(await readLifecycleTrust(lifecycleTrustDir(esc.home), key), { kind: "missing" }); assert.ok(!esc.kb.calls.some(c => c.tool === "guardar")); assert.equal(esc.host.closed, 1);
 const f = await development(t, { interactive: true, answers: ["3", "1", "1"] }); assert.equal(await f.run(["--development"]), 0, f.io.errors());
 assert.match(f.io.output(), /Configurar ahora[\s\S]*Más adelante[\s\S]*Este repo no necesita Ship/); assert.match(f.io.output(), /ship\.status: unconfigured → not-applicable/);
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1); const local = await readLifecycleTrust(lifecycleTrustDir(f.home), key); assert.ok(local.kind === "valid"); assert.equal(local.record.accepted?.block.ship.status, "not-applicable"); assert.equal(local.record.accepted?.block.continuity, undefined); assert.equal(f.host.closed, 1);
 const check = testIo({ homeDir: f.home, cwd: f.repo }); assert.equal(await developmentInit(["--development", "--check", "--json"], check, { host: f.host.factory }), 0); assert.equal(JSON.parse(check.output()).status, "not-applicable");
});

test("--development CLI configura continuidad explícita y cancelar esa pregunta no guarda", async t => {
 const cancel = await development(t, { interactive: true, answers: ["3", ""] });
 assert.equal(await cancel.run(["--development"]), 0);
 assert.ok(!cancel.kb.calls.some(c => c.tool === "guardar"));
 const f = await development(t, { interactive: true, answers: ["3", "2", "2", "1", "3", "3", "3", "1"] });
 assert.equal(await f.run(["--development"]), 0, f.io.errors());
 const local = await readLifecycleTrust(lifecycleTrustDir(f.home), key);
 assert.ok(local.kind === "valid");
 assert.deepEqual(local.record.accepted?.block.continuity, { entry: "auto", review: "ask", fix: "manual", land: "manual", ship: "manual" });
 assert.match(f.io.output(), /continuity.entry: auto/);
 assert.match(f.io.output(), /Foundations/);
 assert.equal(f.kb.calls.filter(c => c.tool === "guardar").length, 1);
 assert.equal(f.host.closed, 1);
});

test("host headless real: sin login no arranca Pi ni escribe; con login reusa los stores de Pi contra la KB falsa y cierra", async t => {
 const kb = await mockKb(t, { products: ["app"] }), home = await tempDir(t), cwd = await tempDir(t), io = testIo({ homeDir: home, cwd });
 const none = await headlessKbHost(io, AbortSignal.timeout(20000), kb.url), ready = await none.kb?.ready(cwd, AbortSignal.timeout(5000)); await none.close();
 assert.ok(ready && !ready.ready); assert.match(ready.reason, /login/i); assert.deepEqual(await readdir(home), [], "sin login no crea stores ni abre OAuth"); assert.deepEqual(kb.methods, []);
 const agent = join(home, ".omi/agent"); await mkdir(agent, { recursive: true }); for (const file of ["auth.json", "mcp-auth.json", "models-store.json"]) await writeFile(join(agent, file), "{}");
 const before = await tree(agent), host = await headlessKbHost(io, AbortSignal.timeout(20000), kb.url);
 try { assert.deepEqual(await host.kb?.ready(cwd, AbortSignal.timeout(15000)), { ready: true }); assert.deepEqual(await host.kb?.products(AbortSignal.timeout(5000)), ["app"]); } finally { await host.close(); }
 assert.deepEqual(await tree(agent), before, "reusa los stores de Pi sin reescribirlos"); assert.ok(kb.calls.every(c => READS.has(c.tool)));
});

test("--check informa recomendaciones de una config aceptada y el wizard CLI pasa la Review a GHA con Sonnet", async t => {
 const review = await readFile(new URL("../.github/workflows/claude-review.yml", import.meta.url), "utf8");
 const legacy = defaultLifecycleConfig("acme/app", "main"); legacy.ship = { status: "not-applicable", targets: [] };
 const f = await development(t, { interactive: true, answers: ["1", "1", "2", "1", "1"] });
 await writeFile(join(f.repo, ".github/workflows/claude-review.yml"), review); await acceptLifecycleConfig(f.kb, f.home, f.repo, legacy);
 const check = testIo({ homeDir: f.home, cwd: f.repo }); assert.equal(await developmentInit(["--development", "--check", "--json"], check, { host: f.host.factory }), 0, check.errors());
 const report = JSON.parse(check.output()); assert.equal(report.status, "not-applicable"); assert.equal(report.canStartEffects, true);
 assert.deepEqual(report.recommendations.map((r: { kind: string }) => r.kind), ["continuity", "review-gha"]); assert.deepEqual(report.recommendations[1].workflows, ["claude-review.yml"]);
 assert.deepEqual(report.detection.workflows.find((w: { file: string }) => w.file === "claude-review.yml"), { file: "claude-review.yml", dispatch: true, release: false, contract: "omi-review-v1", tuning: { model: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"], effort: ["low", "medium", "high", "xhigh", "max"] } });
 const text = testIo({ homeDir: f.home, cwd: f.repo }); assert.equal(await developmentInit(["--development", "--check"], text, { host: f.host.factory }), 0);
 assert.match(text.output(), /Recomendación: Continuidad sin configurar: el trabajo para en el PR draft/); assert.match(text.output(), /Recomendación: .*claude-review\.yml/);
 assert.equal(await f.run(["--development"]), 0, f.io.errors());
 assert.match(f.io.output(), /Mantener Ship actual[\s\S]*GitHub Actions · claude-review\.yml \(omi-review-v1\) \(Recomendada\)[\s\S]*Sonnet/);
 const local = await readLifecycleTrust(lifecycleTrustDir(f.home), key); assert.ok(local.kind === "valid");
 assert.deepEqual(local.record.accepted?.block.review.provider, { kind: "gha", workflow: "claude-review.yml", ref: "main", contract: "omi-review-v1", model: "claude-sonnet-5-5" });
 assert.match(f.io.output(), /review\.provider\.model: claude-sonnet-5-5/);
});
