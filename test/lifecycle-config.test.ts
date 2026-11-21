import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBlock, composePerillas, foundationsHash, parseFoundations } from "../src/harness/foundations.ts";
import {
 checkLifecycleConfig, defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash,
 parseLifecycleConfig, renderLifecycleBlock, composeLifecyclePerillas,
} from "../src/harness/lifecycle-config.ts";

const repo = "acme/app";
const defaults = () => defaultLifecycleConfig(repo, "main");
const fence = (value: unknown, info = "omi-development-lifecycle") => `\`\`\`${info}\n${JSON.stringify(value)}\n\`\`\``;
const gha = () => ({ id: "release", provider: { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "github-release" }, evidence: { kind: "github-release", assets: ["app-linux-x64.tar.gz"], checksumsAsset: "checksums.txt" } });
const omi = () => ({ id: "api-stage", provider: { kind: "omi", service: "api", environment: "stage", mode: "observe" }, evidence: { kind: "omi", health: { path: "/health", status: 200 }, version: { path: "/version", versionField: "version", commitField: "commit" } } });
function target(input: unknown) {
 const result = defaultLifecycleTarget(input);
 assert.ok("target" in result, "reason" in result ? result.reason : "target válido");
 return result.target;
}
function valid(value: unknown) {
 const checked = checkLifecycleConfig(value);
 assert.ok("block" in checked, "reason" in checked ? checked.reason : "config válida");
 return checked.block;
}
function invalid(value: unknown) { assert.ok("reason" in checkLifecycleConfig(value)); }
function configured(...targets: unknown[]) { return { ...defaults(), ship: { status: "configured", targets } }; }

test("lifecycle reconoce su cerca, sin confundirla con Foundations ni texto citado", () => {
 const minimal = { version: 1, repo, review: { mode: "ask", provider: { kind: "local" }, timeoutSeconds: 1200 }, corrections: { mode: "ask", maxRounds: 2 }, land: { mode: "ask", base: "main", method: "squash", maxRisk: "low", requiredChecks: [] }, ship: { status: "unconfigured", targets: [] }, budget: { maxAttempts: 12, maxFixForwardPRs: 1, activeSeconds: 7200 } };
 const parsed = parseLifecycleConfig(fence(minimal), repo);
 assert.equal(parsed.status, "valid", "una configuración completa debe reconocerse");
 assert.deepEqual(parseLifecycleConfig("sin configuración", repo), { status: "missing" });
 assert.deepEqual(parseLifecycleConfig(fence(minimal, "json"), repo), { status: "missing" });
 assert.deepEqual(parseLifecycleConfig(`~~~~md\n${fence(minimal)}\n~~~~`, repo), { status: "missing" });
});

test("defaults explícitos, independientes y con branch detectada, no main universal", () => {
 const block = defaults();
 assert.deepEqual(block, { version: 1, repo, review: { mode: "ask", provider: { kind: "local" }, timeoutSeconds: 1200 }, corrections: { mode: "ask", maxRounds: 2 }, land: { mode: "ask", base: "main", method: "squash", maxRisk: "low", requiredChecks: [] }, ship: { status: "unconfigured", targets: [] }, budget: { maxAttempts: 12, maxFixForwardPRs: 1, activeSeconds: 7200 } });
 assert.equal(defaultLifecycleConfig(repo, "trunk").land.base, "trunk");
 assert.throws(() => defaultLifecycleConfig(repo, ""));
 assert.throws(() => defaultLifecycleConfig("Acme/App", "main"));
 block.review.mode = "auto";
 assert.equal(block.corrections.mode, "ask"); assert.equal(block.land.mode, "ask");
 assert.equal(defaults().review.mode, "ask", "sin referencias compartidas");
 assert.deepEqual(valid(block), block);
});

test("persistido es completo, cerrado y sin coerciones en todos los niveles", () => {
 const block = defaults();
 for (const value of [null, [], {}, { ...block, version: 2 }, { ...block, repo: "Acme/App" }, { ...block, profile: "auto" }, { ...block, review: { ...block.review, timeoutSeconds: "1200" } }, { ...block, review: { ...block.review, shell: "review.sh" } }, { ...block, land: { ...block.land, admin: true } }, { ...block, budget: { ...block.budget, dollars: 10 } }]) invalid(value);
 for (const key of Object.keys(block)) { const copy: Record<string, unknown> = { ...block }; delete copy[key]; invalid(copy); }
 assert.ok("reason" in checkBlock(block), "lifecycle no amplía Foundations v1");
 invalid({ ...block, review: { ...block.review, provider: { kind: "local", command: "review" } } });
});

