import assert from "node:assert/strict";
import { test } from "node:test";
import { commandAuthorization, grantKey } from "../src/harness/authorization.ts";
import { createWorkflow, recipeApprovalHash, transition } from "../src/harness/state.ts";
import { sourceHash } from "../src/harness/model.ts";
import { STRICT_POLICY, visibleText, type FoundationsBlock } from "../src/harness/foundations.ts";

const source = { number: 68, title: "Foundations", body: "Pedido", url: "https://github.com/test/repo/issues/68", hash: sourceHash("Foundations", "Pedido") };
const state = () => createWorkflow(source, { root: "/tmp/test", commonDir: "/tmp/.git", branch: "feat/test", baseCommit: "a".repeat(40) }, "work", "now");
const block = (confirmar: string[] = []): FoundationsBlock => ({ version: 2, repo: "test/repo", confirmar, politica: { ...STRICT_POLICY } });
// Con reglas rige la puerta de sintaxis. Sin reglas no pregunta nada: ver el test del 2026-11-24.
const RULES = ["git push *"];
function authorize(command: string, rules = block(RULES), current = state(), accepted = true): string {
	return commandAuthorization(current, command, { block: rules, accepted });
}
const display = (command: string) => visibleText(JSON.stringify(command));
for (const command of ["npm test", "npm  test", "git status --short", "./script.sh a=b", "echo a,b@c:/x%+=_-", "/usr/bin/if arg", "If x"]) {
	test(`authorization v2: sólo línea simple no coincidente auto ${display(command)}`, () => assert.equal(authorize(command), "auto"));
}
const special = ["'", '"', "\\", "\t", "\n", "\r", "\u001b", "\u200b", "\u202e", "\u2028", "\u2029", "\u{E0100}", ";", "&", "|", "<", ">", "(", ")", "{", "}", "[", "]", "$", "`", "*", "?", "~", "!", "#", "é"];
const unsupported = ["", " npm test", "npm test ", "VAR=x npm test", "X=y", "npm test && git push origin main", 'echo "texto"', "echo $(id)", "npm test\ngit push origin main", ...special.map((character) => `echo a${character}b`), ...special.map((character) => `npm test${character}`)];
for (const command of unsupported) test(`authorization v2: sintaxis no simple pide sí intacta ${display(command)}`, () => {
	assert.equal(authorize(command), "ask");
	const original = command;
	assert.equal(command, original);
});
for (const first of ["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "select", "function", "time", "coproc", "eval", "exec", "command", "builtin", "source", "."]) {
	test(`authorization v2: primer token reservado ${first}`, () => assert.equal(authorize(`${first} npm test`), "ask"));
}
// Pedido del dueño (2026-11-24): sin reglas no hay patrón que contrastar, así que lo compuesto tampoco pregunta.
// Un `git push origin main` simple ya corría sin preguntar con la lista vacía: preguntar por lo compuesto no protegía nada.
test("authorization v2: con la lista vacía nada pregunta, tampoco lo compuesto ni lo reservado", () => {
	for (const command of [...unsupported, "if npm test", "eval npm test", "git push origin main"]) assert.equal(authorize(command, block([])), "auto", display(command));
	const current = state(), command = 'echo "texto"';
	const granted = transition(current, { type: "command_granted", key: grantKey(current, command), command }, "now");
	assert.equal(authorize(command, block([]), granted), "grant", "un grant exacto sigue valiendo");
	assert.equal(authorize(command, block([]), current, false), "auto", "sin v2 aceptada, el default");
});
test("authorization v2: patrones son completos sin trim, regex ni canonización de espacios", () => {
	const rules = block(["git push *"]);
	assert.equal(authorize("git push origin main", rules), "ask");
	assert.equal(authorize("git push", rules), "auto");
	assert.equal(authorize("git  push origin main", rules), "auto");
	assert.equal(authorize("Git push origin main", rules), "auto");
	assert.equal(authorize("npm test", rules), "auto");
	assert.equal(authorize("npm test && git push origin main", rules), "ask");
	assert.equal(authorize("git push", block(["git push", "git push *"])), "ask");
});
// Decisión del dueño al integrar #66 con #68: sin una v2 aceptada rige el default de #66, nada pregunta.
test("authorization v2: sin configuración v2 válida aceptada rige el default: nada pregunta, ni lo compuesto", () => {
	for (const command of ["npm test", "npm test && git push origin main", 'echo "texto"']) {
		assert.equal(commandAuthorization(state(), command), "auto", command);
		assert.equal(authorize(command, block(["*"]), state(), false), "auto", `${command}: una v2 no aceptada no vale`);
		for (const invalid of [null, { version: 1, repo: "test/repo", comandos: ["npm test"], politica: { ...STRICT_POLICY, fuera_de_catalogo: "ask" } }, { ...block(["*"]), confirmar: ["bad\\x"] }, { ...block(), confirmar: [""] }]) {
			assert.equal(Reflect.apply(commandAuthorization, undefined, [state(), command, { block: invalid, accepted: true }]), "auto", `${command}: un bloque inválido o v1 no vale`);
		}
		assert.equal(Reflect.apply(commandAuthorization, undefined, [state(), command, { catalog: [], outside: "ask" }]), "auto", `${command}: la forma v1 no vale`);
	}
});
test("authorization v2: ni una receta humana ni Foundations dispensa confirmación por patrón/sintaxis", () => {
	for (const by of ["person", "foundations"] as const) {
		const current = state();
		current.recipe = { classification: { type: "add", size: "small", risk: "high", riskAreas: [], causeKnown: true }, objective: "Test", approach: "Test", scope: [], outOfScope: [], cases: [{ id: "D1", command: "npm test", description: "Test" }, { id: "D2", command: 'echo "texto"', description: "Quote" }], lenses: ["security"], executor: { mode: "inline", writers: 0 }, route: "direct" };
		current.approval = { by, sourceHash: current.source.hash, recipeHash: recipeApprovalHash(current), at: "now" };
		assert.equal(authorize("npm test", block(["npm *"]), current), "ask");
		assert.equal(authorize('echo "texto"', block(RULES), current), "ask");
		assert.equal(authorize("npm test", block(["*"]), current), "ask");
	}
});
test("authorization v2: grant humano exacto por trabajo/pedido sobrevive receta y retoma, no autoriza variantes", () => {
	for (const command of ["npm test", 'echo "texto"', "npm test\nnode x", "git push origin main"]) {
		const current = state();
		const granted = transition(current, { type: "command_granted", key: grantKey(current, command), command }, "now");
		assert.equal(authorize(command, block(["*"]), granted), "grant");
		assert.equal(commandAuthorization(granted, command), "grant", "también sin config válida");
		assert.equal(commandAuthorization(structuredClone(granted), command), "grant", "reload persistido");
		const all = block(["*"]);
		assert.equal(authorize(`${command} --other`, all, granted), "ask");
		assert.equal(authorize(command, all, { ...granted, id: "other" }), "ask");
		assert.equal(authorize(command, all, { ...granted, source: { ...granted.source, hash: "otro pedido" } }), "ask");
		const refreshed = transition(granted, { type: "source_changed", source: granted.source }, "now");
		assert.equal(authorize(command, all, refreshed), "ask");
		const forged = { ...granted, grants: [{ ...granted.grants![0]!, command: "otro comando" }] };
		assert.equal(authorize(command, all, forged), "ask", "también verifica el texto exacto guardado");
	}
});
