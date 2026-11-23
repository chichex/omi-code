// Pestaña OMI: todo a la vista, sin apretar f. Presenter puro; los snapshots salen de las funciones reales del harness.
// Cambio de requisito del dueño (2026-11-23): «no hagamos que tengas que apretar F para verlo, sino que se muestre todo
// directamente para que sea mucho más claro».
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { FORMATO_ANTERIOR } from "../src/harness/config-doctor.ts";
import { foundationsHash, renderFoundationsBlock, type FoundationsBlock } from "../src/harness/foundations.ts";
import type { TrustInspection } from "../src/harness/foundations-trust.ts";
import { defaultLifecycleConfig, defaultLifecycleTarget, lifecycleHash, renderLifecycleBlock, type LifecycleConfig, type LifecycleTarget } from "../src/harness/lifecycle-config.ts";
import type { LifecycleDetection } from "../src/harness/lifecycle-detect.ts";
import { lifecycleFromPerillas, type LifecycleReading } from "../src/harness/lifecycle-kb.ts";
import type { LifecycleTrustReading } from "../src/harness/lifecycle-trust.ts";
import { assembleConfigSnapshot, lifecycleSnapshot, type ConfigView } from "../src/tui/development-config-view.ts";
import type { FoundationsPin, FoundationsReading } from "../src/tui/development-foundations.ts";
import type { KbDoc } from "../src/tui/kb-client.ts";
import { omiViewLines, type OmiSnapshot } from "../src/tui/workspace/omi-view.ts";

const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value, style: (value: string) => value, getColorMode: () => "truecolor" } as unknown as Theme;
const key = { kbUrl: "https://kb.test/mcp", product: "repo", repo: "test/repo" };
const RULES = ["git push *", "npm publish*", "rm -rf *", "gh pr merge *", "gh workflow run *"];
const foundations = (confirmar = RULES): FoundationsBlock => ({ version: 2, repo: "test/repo", confirmar, politica: { arranque: "ask", receta: "ask", push_pr: "auto" } });
const doc = (cuerpo: string): KbDoc => ({ id: "abcdef0123456789", titulo: "Perillas de repo", cuerpo, producto: "repo", tipo: "perillas", autor: "ana@example.test", fecha: "2026-11-20" });
const target = (input: unknown): LifecycleTarget => { const made = defaultLifecycleTarget(input); if (!("target" in made)) throw new Error(made.reason); return made.target; };
/** Todo lo que se puede configurar: Review GHA con modelo, checks, dos destinos de Ship y las cinco palancas. */
function fullConfig(change: (block: LifecycleConfig) => void = () => {}): LifecycleConfig {
	const block = defaultLifecycleConfig("test/repo", "main");
	block.review = { mode: "auto", provider: { kind: "gha", workflow: "claude-review.yml", ref: "main", contract: "omi-review-v1", model: "claude-sonnet-5-5" }, timeoutSeconds: 1800 };
	block.corrections = { mode: "auto", maxRounds: 3 };
	block.land = { mode: "ask", base: "main", method: "squash", maxRisk: "low", requiredChecks: [{ context: "cierre", appId: 15368 }, { context: "claude-review", appId: 15368 }] };
	block.ship = { status: "configured", targets: [
		target({ id: "release", timeoutSeconds: 60, provider: { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "github-release" }, evidence: { kind: "github-release", assets: ["app.tar.gz"], checksumsAsset: "checksums.txt" } }),
		target({ id: "omi-api-prod", provider: { kind: "omi", service: "api", environment: "prod", mode: "observe" }, evidence: { kind: "omi", provenance: "publication-receipt" } }),
	] };
	block.continuity = { entry: "ask", review: "auto", fix: "auto", land: "manual", ship: "manual" };
	change(block); return block;
}
const linked: LifecycleDetection = { workflows: [], scripts: [], manifests: [], omi: { organization: "acme", project: "app", services: ["api"] }, skipped: [] };
const accepted = (block: LifecycleConfig): LifecycleTrustReading => ({ kind: "valid", record: { version: 1, ...key, revision: 0, accepted: { docId: "abcdef0123456789", blockHash: lifecycleHash(block), block, author: "", date: "", acceptedAt: "now" }, deferred: null } });
interface Parts { foundations?: FoundationsBlock | null; lifecycle?: LifecycleConfig | null; reading?: FoundationsReading; local?: TrustInspection; lifecycleLocal?: LifecycleTrustReading; lifecycleReading?: LifecycleReading; detection?: LifecycleDetection }
/** Un snapshot como el que publica el harness: perillas con Foundations y lifecycle en un mismo documento. */
function view(parts: Parts = {}): ConfigView {
	const block = parts.foundations === undefined ? foundations() : parts.foundations, config = parts.lifecycle === undefined ? fullConfig() : parts.lifecycle;
	const perillas = doc([block ? renderFoundationsBlock(block) : "", config ? renderLifecycleBlock(config) : ""].join("\n\n"));
	const reading: FoundationsReading = parts.reading ?? (block ? { kind: "valid", key, block, hash: foundationsHash(block), perillas } : { kind: "missing", key, perillas });
	const lifecycleReading = parts.lifecycleReading ?? (reading.kind === "unavailable" ? { kind: "unavailable" as const, key, reason: reading.reason } : lifecycleFromPerillas(key, perillas));
	const lifecycleLocal = parts.lifecycleLocal ?? (config ? accepted(config) : { kind: "missing" as const });
	const snapshot = assembleConfigSnapshot({ reading, local: parts.local ?? { kind: "missing" }, lifecycle: reading.kind === "none" ? null : lifecycleSnapshot(lifecycleReading, lifecycleLocal, parts.detection ?? linked), detection: parts.detection ?? linked });
	return { status: "ready", snapshot, at: 1000, refreshing: false, error: null };
}
const pinOf = (block: FoundationsBlock, reading: FoundationsReading): FoundationsPin => ({ version: 2, origin: "kb", block, hash: foundationsHash(block), docId: "abcdef0123456789", author: "ana@example.test", date: "", notice: "", reading });
function render(config: ConfigView | undefined, options: { width?: number; pin?: FoundationsPin; session?: boolean } = {}): string[] {
	const snapshot: OmiSnapshot = { project: undefined, services: [], environments: [], error: undefined, at: 1, now: 3000, pin: options.pin, config, session: options.session ?? true };
	return omiViewLines(theme, snapshot, options.width ?? 132).map((line) => stripTerminalSequences(line).trimEnd());
}
/** Lo que se lee de corrido: une las líneas partidas por el ancho. */
const prose = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean).join(" ");
const section = (lines: string[], title: string) => { const start = lines.findIndex((line) => line.startsWith(` ${title}`)); assert.ok(start >= 0, `falta la sección ${title}`); const end = lines.findIndex((line, index) => index > start && /^ [A-ZÁÉÍÓÚ]{4,}/.test(line)); return lines.slice(start + 1, end < 0 ? undefined : end); };

