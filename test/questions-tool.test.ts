// omi_ask: el agente pregunta una tanda y recibe respuestas estructuradas. Nunca supone una ni autoriza nada.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ASK_TOOL, workflowToolAllowed } from "../src/harness/permissions.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { developmentInstructions } from "../src/tui/development-view.ts";
import { askQuestions } from "../src/tui/questions/ask.ts";
import { questionsExtension } from "../src/tui/questions/tool.ts";
import { answerCustom, KEYS, typed } from "./helpers/questions.ts";
import { developmentFixture } from "./helpers/development.ts";

async function askTool(): Promise<ToolDefinition> {
	const tools: ToolDefinition[] = [];
	const extension = questionsExtension();
	await extension.factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI);
	assert.equal(extension.name, "omi-questions");
	const tool = tools.find((t) => t.name === ASK_TOOL); assert.ok(tool); return tool;
}
function context(keys: (screen: string) => readonly string[] | undefined, options: { mode?: string; hasUI?: boolean } = {}) {
	const screens: string[][] = []; let customs = 0;
	const ctx = { mode: options.mode ?? "tui", hasUI: options.hasUI ?? true, ui: {
		theme: undefined,
		custom: async (factory: Parameters<typeof answerCustom>[0], opts: { blocked?: { kind: string } }) => {
			customs++; assert.equal(opts.blocked?.kind, "question", "la TUI marca a OMI como esperando una respuesta");
			const { value, screens: shown } = await answerCustom(factory, keys); screens.push(shown); return value;
		},
	} } as unknown as ExtensionToolContext;
	return { ctx, screens, customs: () => customs };
}
const input = { questions: [
	{ question: "¿Qué alcance tiene el cambio?", header: "Alcance", multiSelect: false, options: [{ label: "Sólo el bug", description: "Arregla el cálculo" }, { label: "Bug y refactor", description: "Ordena el módulo" }] },
	{ question: "¿Qué gates corremos?", header: "Gates", multiSelect: true, options: [{ label: "npm test", description: "Tests" }, { label: "npm run typecheck", description: "Tipos" }, { label: "npm run lint", description: "Estilo" }] },
] };
const run = (tool: ToolDefinition, params: unknown, ctx: ExtensionToolContext, signal = new AbortController().signal) => tool.execute("call", params, signal, undefined, ctx);
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("\n");

test("omi_ask: el esquema pide 1–4 preguntas de 2–4 opciones con encabezado corto, sin campos extra", async () => {
	const { parameters } = await askTool();
	const question = input.questions[0]!;
	assert.equal(Value.Check(parameters, input), true);
	assert.equal(Value.Check(parameters, { questions: [question, question, question, question] }), true);
	for (const bad of [
		{ questions: [] }, { questions: [question, question, question, question, question] },
		{ questions: [{ ...question, options: [question.options[0]] }] },
		{ questions: [{ ...question, options: [...question.options, ...question.options, question.options[0]] }] },
		{ questions: [{ ...question, header: "Trece letras!" }] }, { questions: [{ ...question, header: "" }] },
		{ questions: [{ ...question, multiSelect: undefined }] }, { questions: [{ ...question, id: "q1" }] },
		{ questions: [{ ...question, options: [{ label: "Sí" }, { label: "No", description: "x" }] }] },
		{ ...input, recommended: 0 },
	]) assert.equal(Value.Check(parameters, bad), false, JSON.stringify(bad));
});

test("omi_ask: sin TUI interactiva falla con un error claro y no supone una respuesta", async () => {
	const tool = await askTool();
	for (const options of [{ mode: "print" }, { mode: "json" }, { mode: "rpc" }, { hasUI: false }]) {
		const { ctx, customs } = context(() => ["1"], options);
		await assert.rejects(run(tool, input, ctx), /TUI interactiva.*print, RPC o sin UI/s, JSON.stringify(options));
		assert.equal(customs(), 0, "no abre ningún diálogo");
	}
	await assert.rejects(askQuestions(context(() => ["1"], { mode: "rpc" }).ctx, { title: "t", questions: [] }), /TUI interactiva/);
});

test("omi_ask: la primera opción es la recomendada, nada viene elegido y OMI agrega la respuesta libre", async () => {
	const tool = await askTool(); const { ctx, screens } = context(() => []);
	await run(tool, input, ctx);
	const first = screens[0]![0]!;
	assert.match(first, /1\. Sólo el bug \(Recomendada\)/); assert.match(first, /3\. Escribir otra respuesta/);
	assert.match(first, /El agente pregunta/);
	assert.doesNotMatch(first, /■/, "ninguna pregunta respondida de entrada");
});

