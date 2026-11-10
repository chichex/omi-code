import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { modelCapabilities, modelDescription, modelPrice, modelPriceNote, modelProfile, thinkingLabel } from "../src/tui/workspace/model-info.ts";
import { OmiModelPicker, modelKey, recommendedModels, type PickerResult } from "../src/tui/workspace/model-picker.ts";

const base: Model<Api> = {
	id: "gpt-9.1-sol", name: "GPT-9.1 Sol", provider: "openai", api: "openai-responses", baseUrl: "https://example.invalid",
	reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 128000,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};
const model = (id: string, patch: Partial<Model<Api>> = {}): Model<Api> => ({ ...base, id, name: id, ...patch });
const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value, style: (value: string) => value, getColorMode: () => "truecolor" } as unknown as Theme;
const ids = (models: Model<Api>[]) => models.map((entry) => entry.id);
const catalog = ["gpt-4o", "o3", "gpt-5.5", "gpt-5.5-pro", "gpt-5.3-codex", "gpt-9-sol", "gpt-9.1-sol",
	"gpt-9.1-terra", "gpt-9-luna", "gpt-9-astra", "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest", "gpt-5.6-cyber"]
	.map((id) => model(id, /-(terra|luna)$/.test(id) ? { thinkingLevelMap: { ...base.thinkingLevelMap, off: "none" } } : {}));

function picker(options: { models?: Model<Api>[]; current?: Model<Api>; favorites?: string[]; query?: string; rows?: number } = {}) {
	let result: PickerResult | undefined;
	const instance = new OmiModelPicker({
		models: options.models ?? catalog, current: options.current ?? base, thinking: "high", favorites: options.favorites ?? [],
		initialQuery: options.query ?? "", contextTokens: null, theme, maxRows: () => options.rows ?? 40, render() {}, done(value) { result = value; },
	});
	return { instance, result: () => result };
}

test("workspace_OpenAI recomendados es una lista corta de variantes actuales, no todas las ramas históricas", () => {
	assert.deepEqual(ids(recommendedModels(catalog)), ["gpt-9.1-sol", "gpt-9.1-terra", "gpt-9-luna", "gpt-9-astra"]);
	assert.deepEqual(ids(recommendedModels(catalog, new Set(["openai/gpt-daybreak-blue-latest", "openai/gpt-4o"]))),
		["gpt-4o", "gpt-9.1-sol", "gpt-9.1-terra", "gpt-9-luna", "gpt-9-astra", "gpt-daybreak-blue-latest"]);
});

test("workspace_OpenAI curación respeta scopes, providers, prefijos de gateways y modelos custom", () => {
	assert.deepEqual(ids(recommendedModels(catalog.filter((entry) => !/-(sol|terra|luna|astra)$/.test(entry.id)))), ["gpt-5.5", "gpt-5.5-pro", "gpt-5.3-codex"]);
	const onlyDaybreak = catalog.filter((entry) => entry.id.includes("daybreak"));
	assert.deepEqual(recommendedModels(onlyDaybreak), onlyDaybreak, "un scope sólo de aliases sigue siendo seleccionable");
	for (const provider of ["openai", "openai-codex", "azure"]) {
		assert.equal(recommendedModels(catalog.map((entry) => ({ ...entry, provider }))).length, 4);
	}
	const gateway = catalog.map((entry) => ({ ...entry, provider: "openrouter", id: `openai/${entry.id}` }));
	assert.equal(recommendedModels([...gateway, model("custom-local", { provider: "openrouter" })]).length, 5);
	assert.ok(recommendedModels([...catalog, model("custom-deployment")]).some((entry) => entry.id === "custom-deployment"));
	const other = model("gpt-5.5", { provider: "my-proxy" });
	assert.ok(recommendedModels([...catalog, other]).includes(other), "no presume que un proxy tenga el mismo catálogo");
	assert.equal(recommendedModels([model("gpt-9.1-terra")])[0]?.id, "gpt-9.1-terra", "no introduce Sol fuera del scope");
	assert.deepEqual(ids(recommendedModels([model("gpt-9.1-sol-2027-01-01"), model("gpt-9-terra")])),
		["gpt-9.1-sol-2027-01-01", "gpt-9-terra"], "también reconoce snapshots cuando no hay alias");
});

test("workspace_catálogo instalado de OpenAI reduce las recomendaciones sin inventar modelos", () => {
	for (const provider of ["openai", "openai-codex"] as const) {
		const models: Model<Api>[] = getModels(provider);
		const recommended = recommendedModels(models);
		assert.ok(recommended.length > 0);
		assert.ok(recommended.length < models.length);
		assert.ok(recommended.every((entry) => models.includes(entry)));
		assert.ok(!recommended.some((entry) => /daybreak|cyber/.test(entry.id)));
	}
});