test("omi_view: el encabezado nombra r, s, f y Esc; FOUNDATIONS muestra cada política con su significado y todos los patrones", () => {
	const config = view(); const ready = config.status === "ready" ? config.snapshot.reading : undefined; assert.ok(ready);
	const lines = render(config, { pin: pinOf(foundations(), ready) });
	assert.equal(lines[1], " r actualizar · s configurar lo que falta · f editar Foundations · Esc chat");
	const shown = section(lines, "FOUNDATIONS");
	assert.ok(shown.includes(` Origen: KB · revisión ${foundationsHash(foundations()).slice(0, 8)} · perillas abcdef01 · ana@example.test`));
	assert.ok(shown.includes(" Vigente en esta sesión."));
	assert.ok(shown.includes(" Arranque: ask. Te pide el sí antes de crear el issue, el worktree y la sesión."));
	assert.ok(shown.includes(" Receta: ask. Te muestra la receta para que la apruebes antes de implementar."));
	assert.ok(shown.includes(" Push + PR draft: auto. Hace push de la rama y abre el PR draft sin preguntar; nunca mergea ni fuerza."));
	assert.ok(shown.includes(" Patrones que requieren confirmación:"));
	for (const rule of RULES) assert.ok(shown.includes(`   ${rule}`), `cada patrón en su línea: ${rule}`);
	assert.doesNotMatch(lines.join("\n"), /y \d+ más|Todavía no se leyó/);
});