test("límites cerrados y enteros en ambas fronteras", () => {
 for (const value of [60, 7200]) valid({ ...defaults(), review: { ...defaults().review, timeoutSeconds: value } });
 for (const value of [59, 7201, 60.5, NaN, Infinity]) invalid({ ...defaults(), review: { ...defaults().review, timeoutSeconds: value } });
 for (const value of [0, 10]) valid({ ...defaults(), corrections: { mode: "ask", maxRounds: value } });
 for (const value of [-1, 11, 1.5]) invalid({ ...defaults(), corrections: { mode: "ask", maxRounds: value } });
 for (const [key, min, max] of [["maxAttempts", 1, 100], ["maxFixForwardPRs", 0, 5], ["activeSeconds", 60, 86400]] as const) {
  for (const value of [min, max]) valid({ ...defaults(), budget: { ...defaults().budget, [key]: value } });
  for (const value of [min - 1, max + 1, min + 0.5]) invalid({ ...defaults(), budget: { ...defaults().budget, [key]: value } });
 }
});

test("review github exige reviewers explícitos; gha tiene contrato cerrado", () => {
 for (const provider of [{ kind: "github", reviewers: ["Ada", "Grace"] }, { kind: "gha", workflow: ".github/workflows/review.yml", ref: "refs/heads/main", contract: "omi-review-v1" }]) valid({ ...defaults(), review: { ...defaults().review, provider } });
 for (const provider of [{ kind: "github", reviewers: [] }, { kind: "github", reviewers: ["Ada", "ada"] }, { kind: "github", reviewers: [""] }, { kind: "gha", workflow: "review.yml", ref: "main", contract: "v2" }, { kind: "gha", workflow: "../review.yml", ref: "main", contract: "omi-review-v1" }, { kind: "gha", workflow: "review.yml", ref: "main;run", contract: "omi-review-v1" }, { kind: "custom", command: "review.sh" }]) invalid({ ...defaults(), review: { ...defaults().review, provider } });
});

test("Land valida método, base y checks context+appId sin deduplicar silenciosamente", () => {
 for (const method of ["squash", "merge", "rebase"]) valid({ ...defaults(), land: { ...defaults().land, method, requiredChecks: [{ context: "cierre", appId: 123 }] } });
 for (const requiredChecks of [[{ context: "cierre" }], [{ context: "cierre", appId: 0 }], [{ context: "cierre", appId: 1, bypass: true }], [{ context: "cierre", appId: 1 }, { context: "cierre", appId: 1 }]]) invalid({ ...defaults(), land: { ...defaults().land, requiredChecks } });
 valid({ ...defaults(), land: { ...defaults().land, requiredChecks: [{ context: "cierre", appId: 1 }, { context: "cierre", appId: 2 }] } });
 for (const base of ["", "-main", "../main", "main..next", "main.lock", "main\nother", "main@{1}"]) invalid({ ...defaults(), land: { ...defaults().land, base } });
 invalid({ ...defaults(), land: { ...defaults().land, method: "admin" } });
});

test("targets materializan defaults; configured requiere destinos y el resto no los simula", () => {
 const release = target(gha());
 assert.deepEqual(release, { ...gha(), mode: "ask", timeoutSeconds: 1800, maxRetries: 0, onFailure: { action: "stop", mode: "ask" } });
 valid(configured(release, target(omi())));
 invalid({ ...defaults(), ship: { status: "configured", targets: [] } });
 for (const status of ["unconfigured", "manual", "not-applicable"]) {
  valid({ ...defaults(), ship: { status, targets: [] } });
  invalid({ ...defaults(), ship: { status, targets: [release] } });
 }
 valid(configured(...Array.from({ length: 20 }, (_, i) => ({ ...release, id: `target-${i}` }))));
 invalid(configured(...Array.from({ length: 21 }, (_, i) => ({ ...release, id: `target-${i}` }))));
 invalid(configured(release, release));
 assert.ok("reason" in defaultLifecycleTarget({ ...gha(), onFailure: null }));
 assert.ok("reason" in defaultLifecycleTarget({ ...gha(), mode: "AUTO" }));
});

test("todos los campos anidados de targets son cerrados, discriminados y acotados", () => {
 const release = target(gha());
 for (const maxRetries of [0, 10]) valid(configured({ ...release, maxRetries }));
 for (const maxRetries of [-1, 11, 0.5]) invalid(configured({ ...release, maxRetries }));
 for (const timeoutSeconds of [60, 7200]) valid(configured({ ...release, timeoutSeconds }));
 for (const timeoutSeconds of [59, 7201, 60.5]) invalid(configured({ ...release, timeoutSeconds }));
 for (const onFailure of [{ action: "stop", mode: "auto" }, { action: "rollback", mode: "ask" }, { action: "fix-forward", mode: "auto" }]) valid(configured({ ...release, onFailure }));
 for (const change of [{ command: "deploy.sh" }, { provider: { ...gha().provider, shell: "run" } }, { evidence: { ...gha().evidence, command: "smoke.sh" } }, { evidence: omi().evidence }, { onFailure: { action: "stop", mode: "ask", resetBudget: true } }, { onFailure: { action: "retry", mode: "ask" } }]) invalid(configured({ ...release, ...change }));
 const receipt = target({ ...gha(), provider: { ...gha().provider, mode: "dispatch", contract: "omi-ship-v1", rollback: { workflow: "rollback.yml", ref: "main", contract: "omi-ship-v1" } }, evidence: { kind: "receipt", health: { path: "/health", status: 200 } } });
 valid(configured(receipt));
 invalid(configured({ ...receipt, evidence: gha().evidence }));
});

