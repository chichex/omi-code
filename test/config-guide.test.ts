// Lo que falta configurar, en el contexto del agente: lo configura la persona con /omi-setup. Git temporal, KB en memoria, sin red.
// Integración de áreas (2026-11-23): la guía al agente nombra el setup unificado cuando falta configuración.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseConfig, type ConfigDoctorInput } from "../src/harness/config-doctor.ts";
import { configGuide } from "../src/harness/config-guide.ts";
import { foundationsHash, type FoundationsBlock } from "../src/harness/foundations.ts";
import type { LifecycleOnboardingState } from "../src/harness/lifecycle-onboarding.ts";
import type { FoundationsReading } from "../src/tui/development-foundations.ts";
import type { KbDoc } from "../src/tui/kb-client.ts";
import { CONFIG_REFRESH_EVENT } from "../src/tui/development-config-view.ts";
import { developmentFixture } from "./helpers/development.ts";
import { acceptLifecycleConfig, lifecycleConfig } from "./helpers/lifecycle.ts";
import { autoContinuity } from "./helpers/lifecycle-continuity.ts";
import { memoryKb } from "./helpers/mock-kb.ts";

const key = { kbUrl: "https://kb.example.test/mcp", product: "app", repo: "acme/app" };
const perillas: KbDoc = { id: "doc-7", producto: "app", tipo: "perillas", titulo: "Perillas de app", cuerpo: "# Perillas\n" };
const block: FoundationsBlock = { version: 2, repo: "acme/app", confirmar: ["git push *"], politica: { arranque: "ask", receta: "ask", push_pr: "ask" } };
const valid: FoundationsReading = { kind: "valid", key, block, hash: foundationsHash(block), perillas };
const lifecycle = (status: LifecycleOnboardingState["status"], revision: string | null = "lifecycle:abc"): LifecycleOnboardingState => ({ status, revision, reason: status, recommendations: [] });
const OMI = { organization: "acme", project: "tienda", services: ["api"] };
const diagnosis = (reading: FoundationsReading, state: LifecycleOnboardingState | null, omi: ConfigDoctorInput["omi"] = OMI) =>
	diagnoseConfig({ foundations: { reading, local: { kind: "missing" } }, lifecycle: state && { state, local: { kind: "missing" } }, omi });

test("config_guide: sin diagnóstico o con todo configurado, el agente no recibe nada", () => {
	assert.equal(configGuide(undefined), "");
	assert.equal(configGuide(diagnosis(valid, lifecycle("configured"))), "");
	assert.equal(configGuide(diagnosis(valid, lifecycle("configured"), null)), "", "el proyecto OMI sin vincular no lo corre el setup: no se le pasa al agente");
	assert.equal(configGuide(diagnosis(valid, { status: "unavailable", revision: null, reason: "KB caída", recommendations: [] })), "", "la KB caída no es «falta»");
	assert.equal(configGuide(diagnosis(valid, { status: "invalid", revision: null, reason: "Bloque inválido", recommendations: [] })), "", "un bloque inválido no lo corre el setup");
});

test("config_guide: lo que falta va con su mensaje y el comando que corre la persona", () => {
	const text = configGuide(diagnosis({ kind: "missing", key, perillas }, lifecycle("unconfigured", "missing:doc-7")));
	assert.match(text, /^Falta configurar en este repo: /);
	assert.match(text, /Sin Foundations para acme\/app/); assert.match(text, /Sin lifecycle: el trabajo termina en el PR draft/);
	assert.match(text, /Lo configura la persona con \/omi-setup/);
	assert.match(text, /No lo configures vos: no edites la KB ni las perillas/);
	assert.doesNotMatch(text, /omi init/, "en la TUI el comando es /omi-setup");
	assert.match(configGuide(diagnosis(valid, lifecycle("pending"))), /revisión del lifecycle sin aceptar/);
});

test("config_guide: el harness se lo pasa al agente mientras falta y deja de hacerlo al configurarlo", async (t) => {
	const kb = memoryKb({ products: ["repo"] }), background: Promise<void>[] = [];
	const f = await developmentFixture(t, { kb, foundations: { arranque: "auto", receta: "auto", push_pr: "auto" }, deps: { background: (work) => { background.push(work); } } });
	const settled = async () => { for (let seen = -1; seen !== background.length;) { seen = background.length; await Promise.all(background); } };
	const prompt = async () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await f.emit("before_agent_start", event); return event.systemPromptOptions.sections.omi_development ?? "";
	};
	await settled(); await f.start(); await settled();
	const missing = await prompt();
	assert.match(missing, /Falta configurar en este repo: Sin lifecycle: el trabajo termina en el PR draft/);
	assert.match(missing, /Lo configura la persona con \/omi-setup/);
	assert.doesNotMatch(missing, /Foundations para test\/repo/, "Foundations aceptada no aparece como faltante");
	await acceptLifecycleConfig(kb, f.home, f.checkout.root, lifecycleConfig("test/repo", (config) => { config.ship = { status: "not-applicable", targets: [] }; config.continuity = { ...autoContinuity }; }));
	await f.emitBus(CONFIG_REFRESH_EVENT, { sessionFile: f.manager.getSessionFile() }); await settled();
	assert.doesNotMatch(await prompt(), /Falta configurar/);
});
