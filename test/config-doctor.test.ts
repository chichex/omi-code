// Diagnóstico puro de lo que falta configurar: sin I/O, sólo lecturas que ya hizo la sesión.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configLines, diagnoseConfig, FORMATO_ANTERIOR, type ConfigDoctorInput } from "../src/harness/config-doctor.ts";
import { foundationsHash, type FoundationsBlock } from "../src/harness/foundations.ts";
import type { TrustRecord } from "../src/harness/foundations-trust.ts";
import type { LifecycleOnboardingState } from "../src/harness/lifecycle-onboarding.ts";
import type { LifecycleTrustReading } from "../src/harness/lifecycle-trust.ts";
import type { FoundationsReading } from "../src/tui/development-foundations.ts";
import type { KbDoc } from "../src/tui/kb-client.ts";

const key = { kbUrl: "https://kb.example.test/mcp", product: "app", repo: "acme/app" };
const perillas: KbDoc = { id: "doc-7", producto: "app", tipo: "perillas", titulo: "Perillas de app", cuerpo: "# Perillas\n" };
const block: FoundationsBlock = { version: 2, repo: "acme/app", confirmar: ["git push *"], politica: { arranque: "ask", receta: "ask", push_pr: "ask" } };
const accepted = (deferred: TrustRecord["deferred"] = null): TrustRecord => ({ version: 2, ...key, accepted: { docId: "doc-1", blockHash: foundationsHash(block), block, author: "", date: "", acceptedAt: "now" }, deferred });
const deferredOnly = (revision: string): TrustRecord => ({ version: 2, ...key, accepted: null, deferred: { revision, at: "2026-11-23T00:00:00Z" } });
const lifecycle = (status: LifecycleOnboardingState["status"], recommendations: LifecycleOnboardingState["recommendations"] = [], revision: string | null = "lifecycle:abc"): LifecycleOnboardingState => ({ status, revision, reason: status, recommendations });
const CONTINUITY = { kind: "continuity" as const, message: "Continuidad sin configurar: el trabajo para en el PR draft" };
const REVIEW = { kind: "review-gha" as const, workflows: ["claude-review.yml"], message: "Review por GitHub Actions disponible: claude-review.yml cumple omi-review-v1; hoy revisa el revisor local" };
const lifecycleDeferred = (revision: string): LifecycleTrustReading => ({ kind: "valid", record: { version: 1, ...key, revision: 0, accepted: null, deferred: { revision, at: "2026-11-23T00:00:00Z" } } });
const OMI = { organization: "acme", project: "tienda", services: ["api"] };
function input(reading: FoundationsReading, overrides: Partial<ConfigDoctorInput> = {}): ConfigDoctorInput {
	return { foundations: { reading, local: { kind: "missing" } }, lifecycle: { state: lifecycle("configured"), local: { kind: "missing" } }, omi: OMI, ...overrides };
}
const item = (diagnosis: ReturnType<typeof diagnoseConfig>, id: string) => { const found = diagnosis.items.find((i) => i.id === id); assert.ok(found, `falta el ítem ${id}`); return found; };

test("config_doctor: Foundations ausente en la KB falta y corre; con la KB caída u offline no se ofrece", () => {
	const missing = diagnoseConfig(input({ kind: "missing", key, perillas }));
	assert.equal(item(missing, "foundations").status, "falta"); assert.equal(item(missing, "foundations").area, "foundations");
	assert.match(item(missing, "foundations").message, /Sin Foundations para acme\/app/); assert.match(item(missing, "foundations").resolve, /\/omi-setup/);
	assert.deepEqual(missing.foundations, { kind: "run", revision: "foundations:missing" });
	for (const reason of ["sin red (--offline o PI_OFFLINE) o MCP desactivado (--no-mcp)", "la KB no conectó a tiempo (sin login en /mcp, sin red o lenta)"]) {
		const down = diagnoseConfig(input({ kind: "unavailable", key, reason }, { lifecycle: { state: { status: "unavailable", revision: null, reason, recommendations: [] }, local: { kind: "missing" } } }));
		assert.equal(item(down, "foundations").status, "no-disponible"); assert.match(item(down, "foundations").message, new RegExp(reason.replace(/[()]/g, "\\$&")));
		assert.equal(item(down, "lifecycle").status, "no-disponible");
		assert.deepEqual(down.foundations, { kind: "none" }); assert.deepEqual(down.lifecycle, { kind: "none" }, "KB caída nunca es «falta configurar»");
	}
	const none = diagnoseConfig(input({ kind: "none", reason: "el repo no tiene origin en github.com" }, { lifecycle: null }));
	assert.equal(item(none, "foundations").status, "no-aplica"); assert.equal(item(none, "lifecycle").status, "no-aplica");
	assert.deepEqual(none.foundations, { kind: "none" }); assert.deepEqual(none.lifecycle, { kind: "none" });
});