test("omi_view: LIFECYCLE muestra Review GHA con modelo, correcciones, Land con checks, cada destino de Ship y el presupuesto; CONTINUIDAD las cinco palancas", () => {
	for (const width of [132, 80]) {
		const lines = render(view(), { width });
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `nada se pasa de ${width} columnas`);
		const lifecycle = prose(section(lines, "LIFECYCLE")), continuity = prose(section(lines, "CONTINUIDAD"));
		assert.match(lifecycle, new RegExp(`Estado: configurado · revisión ${lifecycleHash(fullConfig()).slice(0, 8)} · aceptada en esta máquina`));
		assert.match(lifecycle, /Review: auto · GitHub Actions · claude-review\.yml@main · modelo: claude-sonnet-5-5 · espera hasta 30 min/);
		assert.match(lifecycle, /Correcciones: auto · hasta 3 rondas/);
		assert.match(lifecycle, /Land: ask · base main · squash · riesgo máximo low/);
		assert.match(lifecycle, /Checks requeridos: cierre · app 15368 claude-review · app 15368/);
		assert.match(lifecycle, /Ship: configurado release · GitHub Actions · release\.yml@main · observe · release de GitHub · ask · si falla: stop/);
		assert.match(lifecycle, /omi-api-prod · OMI · api · prod · observe · ask · si falla: stop/);
		assert.match(lifecycle, /Presupuesto: 12 intentos · 120 min activos · 1 PR fix-forward/);
		assert.match(continuity, /Entrada tras el PR draft: ask · pregunta antes de seguir/);
		assert.match(continuity, /Review: auto · sigue sola si los guardrails lo permiten/);
		assert.match(continuity, /Fix: auto · sigue sola si los guardrails lo permiten/);
		assert.match(continuity, /Land: manual · espera tu comando: \/omi-work land/);
		assert.match(continuity, /Ship: manual · espera tu comando: \/omi-work ship/);
		assert.match(continuity, /Continuar no autoriza efectos: cada uno conserva su permiso\./);
	}
});

// Sin apretar f: cada campo de cada destino, también lo que decide qué pasa con auto (rollback, reintentos, evidencia).
test("omi_view: cada destino de Ship muestra timeout, reintentos, recuperación con su modo, rollback y la evidencia exigida", () => {
	const deploy = target({ id: "deploy", mode: "auto", timeoutSeconds: 900, maxRetries: 3, onFailure: { action: "rollback", mode: "auto" },
		provider: { kind: "gha", workflow: "deploy.yml", ref: "main", mode: "dispatch", contract: "omi-ship-v1", rollback: { workflow: "rollback.yml", ref: "main", contract: "omi-ship-v1" } },
		evidence: { kind: "receipt", health: { path: "/health", status: 200 }, version: { path: "/version", versionField: "build.version", commitField: "build.commit" } } });
	const release = target({ id: "release", maxRetries: 1, onFailure: { action: "fix-forward", mode: "ask" }, provider: { kind: "gha", workflow: "release.yml", ref: "main", mode: "observe", contract: "github-release" },
		evidence: { kind: "github-release", tag: "v1.2.3", assets: ["app.tar.gz", "app.zip"], checksumsAsset: "checksums.txt" } });
	const omi = target({ id: "omi-api-prod", provider: { kind: "omi", service: "api", environment: "prod", mode: "observe" }, evidence: { kind: "omi", health: { path: "/health", status: 204 }, provenance: "publication-receipt" } });
	for (const width of [132, 80]) {
		const lines = render(view({ lifecycle: fullConfig((block) => { block.ship = { status: "configured", targets: [deploy, release, omi] }; }) }), { width });
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `nada se pasa de ${width} columnas`);
		const lifecycle = prose(section(lines, "LIFECYCLE"));
		assert.match(lifecycle, /deploy · GitHub Actions · deploy\.yml@main · dispatch · recibo omi-ship-v1 · auto · si falla: rollback \(auto\) espera hasta 15 min · hasta 3 reintentos rollback: rollback\.yml@main · recibo omi-ship-v1 verifica: recibo · health \/health → 200 · versión \/version · campo build\.version · commit build\.commit/);
		assert.match(lifecycle, /release · GitHub Actions · release\.yml@main · observe · release de GitHub · ask · si falla: fix-forward \(ask\) espera hasta 30 min · hasta 1 reintento verifica: release con tag v1\.2\.3 · assets app\.tar\.gz, app\.zip · checksums checksums\.txt/);
		assert.match(lifecycle, /omi-api-prod · OMI · api · prod · observe · ask · si falla: stop espera hasta 30 min · sin reintentos verifica: OMI · recibo de publicación · health \/health → 204/);
	}
});