test("workspace_descripciones breves no inventan especialidades para variantes desconocidas", () => {
	assert.match(modelDescription(model("gpt-daybreak-red-latest")), /Uso no documentado.*sin versión informada/);
	assert.match(modelDescription(model("gpt-5.6-cyber")), /Uso no documentado/);
	assert.match(modelDescription(model("chat-latest")), /no informa la versión/);
	assert.match(modelDescription(model("gemini-9-pro-preview", { provider: "google" })), /según su nombre/);
	assert.match(modelDescription(model("gpt-5.3-codex")), /Para programar/);
	for (const entry of catalog) assert.ok(modelDescription(entry).length <= 60, entry.id);
});

test("workspace_descripciones explican el análisis sin jerga ni listas de niveles", () => {
	assert.match(modelDescription(base), /Analiza antes de responder.*no apagarlo/);
	const terra = model("gpt-9.1-terra", { thinkingLevelMap: { ...base.thinkingLevelMap, off: "none" } });
	assert.match(modelDescription(terra), /cuánto analiza o desactivarlo/);
	assert.match(modelDescription(model("local", { provider: "custom", reasoning: false, thinkingLevelMap: {} })), /No tiene un ajuste/);
	assert.match(modelCapabilities(base), /texto \+ imagen.*128k/);
	assert.doesNotMatch(modelCapabilities(base), /Esfuerzo:|low|medium|high/);
	assert.equal(thinkingLabel("off"), "Sin análisis extra");
	assert.equal(thinkingLabel("high"), "Alto");
	assert.equal(thinkingLabel("xhigh"), "Muy alto");
	assert.equal(thinkingLabel("max"), "Máximo");
});

test("workspace_etiquetas de capacidad tienen fuente oficial y no se calculan por precio o contexto", () => {
	const expected = { "gpt-6-astra": "Máxima", "gpt-6.1-sol": "Muy alta", "gpt-6.1-terra": "Muy alta", "gpt-6-luna": "Alta" };
	for (const [id, capability] of Object.entries(expected)) {
		const profile = modelProfile(model(id));
		assert.equal(profile?.capability, capability);
		assert.equal(profile?.source, `https://developers.openai.com/api/docs/models/${id}`);
		assert.match(profile!.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(profile!.evidence.length > 20);
		assert.ok(profile!.description.length <= 60);
		assert.equal(modelProfile(model(id, { contextWindow: 100, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))?.capability, capability);
		assert.equal(modelProfile(model(`openai/${id}`, { provider: "openrouter" }))?.capability, capability);
		assert.equal(modelProfile(model(id, { provider: "openai-codex" }))?.capability, capability);
	}
	assert.equal(modelProfile(base), undefined, "no extrapola de Sol 6.1 a un futuro Sol 9.1");
	assert.equal(modelProfile(model("gpt-6.1-sol", { provider: "custom-proxy" })), undefined);
	assert.equal(modelProfile(model("gpt-6.1-sol-preview")), undefined);
	assert.equal(modelProfile(model("chat-latest")), undefined);
	assert.match(modelDescription(model("gpt-6.1-sol")), /Código y trabajo complejo/);
	assert.match(modelDescription(model("gpt-6.1-terra")), /Visión.*escritura/);
	assert.match(modelDescription(model("gpt-daybreak-blue-latest")), /alias obsoleto/);
	assert.equal(modelProfile(model("gpt-daybreak-blue-latest"))?.capability, "Especializado");
});

test("workspace_tarifas conservan unidades, caché, tramos y separan referencia API de cuotas", () => {
	assert.match(modelPrice(base), /USD \/ 1M tokens: \$2 entrada · \$10 salida · \$0.1 lectura caché/);
	assert.match(modelPriceNote(base), /No indica saldo ni cuota del plan/);
	const tiered = model(base.id, { cost: { ...base.cost, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] } });
	assert.match(modelPriceNote(tiered), /cambia sobre 272k tokens/);
	assert.match(modelPrice(model("free-or-unknown", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })), /no implica que sea gratis/);
	assert.match(modelPrice(model("bad-rate", { cost: { ...base.cost, input: NaN } })), /sin referencia útil/);
	assert.equal(modelPrice({ ...base, provider: "openai-codex" }), modelPrice(base));
	assert.equal(modelPrice(base, true), "API base · USD/1M tokens: $2 entrada · $10 salida");
	assert.equal(modelPrice(model("unknown", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), true), "Precio API no informado.");
});