test("config_doctor: un registro local o un bloque de la KB del formato anterior se distingue de ausente, sin mencionar versiones", () => {
	const local = diagnoseConfig(input({ kind: "missing", key, perillas }, { foundations: { reading: { kind: "missing", key, perillas }, local: { kind: "legacy" } } }));
	const kb = diagnoseConfig(input({ kind: "invalid", key, reason: "Foundations v1 obsoleto", perillas, legacy: true }));
	for (const diagnosis of [local, kb]) {
		const found = item(diagnosis, "foundations");
		assert.equal(found.status, "formato-anterior"); assert.equal(found.message, FORMATO_ANTERIOR);
		assert.equal(FORMATO_ANTERIOR, "Tu configuración de Foundations es de un formato anterior que ya no se usa: configurala de nuevo.");
		assert.doesNotMatch(`${found.message} ${found.resolve}`, /\bv[12]\b|version/i);
		assert.equal(diagnosis.foundations.kind, "run");
	}
	assert.deepEqual(kb.foundations, { kind: "run", revision: "foundations:legacy" });
	const invalid = diagnoseConfig(input({ kind: "invalid", key, reason: "JSON inválido", perillas }));
	assert.equal(item(invalid, "foundations").status, "invalido"); assert.match(item(invalid, "foundations").message, /JSON inválido/);
	assert.deepEqual(invalid.foundations, { kind: "run", revision: "foundations:invalid:JSON inválido" });
	const unreadable = diagnoseConfig(input({ kind: "missing", key, perillas }, { foundations: { reading: { kind: "missing", key, perillas }, local: { kind: "invalid" } } }));
	assert.equal(item(unreadable, "foundations").status, "invalido"); assert.equal(unreadable.foundations.kind, "run");
});

test("config_doctor: una v2 vigente (KB o última aceptada) está ok y no corre nada", () => {
	const valid = diagnoseConfig(input({ kind: "valid", key, block, hash: foundationsHash(block), perillas }));
	assert.equal(item(valid, "foundations").status, "ok"); assert.match(item(valid, "foundations").message, new RegExp(foundationsHash(block).slice(0, 8)));
	assert.deepEqual(valid.foundations, { kind: "none" });
	const local = diagnoseConfig(input({ kind: "missing", key, perillas }, { foundations: { reading: { kind: "missing", key, perillas }, local: { kind: "valid", record: accepted() } } }));
	assert.equal(item(local, "foundations").status, "ok"); assert.match(item(local, "foundations").message, /última revisión aceptada/);
	assert.deepEqual(local.foundations, { kind: "none" });
});

test("config_doctor: «Más adelante» de esa revisión queda postergado; otra revisión vuelve a correr", () => {
	const reading: FoundationsReading = { kind: "missing", key, perillas };
	const later = diagnoseConfig(input(reading, { foundations: { reading, local: { kind: "valid", record: deferredOnly("foundations:missing") } } }));
	assert.equal(item(later, "foundations").status, "postergado"); assert.match(item(later, "foundations").message, /Sin Foundations/);
	assert.deepEqual(later.foundations, { kind: "deferred", revision: "foundations:missing" });
	const legacy: FoundationsReading = { kind: "invalid", key, reason: "obsoleto", perillas, legacy: true };
	const other = diagnoseConfig(input(legacy, { foundations: { reading: legacy, local: { kind: "valid", record: deferredOnly("foundations:missing") } } }));
	assert.deepEqual(other.foundations, { kind: "run", revision: "foundations:legacy" }, "postergar la ausencia no posterga un bloque nuevo");
});