test("omi_view: sin continuidad el trabajo para en el PR draft; Review local y de GitHub, Ship manual y sin checks también se leen", () => {
	const legacy = fullConfig((block) => { delete block.continuity; block.review.provider = { kind: "github", reviewers: ["ada", "bob"] }; block.review.mode = "ask"; block.review.timeoutSeconds = 1200; block.land.requiredChecks = []; block.ship = { status: "manual", targets: [] }; });
	const lines = render(view({ lifecycle: legacy }));
	const lifecycle = prose(section(lines, "LIFECYCLE")), continuity = prose(section(lines, "CONTINUIDAD"));
	assert.match(lifecycle, /Review: ask · reviews de GitHub · ada, bob · espera hasta 20 min/);
	assert.match(lifecycle, /Checks requeridos: ninguno/); assert.match(lifecycle, /Ship: manual \(sin destino verificable\)/);
	assert.match(continuity, /^Deshabilitada: el trabajo para en el PR draft\. Para seguir con un PR draft: \/omi-work adopt\. Para configurarla: \/omi-setup\.$/);
	const local = fullConfig((block) => { block.review.provider = { kind: "local" }; block.ship = { status: "not-applicable", targets: [] }; });
	const other = prose(section(render(view({ lifecycle: local })), "LIFECYCLE"));
	assert.match(other, /Review: auto · revisor local aislado sobre el diff fijo/); assert.match(other, /Ship: no aplica/);
});

// Un lifecycle aceptado con Ship sin configurar corre Review y Land: el estado no dice que termina en el PR draft.
test("omi_view: un lifecycle aceptado sin Ship se ve configurado, con Ship sin configurar y sin «sin lifecycle»", () => {
	const lines = render(view({ lifecycle: fullConfig((block) => { block.ship = { status: "unconfigured", targets: [] }; }) }));
	const lifecycle = prose(section(lines, "LIFECYCLE"));
	assert.match(lifecycle, /^Estado: configurado · revisión [0-9a-f]{8} · aceptada en esta máquina · Ship sin configurar/);
	assert.match(lifecycle, /Ship: sin configurar/);
	assert.doesNotMatch(lines.join("\n"), /el trabajo termina en el PR draft|Sin lifecycle/);
	assert.match(lines.join("\n"), /Lifecycle aceptado sin Ship: Review y Land corren, pero la entrega no se verifica\./);
});

test("omi_view: el estado del lifecycle distingue sin configurar, pendiente, postergado, no disponible con su motivo e inválido", () => {
	const missing = render(view({ lifecycle: null }));
	assert.match(prose(section(missing, "LIFECYCLE")), /^Estado: sin configurar · el trabajo termina en el PR draft, sin Review, Land ni Ship$/);
	assert.match(prose(section(missing, "CONTINUIDAD")), /^Deshabilitada: el trabajo para en el PR draft\.$/);
	const pending = prose(section(render(view({ lifecycleLocal: { kind: "missing" } })), "LIFECYCLE"));
	assert.match(pending, /Estado: pendiente de aceptar · revisión [0-9a-f]{8} · la KB tiene una revisión sin aceptar en esta máquina/);
	assert.match(pending, /Review: auto · GitHub Actions/, "lo pendiente también se ve campo por campo");
	const config = fullConfig(), deferral = { revision: `lifecycle:${lifecycleHash(config)}`, at: "now" };
	const local = accepted(config); assert.ok(local.kind === "valid");
	assert.match(prose(section(render(view({ lifecycleLocal: { kind: "valid", record: { ...local.record, deferred: deferral } } })), "LIFECYCLE")), /Estado: configurado .* · postergado \(Más adelante\)/);
	const down = render(view({ reading: { kind: "unavailable", key, reason: "la KB no conectó a tiempo" } }));
	const downText = prose(section(down, "LIFECYCLE"));
	assert.match(downText, /Estado: no disponible · la KB no conectó a tiempo/);
	assert.match(downText, /Última aceptada en esta máquina: sólo para observar, no inicia efectos\./);
	assert.match(downText, /Review: auto · GitHub Actions/, "lo último aceptado sigue a la vista");
	const unknown = prose(section(render(view({ reading: { kind: "unavailable", key, reason: "sin KB" }, lifecycleLocal: { kind: "missing" } })), "CONTINUIDAD"));
	assert.match(unknown, /Sin datos: no se pudo leer el lifecycle\./);
	const invalid = prose(section(render(view({ lifecycleReading: { kind: "invalid", key, perillas: doc(""), reason: "falta land.base" }, lifecycleLocal: { kind: "missing" } })), "LIFECYCLE"));
	assert.match(invalid, /Estado: inválido · falta land\.base/);
	const none = render(view({ reading: { kind: "none", reason: "el repo no tiene origin en github.com" } }));
	assert.match(prose(section(none, "LIFECYCLE")), /No aplica: hace falta un repo de GitHub con producto en la KB\./);
});