test("evidence OMI permite provenance verificable, endpoints relativos y campos configurados, nunca URLs o shell", () => {
 const stage = target(omi()); valid(configured(stage));
 for (const mode of ["observe", "tag", "direct"]) valid(configured({ ...stage, provider: { ...omi().provider, mode } }));
 valid(configured({ ...stage, provider: { ...omi().provider, environment: "prod" } }));
 for (const path of ["https://evil.test/health", "//evil.test/health", "/../health", "/a/./health", "/%2e%2e/health", "/health?token=x", "/health#x", "/health\n", "/a\\b"]) invalid(configured({ ...stage, evidence: { kind: "omi", health: { path, status: 200 } } }));
 for (const commitField of ["__proto__.commit", "constructor", "nested.prototype", "$(git)"]) invalid(configured({ ...stage, evidence: { kind: "omi", version: { path: "/version", versionField: "version", commitField } } }));
 valid(configured({ ...stage, evidence: { kind: "omi", version: { path: "/version", versionField: "build.version", commitField: "build.commit" } } }));
 invalid(configured({ ...stage, evidence: { kind: "omi" } }));
 invalid(configured({ ...stage, provider: { ...omi().provider, environment: "dev" } }));
 invalid(configured({ ...stage, evidence: { kind: "omi", health: { path: "/health", status: 999 } } }));
});

test("hash canónico cambia por permisos/defaults/destinos, no por orden de claves/formato", () => {
 const block = valid(configured(target(gha()), target(omi())));
 const reordered = { budget: block.budget, ship: block.ship, land: block.land, corrections: block.corrections, review: { timeoutSeconds: block.review.timeoutSeconds, provider: block.review.provider, mode: block.review.mode }, repo: block.repo, version: block.version };
 assert.equal(lifecycleHash(block), lifecycleHash(valid(reordered)));
 assert.notEqual(lifecycleHash(block), lifecycleHash(valid({ ...block, corrections: { ...block.corrections, mode: "auto" } })));
 assert.notEqual(lifecycleHash(block), lifecycleHash(valid({ ...block, ship: { status: "configured", targets: [...block.ship.targets].reverse() } })));
 const parsed = parseLifecycleConfig(renderLifecycleBlock(block), repo);
 assert.ok(parsed.status === "valid"); assert.equal(parsed.hash, lifecycleHash(block));
});

test("cercas ambiguas/JSON inválido/repo desconocido fallan cerrado; otro repo identificable no aplica", () => {
 const body = fence(defaults());
 for (const raw of [body + "\n" + body, "```omi-development-lifecycle\n{}", "```omi-development-lifecycle\n{broken}\n```", fence({ version: 1 }), fence({ ...defaults(), repo: "Acme/App" })]) assert.equal(parseLifecycleConfig(raw, repo).status, "invalid");
 assert.equal(parseLifecycleConfig(fence({ ...defaults(), repo: "other/app" }), repo).status, "missing");
 assert.equal(parseLifecycleConfig(`~~~omi-development-lifecycle\n${JSON.stringify(defaults())}\n~~~`, repo).status, "valid");
});

test("compose preserva byte a byte Foundations/triage/otros repos y no muta sus hashes", () => {
 const foundations = { version: 1 as const, repo, comandos: ["npm test"], politica: { arranque: "ask" as const, receta: "ask" as const, fuera_de_catalogo: "ask" as const, push_pr: "ask" as const } };
 const before = composePerillas(undefined, "app", repo, foundations);
 const prefix = `Texto humano\r\n\n${before}\n${fence({ ...defaults(), repo: "other/app" })}\n`;
 const current = `${prefix}${fence(defaults())}\nNota final\r\n`;
 const changed = { ...defaults(), review: { ...defaults().review, mode: "auto" as const } };
 const next = composeLifecyclePerillas(current, "app", repo, changed);
 assert.equal(next, `${prefix}${renderLifecycleBlock(changed)}\nNota final\r\n`);
 const preserved = parseFoundations(next, repo);
 assert.ok(preserved.status === "valid"); assert.equal(preserved.hash, foundationsHash(foundations));
 assert.ok(next.includes(before));
 assert.equal(composeLifecyclePerillas(next, "app", repo, changed), next, "sin revisiones por formato");
 const added = composeLifecyclePerillas(before, "app", repo, defaults());
 assert.ok(added.startsWith(before));
 assert.equal(parseLifecycleConfig(added, repo).status, "valid");
 const created = composeLifecyclePerillas(undefined, "app", repo, defaults());
 assert.ok(created.startsWith("# Perillas de app"));
 assert.throws(() => composeLifecyclePerillas(current + "\n" + fence(defaults()), "app", repo, changed));
 assert.throws(() => composeLifecyclePerillas("```md\nsin cierre", "app", repo, changed));
 assert.throws(() => composeLifecyclePerillas(before, "app", "other/app", changed));
});