test("config_doctor: lifecycle sin configurar, pendiente, sin continuidad o con Review GHA disponible corre; aceptado sin recomendaciones, no", () => {
	const reading: FoundationsReading = { kind: "valid", key, block, hash: foundationsHash(block), perillas };
	const run = (state: LifecycleOnboardingState, local: LifecycleTrustReading = { kind: "missing" }) => diagnoseConfig(input(reading, { lifecycle: { state, local } }));
	const missing = run(lifecycle("unconfigured", [CONTINUITY], "missing:doc-7"));
	assert.equal(item(missing, "lifecycle").status, "falta"); assert.match(item(missing, "lifecycle").message, /PR draft/);
	assert.ok(!missing.items.some((i) => i.id === "lifecycle-continuity"), "sin lifecycle, la continuidad va dentro del mismo ítem");
	assert.deepEqual(missing.lifecycle, { kind: "run", revision: "missing:doc-7" });
	const pending = run(lifecycle("pending"));
	assert.equal(item(pending, "lifecycle").status, "pendiente"); assert.deepEqual(pending.lifecycle, { kind: "run", revision: "lifecycle:abc" }, "pendiente de aceptar sin recomendaciones también corre");
	const legacy = run(lifecycle("not-applicable", [CONTINUITY, REVIEW]));
	assert.equal(item(legacy, "lifecycle").status, "ok"); assert.equal(item(legacy, "lifecycle-continuity").status, "falta");
	assert.match(item(legacy, "lifecycle-continuity").message, /Continuidad sin configurar/);
	assert.equal(item(legacy, "lifecycle-review").status, "pendiente"); assert.match(item(legacy, "lifecycle-review").message, /claude-review\.yml/);
	assert.deepEqual(legacy.lifecycle, { kind: "run", revision: "lifecycle:abc" });
	const done = run(lifecycle("configured"));
	assert.equal(item(done, "lifecycle").status, "ok"); assert.deepEqual(done.lifecycle, { kind: "none" });
	const later = run(lifecycle("not-applicable", [CONTINUITY]), lifecycleDeferred("lifecycle:abc"));
	assert.equal(item(later, "lifecycle-continuity").status, "postergado"); assert.deepEqual(later.lifecycle, { kind: "deferred", revision: "lifecycle:abc" });
	const broken = run({ status: "invalid", revision: null, reason: "Configuración lifecycle o aceptación local inválida; requiere revisión humana", recommendations: [] });
	assert.equal(item(broken, "lifecycle").status, "invalido"); assert.deepEqual(broken.lifecycle, { kind: "none" }, "inválido pide revisión humana, no el wizard");
});

test("config_doctor: proyecto OMI sin vincular es sólo informativo y nunca una parte del setup", () => {
	const reading: FoundationsReading = { kind: "valid", key, block, hash: foundationsHash(block), perillas };
	const unlinked = diagnoseConfig(input(reading, { omi: null }));
	assert.equal(item(unlinked, "omi-project").status, "falta"); assert.match(item(unlinked, "omi-project").resolve, /omi init/);
	assert.match(item(unlinked, "omi-project").resolve, /no se corre solo/);
	assert.deepEqual([unlinked.foundations, unlinked.lifecycle], [{ kind: "none" }, { kind: "none" }]);
	assert.equal(item(diagnoseConfig(input(reading, { omi: "invalid" })), "omi-project").status, "invalido");
	assert.equal(item(diagnoseConfig(input(reading, { omi: undefined })), "omi-project").status, "no-disponible");
	const linked = item(diagnoseConfig(input(reading)), "omi-project"); assert.equal(linked.status, "ok"); assert.match(linked.message, /acme\/tienda/);
});

test("config_doctor: las líneas muestran área, estado y cómo resolver, sin recortar ni concatenar con pipes", () => {
	const lines = configLines(diagnoseConfig(input({ kind: "missing", key, perillas }, { omi: null, lifecycle: { state: lifecycle("unconfigured", [CONTINUITY], "missing:doc-7"), local: { kind: "missing" } } })));
	const text = lines.join("\n");
	assert.match(text, /Foundations · falta: Sin Foundations para acme\/app/);
	assert.match(text, /Lifecycle · falta:/); assert.match(text, /Proyecto OMI · falta:/);
	assert.match(text, /\/omi-setup/); assert.doesNotMatch(text, /\|/);
	assert.ok(lines.every((line) => line.length > 0));
});