test("omi_view: FALTA CONFIGURAR lista el diagnóstico con cómo resolverlo; con todo en orden dice «Todo configurado»", () => {
	const lines = render(view({ foundations: null, lifecycle: null, detection: { ...linked, omi: null } }));
	const missing = section(lines, "FALTA CONFIGURAR");
	assert.match(lines.find((line) => line.startsWith(" FALTA CONFIGURAR")) ?? "", /FALTA CONFIGURAR · hace 2s/);
	assert.ok(missing.includes(" ✗ Foundations · falta: Sin Foundations para test/repo: rige el default, nada pregunta."));
	assert.ok(missing.includes("   Con /omi-setup armás las reglas y políticas; sólo Guardar escribe."));
	assert.ok(missing.some((line) => line.startsWith(" ✗ Lifecycle · falta: Sin lifecycle")));
	assert.ok(missing.some((line) => line.startsWith(" ✗ Proyecto OMI · falta")));
	assert.ok(!missing.some((line) => line.includes("✓")), "lo que está bien no se lista como faltante");
	assert.deepEqual(section(render(view()), "FALTA CONFIGURAR"), [" Todo configurado.", ""]);
});

test("omi_view: sin pin todavía muestra lo que va a regir con su origen; el formato anterior y la KB caída se avisan con el motivo", () => {
	const kb = prose(section(render(view()), "FOUNDATIONS"));
	assert.match(kb, /Origen: KB · revisión [0-9a-f]{8} · perillas abcdef01 · ana@example\.test Se fija en esta sesión al empezar un trabajo\./);
	assert.match(kb, /Arranque: ask\. Te pide el sí/); assert.match(kb, /gh workflow run \*/);
	const legacy = prose(section(render(view({ foundations: null, reading: { kind: "invalid", key, reason: "bloque con un formato anterior", perillas: doc(""), legacy: true } })), "FOUNDATIONS"));
	assert.match(legacy, /Origen: por defecto \(sin configurar: nada pregunta\)/);
	assert.match(legacy, /Arranque: auto\. Crea el issue, el worktree y la sesión sin preguntar, con el texto del agente\./);
	assert.match(legacy, /\(sin configurar: nada pregunta\)/);
	assert.ok(legacy.includes(`Motivo: ${FORMATO_ANTERIOR}`)); assert.doesNotMatch(legacy, /\bv[12]\b|obsolet/i);
	const block = foundations(["npm publish*"]);
	const local: TrustInspection = { kind: "valid", record: { version: 2, ...key, accepted: { docId: "doc-local", blockHash: foundationsHash(block), block, author: "", date: "", acceptedAt: "now" }, deferred: null } };
	const down = prose(section(render(view({ reading: { kind: "unavailable", key, reason: "sin KB" }, local })), "FOUNDATIONS"));
	assert.match(down, /Origen: local \(última aceptada\) · revisión [0-9a-f]{8}/); assert.match(down, /npm publish\*/);
	assert.match(down, /Motivo: No se pudo leer Foundations: sin KB\./);
});

test("omi_view: con el pin fijado avisa si la KB ya tiene otra revisión y muestra el formato anterior aunque rija el default", () => {
	const old = foundations(["npm test"]), config = view(); assert.ok(config.status === "ready");
	const lines = prose(section(render(config, { pin: pinOf(old, { kind: "valid", key, block: old, hash: foundationsHash(old), perillas: doc("") }) }), "FOUNDATIONS"));
	assert.match(lines, new RegExp(`En la KB hay otra revisión \\(${foundationsHash(foundations()).slice(0, 8)}\\): vale desde la próxima sesión\\.`));
	const legacy = view({ foundations: null, reading: { kind: "invalid", key, reason: "bloque con un formato anterior", perillas: doc(""), legacy: true } }); assert.ok(legacy.status === "ready");
	const fallback: FoundationsPin = { version: 2, origin: "default", block: null, hash: null, docId: null, author: null, date: null, notice: "Las perillas de repo no tienen Foundations para test/repo: vale el default: nada pregunta (todo auto).", reading: legacy.snapshot.reading };
	const shown = prose(section(render(legacy, { pin: fallback }), "FOUNDATIONS"));
	assert.match(shown, /Vigente en esta sesión\./); assert.match(shown, /Aviso: Las perillas de repo no tienen Foundations/);
	assert.ok(shown.includes(`Motivo: ${FORMATO_ANTERIOR}`));
});