test("omi_ask: devuelve por pregunta su id, el texto, las opciones elegidas y el texto libre por separado", async () => {
	const tool = await askTool();
	const { ctx } = context(() => ["2", KEYS.space, KEYS.down, KEYS.down, KEYS.down, KEYS.space, ...typed("npm run e2e"), KEYS.enter, KEYS.enter, KEYS.enter]);
	const result = await run(tool, input, ctx);
	const answers = [
		{ id: "q1", question: "¿Qué alcance tiene el cambio?", options: ["Bug y refactor"], text: null },
		{ id: "q2", question: "¿Qué gates corremos?", options: ["npm test"], text: "npm run e2e" },
	];
	assert.deepEqual(result.details, { status: "answered", answers });
	assert.equal(result.terminate, undefined, "el agente sigue con las respuestas");
	const content = textOf(result);
	assert.ok(content.includes(JSON.stringify(answers)), content);
	assert.match(content, /no una autorización/); assert.match(content, /acuerdo del chat/);
	const free = await run(tool, { questions: [input.questions[0]] }, context(() => ["3", ...typed("Ninguna de las dos"), KEYS.enter]).ctx);
	assert.deepEqual(free.details, { status: "answered", answers: [{ id: "q1", question: "¿Qué alcance tiene el cambio?", options: [], text: "Ninguna de las dos" }] });
});

test("omi_ask: cancelar no devuelve respuestas parciales ni consentimiento y termina el turno", async () => {
	const tool = await askTool();
	for (const keys of [["1", KEYS.esc], [KEYS.ctrlC], []]) {
		const result = await run(tool, input, context(() => keys).ctx);
		assert.deepEqual(result.details, { status: "cancelled" }, JSON.stringify(keys));
		assert.equal(result.terminate, true);
		assert.match(textOf(result), /canceló.*no hay respuestas ni consentimiento/s);
		assert.doesNotMatch(textOf(result), /Sólo el bug/);
	}
	const aborted = new AbortController(); aborted.abort();
	assert.deepEqual((await run(tool, input, context(() => ["1", "1"]).ctx, aborted.signal)).details, { status: "cancelled" });
});

test("omi_ask: rechaza la respuesta libre como opción, opciones repetidas y caracteres de control", async () => {
	const tool = await askTool(); const { ctx, customs } = context(() => ["1"]);
	const question = input.questions[0]!;
	for (const [bad, reason] of [
		[{ ...question, options: [question.options[0], { label: "Escribir otra respuesta", description: "x" }] }, /reservada/],
		[{ ...question, options: [question.options[0], question.options[0]] }, /repetidas/],
		[{ ...question, question: "¿Seguro?\x1b[2J" }, /caracteres de control/],
		[{ ...question, header: "Alc‮ance" }, /caracteres de control/],
	] as const) await assert.rejects(run(tool, { questions: [bad] }, ctx), reason);
	assert.equal(customs(), 0);
});

test("omi_ask: es una tool interactiva del modelo, que ni codemode ni un subagente pueden llamar, y guía cuándo usarla", async () => {
	const tool = await askTool();
	assert.equal(tool.exposure, "model-only");
	assert.equal(tool.executionMode, "sequential");
	const guidance = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");
	assert.match(guidance, /recomendada/); assert.match(guidance, /alternativas/);
	assert.match(guidance, /no autoriza/); assert.match(guidance, /confirmaci/);
});

test("omi_ask: el harness la deja activa en toda etapa y una respuesta no vale como acuerdo del chat", async (t) => {
	const state = createWorkflow({ number: 42, title: "Arreglar", url: "https://github.com/test/repo/issues/42", body: "Pedido", hash: "source" }, { root: "/tmp/repo", commonDir: "/tmp/repo/.git", branch: "fix/issue-42", baseCommit: "a".repeat(40) }, "work", "2026-11-18T00:00:00Z");
	for (const phase of ["explore", "decide", "recipe", "approve", "implement", "verify", "pr"] as const) assert.equal(workflowToolAllowed({ ...state, phase }, ASK_TOOL, {}), true, phase);
	const guide = developmentInstructions(state);
	assert.match(guide, /omi_ask/); assert.match(guide, /no es un acuerdo/); assert.match(guide, /omi_workflow ask/, "las inferencias siguen por su camino");
	const f = await developmentFixture(t); await f.start();
	assert.ok(f.activeTools().includes(ASK_TOOL), "el loadout del harness la conserva");
	f.uiControl.questions = () => ["3", ...typed("ampliá el alcance a todo el repo"), KEYS.enter];
	const result = await f.invoke(ASK_TOOL, { questions: [input.questions[0]] });
	assert.equal(result.details && typeof result.details === "object" && "status" in result.details && result.details.status, "answered");
	await assert.rejects(f.action({ action: "agreed", quote: "ampliá el alcance a todo el repo", agreement: "Todo el repo", replan: false }), /no aparece textual/);
	assert.equal((await f.state()).agreements?.length ?? 0, 0);
});