test("workspace_selector muestra un resumen mínimo y reserva la ficha técnica para Enter", () => {
	const { instance, result } = picker();
	const output = instance.render(140).join("\n");
	assert.match(output, /4 modelos/);
	const rows = instance.render(140).filter((line) => /tokens|openai\//.test(line) === false && /gpt-9/.test(line));
	assert.ok(rows[0]?.includes("gpt-9.1-sol"));
	assert.ok(rows[1]?.includes("gpt-9.1-terra"));
	assert.match(output, /Analiza antes de responder/);
	assert.match(output, /\$2 entrada · \$10 salida/);
	assert.doesNotMatch(output, /Razonamiento|Esfuerzo:|Salida máx\.:|lectura caché|No indica saldo|openai\//);
	assert.ok(rows.every((line) => !line.includes("analiza") && !line.includes("Analiza")), "las filas no repiten el hint");
	assert.doesNotMatch(output, /daybreak/i);
	instance.handleInput("\r");
	const review = instance.render(140).join("\n");
	assert.match(review, /Usar modelo.*\n[\s\S]*\$2 entrada/);
	assert.match(review, /Salida máx\.: 128k/);
	assert.match(review, /lectura caché/);
	assert.match(review, /No indica saldo ni cuota del plan/);
	assert.match(review, /Análisis: Alto/);
	assert.doesNotMatch(review, /low \/ medium|siempre activo/);
	assert.equal(result(), undefined);
	instance.handleInput("\r"); assert.equal(modelKey(result()!.choice!.model), modelKey(base));
});

test("workspace_badges de capacidad son cortos, no agregan párrafos y la fuente queda en Enter", () => {
	const models = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra"].map((id) => model(id));
	const { instance } = picker({ models, current: models[0]! });
	const lines = instance.render(140);
	const rows = lines.filter((line) => /gpt-6/.test(line));
	assert.equal(rows.length, 4);
	assert.match(rows[0]!, /gpt-6.1-sol.*\[Muy alta\].*272k/);
	assert.match(rows[1]!, /gpt-6.1-terra.*\[Muy alta\]/);
	assert.match(rows[2]!, /gpt-6-luna.*\[Alta\]/);
	assert.match(rows[3]!, /gpt-6-astra.*\[Máxima\]/);
	assert.doesNotMatch(lines.join("\n"), /Fuente:|guía de OpenAI|https:/);
	assert.equal(lines.length, picker().instance.render(140).length, "no agrega filas");
	instance.handleInput("\r");
	const review = instance.render(160).join("\n");
	assert.match(review, /Capacidad: Muy alta · guía de OpenAI/);
	assert.match(review, /Fuente: https:\/\/developers.openai.com\/api\/docs\/models\/gpt-6.1-sol/);
	const unknown = picker().instance;
	assert.match(unknown.render(140).join("\n"), /\[Sin referencia\]/);
	for (const width of [1, 3, 25, 59, 60, 80, 140]) {
		const list = picker({ models, current: models[0]! }).instance;
		assert.ok(list.render(width).every((line) => visibleWidth(line) <= width), `${width} columnas`);
		if (width >= 60) assert.match(list.render(width).join("\n"), /\[Muy alta\]/);
	}
});

test("workspace_el resumen sigue la selección y configurar sólo ofrece niveles soportados", () => {
	const { instance, result } = picker();
	instance.handleInput("\x1b[B");
	assert.match(instance.render(120).join("\n"), /cuánto analiza o desactivarlo/);
	instance.handleInput("\x1b[A");
	assert.match(instance.render(120).join("\n"), /no apagarlo/);
	instance.handleInput("\r");
	for (let i = 0; i < 6; i++) {
		assert.doesNotMatch(instance.render(120).join("\n"), /Sin análisis extra/);
		instance.handleInput("\x1b[D");
	}
	assert.equal(result(), undefined);
	instance.handleInput("\r"); assert.ok(result()?.choice);
	const optional = picker({ query: "terra" }).instance;
	optional.handleInput("\r");
	const seen: string[] = [];
	for (let i = 0; i < 6; i++) { seen.push(optional.render(120).join("\n")); optional.handleInput("\x1b[D"); }
	assert.ok(seen.some((screen) => screen.includes("Análisis: Sin análisis extra")));
});

test("workspace_Daybreak se recupera por catálogo, búsqueda, favoritos o modelo actual, con advertencia", () => {
	const { instance } = picker(); instance.handleInput("\x01");
	assert.match(instance.render(140).join("\n"), /Catálogo/);
	instance.handleInput("daybreak");
	assert.match(instance.render(140).join("\n"), /Seguridad defensiva; alias obsoleto/);
	const current = picker({ current: model("gpt-daybreak-blue-latest") }).instance;
	assert.match(current.render(140).join("\n"), /gpt-daybreak-blue-latest · actual/);
	const favorite = picker({ favorites: ["openai/gpt-daybreak-red-latest"] }).instance;
	favorite.handleInput("\x06");
	assert.match(favorite.render(140).join("\n"), /gpt-daybreak-red-latest/);
});

test("workspace_ficha adapta alto y ancho, también al cambiar de página y con mouse", () => {
	for (const rows of [20, 24, 30, 40]) {
		const { instance } = picker({ rows }); instance.handleInput("\x01");
		for (const width of [1, 3, 25, 40, 80, 140]) {
			const lines = instance.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width} columnas`);
			assert.ok(lines.length <= rows, `${rows} filas: ${lines.length}`);
		}
		instance.handleInput("\x1b[6~");
		const lines = instance.render(140);
		const y = lines.findIndex((line) => /^│ ›/.test(line));
		assert.ok(y >= 0);
		instance.handleMouse({ type: "click", y } as never);
		assert.match(instance.render(140).join("\n"), /Usar modelo/);
	}
});