test("omi_view: sin datos de configuración lo dice con el motivo, también sin sesión persistente o al fallar la lectura", () => {
	const waiting = render(undefined);
	assert.match(prose(section(waiting, "FOUNDATIONS")), /Todavía no se leyó de la KB: se lee al abrir la sesión\./);
	assert.match(prose(section(waiting, "LIFECYCLE")), /Todavía no hay datos: se leen al abrir la sesión\. r vuelve a leer\./);
	assert.match(prose(section(render({ status: "reading" }), "FALTA CONFIGURAR")), /Leyendo la configuración de la KB…/);
	assert.match(prose(section(render({ status: "failed", reason: "lectura cancelada" }), "CONTINUIDAD")), /No se pudo leer la configuración: lectura cancelada\. r vuelve a leer\./);
	assert.match(prose(section(render(undefined, { session: false }), "LIFECYCLE")), /Sin sesión persistente: la configuración no se lee\./);
	const stale = view(); assert.ok(stale.status === "ready");
	const refreshing = render({ ...stale, refreshing: true, error: "la KB no conectó a tiempo" });
	assert.match(refreshing.find((line) => line.startsWith(" FALTA CONFIGURAR")) ?? "", /· actualizando…/);
	assert.ok(refreshing.includes(" No se pudo actualizar: la KB no conectó a tiempo. Se muestra la lectura anterior."));
});

// El estado va al final de la línea del ambiente: cortarla esconde justo el dato útil.
test("omi_view: a 80 y 40 columnas el proyecto, cada ambiente con su estado y el error se parten sin cortar", () => {
	const project = "acme-latam/plataforma-de-pagos", service = "facturacion-electronica-api", version = "v2026.11.23-rc.1+build.4521.arm64";
	const error = "No se pudo consultar OMI: la API respondió 503 después de tres intentos seguidos";
	const environments = [{ service, name: "produccion-sudamerica-este-norte", state: "running", version }, { service, name: "stage", state: "failed" }];
	for (const width of [80, 40]) {
		const snapshot: OmiSnapshot = { project, services: [service], environments, error, at: 1, now: 3000, pin: undefined, config: undefined, session: true };
		const lines = omiViewLines(theme, snapshot, width).map((line) => stripTerminalSequences(line).trimEnd());
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width} columnas`);
		const shown = prose(lines);
		for (const value of [project, service, `produccion-sudamerica-este-norte · ${version} · running`, "stage · sin versión · failed", `${error} · datos desactualizados`]) assert.ok(shown.includes(value), `${value} entero a ${width}`);
		const environment = lines.findIndex((line) => line.includes("produccion-sudamerica-este-norte"));
		assert.ok(lines.slice(environment, environment + 3).every((line) => line.startsWith("   ")), "un ambiente partido sigue con la sangría de la lista");
		const unlinked = omiViewLines(theme, { ...snapshot, project: undefined, services: [], environments: [], error: undefined }, width).map((line) => stripTerminalSequences(line).trimEnd());
		assert.ok(prose(unlinked).includes("Sin proyecto OMI vinculado. Usá omi init para vincularlo."), `sin vínculo, el aviso entero a ${width}`);
	}
});

test("omi_view: a 80 y 40 columnas nada se corta: las líneas largas se parten y conservan la sangría", () => {
	const long = Array.from({ length: 8 }, (_, i) => `npm run check:${i} --workspace=packages/muy-largo-${i}`);
	const block = foundations(long), config = view({ foundations: block }); assert.ok(config.status === "ready");
	for (const width of [80, 40]) {
		const lines = render(config, { width, pin: pinOf(block, config.snapshot.reading) });
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width} columnas`);
		for (const rule of long) assert.ok(prose(lines).includes(rule), `${rule} entero a ${width}`);
		const rules = section(lines, "FOUNDATIONS").filter((line) => /check:|packages/.test(line));
		assert.ok(rules.every((line) => line.startsWith("   ")), "un patrón partido sigue con la sangría de la lista");
	}
});
