// Preguntas de Foundations: construyen un borrador local; el guardado y sus guardas viven fuera de la guía.
import {
	ASK_HELP, AUTO_WARNINGS, DEFAULT_POLICY, MAX_RULES, foundationsDiff, ruleProblem, visibleText,
	type FoundationsBlock, type PolicyMode, type PolicyPoint,
} from "../harness/foundations.ts";
import type { TrustKey } from "../harness/foundations-trust.ts";
import type { AskResult, Question, QuestionAnswer, QuestionBatch } from "./questions/batch.ts";

type Ask = (batch: QuestionBatch) => Promise<AskResult>;
const GUIDE = "Guía Foundations";
const POINTS = [["arranque", "Arranque"], ["receta", "Receta"], ["push_pr", "Push + draft"]] as const satisfies readonly [PolicyPoint, string][];
const KEEP_RULES = "Conservar reglas", EDIT_RULES = "Cambiar reglas";
const REVIEW = "Revisar borrador", ADD = "Agregar regla", REMOVE = "Quitar regla", BACK = "Volver a reglas";
const SAVE = "Guardar", CANCEL = "No guardar";
const ABOUT_RULES = "Un patrón coincidente pide tu sí antes del comando. No es una lista de permisos. Los comandos compuestos también piden el sí.";
const SYNTAX = "Escribí un patrón para la línea completa. * = cualquier texto; ? = un carácter; \\*, \\? y \\\\ son literales.";

function question(id: string, header: string, prompt: string, options: [string, string][], detail?: string): Question {
	return { id, header, question: prompt, options: options.map(([label, description]) => ({ label, description })), multiSelect: false, recommended: true, freeText: false, ...(detail ? { detail } : {}) };
}
const choice = (answers: QuestionAnswer[], id: string) => answers.find((answer) => answer.id === id)?.options[0];
const changeMode = (mode: PolicyMode): PolicyMode => mode === "ask" ? "auto" : "ask";
const optionMode = (keep: boolean, mode: PolicyMode) => `${keep ? "Conservar" : "Cambiar a"} (${mode})`;
const effect = (point: PolicyPoint, mode: PolicyMode) => mode === "ask" ? ASK_HELP[point] : AUTO_WARNINGS[point];

function policyQuestion(point: PolicyPoint, label: string, mode: PolicyMode, notice?: string): Question {
	const other = changeMode(mode);
	return question(point, label, `¿Cómo sigue ${label.toLowerCase()}?`, [
		[optionMode(true, mode), effect(point, mode)], [optionMode(false, other), effect(point, other)],
	], notice);
}

async function individualRule(ask: Ask, rules: string[], index: number | undefined): Promise<boolean> {
	const current = index === undefined ? undefined : rules[index];
	const options: [string, string][] = current === undefined ? [[BACK, "No agrega una regla"]]
		: [["Conservar regla", "Mantiene este patrón exacto"], [REMOVE, "Quita sólo este patrón del borrador"]];
	const q: Question = { ...question("rule", "Regla", current === undefined ? "¿Qué regla querés agregar?" : "¿Qué hacés con esta regla?", options,
		current === undefined ? SYNTAX : `Regla actual: «${visibleText(current)}»\n${SYNTAX}`), freeText: { multiline: false, verbatim: true, validate: (value) =>
		ruleProblem(value) ?? (rules.some((rule, i) => i !== index && rule === value) ? "Ya existe ese patrón exacto" : undefined) } };
	const answer = await ask({ title: `${GUIDE} · ${current === undefined ? "Nueva regla" : "Regla individual"}`, questions: [q] });
	if (answer.status === "cancelled") return false;
	const picked = answer.answers.find((a) => a.id === "rule");
	if (picked?.text) {
		if (index === undefined) rules.push(picked.text);
		else rules[index] = picked.text;
	} else if (index !== undefined && picked?.options[0] === REMOVE) rules.splice(index, 1);
	return true;
}

async function editRules(ask: Ask, rules: string[]): Promise<boolean> {
	while (true) {
		const labels = rules.map((rule, i) => `Regla ${i + 1} · ${visibleText(rule)}`);
		const options: [string, string][] = [[REVIEW, "Ver todas las reglas y políticas antes de guardar"]];
		if (rules.length < MAX_RULES) options.push([ADD, "Escribí el patrón de una sola regla"]);
		options.push(...labels.map((label): [string, string] => [label, "Abrir esta regla para conservarla, cambiarla o quitarla"]));
		const reply = await ask({ title: `${GUIDE} · Reglas`, questions: [question("rules", "Reglas", `¿Qué cambiás en las reglas? (${rules.length}/${MAX_RULES})`, options, ABOUT_RULES)] });
		if (reply.status === "cancelled") return false;
		const picked = choice(reply.answers, "rules");
		if (picked === REVIEW) return true;
		const index = picked !== undefined ? labels.indexOf(picked) : -1;
		if (picked !== ADD && index < 0) return false;
		if (!await individualRule(ask, rules, index < 0 ? undefined : index)) return false;
	}
}

interface GuideInput { key: TrustKey; initial: FoundationsBlock | undefined; previousAccepted: FoundationsBlock | undefined; notice: string | undefined }
export async function guideFoundations({ key, initial, previousAccepted, notice }: GuideInput, ask: Ask): Promise<FoundationsBlock | undefined> {
	const block: FoundationsBlock = initial ? structuredClone(initial) : { version: 2, repo: key.repo, confirmar: [], politica: { ...DEFAULT_POLICY } };
	const first = await ask({ title: `${GUIDE} · ${key.repo}`, questions: [
		...POINTS.map(([point, label], i) => policyQuestion(point, label, block.politica[point], i === 0 ? notice : undefined)),
		question("rules", "Reglas", "¿Conservás las reglas de comandos?", [[KEEP_RULES, "Deja los patrones como están"], [EDIT_RULES, "Permite agregar, cambiar o quitar una regla por vez"]],
			`${ABOUT_RULES}\n${block.confirmar.length ? block.confirmar.map((rule) => `• ${visibleText(rule)}`).join("\n") : "Sin reglas vigentes."}`),
	] });
	if (first.status === "cancelled") return undefined;
	for (const [point] of POINTS) if (choice(first.answers, point) === optionMode(false, changeMode(block.politica[point]))) block.politica[point] = changeMode(block.politica[point]);
	let changeRules = choice(first.answers, "rules") === EDIT_RULES;
	while (true) {
		if (changeRules && !await editRules(ask, block.confirmar)) return undefined;
		const detail = `${foundationsDiff(previousAccepted, block, key)}\nGuardar no ejecuta comandos ni concede grants. Las demás restricciones de OMI siguen vigentes.`;
		const saveHint = block.confirmar.length ? "Guarda y acepta esta configuración" : "Lista vacía: todo comando SIMPLE queda sin confirmación por esta política";
		const accept = { ...question("save", "Guardar", "¿Guardás estas reglas y políticas en la KB?", [[SAVE, saveHint], [BACK, "Vuelve al borrador sin guardar"], [CANCEL, "Sale sin guardar ni aceptar"]], detail), recommended: false };
		const answer = await ask({ title: `${GUIDE} · Resumen`, questions: [accept] });
		if (answer.status === "cancelled") return undefined;
		const picked = choice(answer.answers, "save");
		if (picked === SAVE) return block;
		if (picked !== BACK) return undefined;
		changeRules = true;
	}
}
