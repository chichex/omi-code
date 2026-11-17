import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import { readWorkflow } from "../src/harness/store.ts";
import { WORKFLOW_TOOLS } from "../src/harness/permissions.ts";
import { readGit } from "../src/tui/workspace/data.ts";
import { readIssuePreparation } from "../src/tui/workspace/issue-registry.ts";
import { requestDevelopmentBegin } from "../src/tui/development-tickets.ts";
import { beginFixture } from "./helpers/development-begin.ts";

const KICKOFF = /Continuá el harness de desarrollo/;
const request = { title: "Mostrar el total del carrito", body: "Pedido: mostrar el total con impuestos.\nCriterio: el total coincide con la suma.", reason: "Cambio de código con criterio verificable" };
async function preparation(root: string, number: number) { return readIssuePreparation((await readGit(root))!, number); }
async function workflowOf(root: string, number: number) {
	const record = (await preparation(root, number))!; const git = (await readGit(record.state.worktree))!;
	return readWorkflow({ root: record.state.worktree, commonDir: git.commonDir, branch: record.state.branch, baseCommit: record.state.baseCommit }, number);
}

test("development_begin un pedido nuevo del chat crea el issue, el worktree y la sesión con un solo sí y sigue en Explorar", async (t) => {
	const f = await beginFixture(t);
	const result = await f.ask(request);
	assert.equal(result.terminate, true, "la tool termina el turno: no concede permisos ni sigue sola");
	assert.equal(f.prompts.length, 1, "una sola confirmación humana"); assert.match(f.prompts[0]!.description, /Mostrar el total del carrito/); assert.match(f.prompts[0]!.description, /test\/repo/);
	assert.match(f.prompts[0]!.description, /Criterio: el total coincide/); assert.match(f.prompts[0]!.description, /Cambio de código con criterio verificable/);
	assert.deepEqual(f.remote.created, [{ title: request.title, body: request.body }]);
	const record = (await preparation(f.root, 43))!;
	assert.equal(record.phase, "ready"); await access(record.state.worktree);
	assert.deepEqual(f.switches, [record.sessionFile]); assert.equal(f.current().ctx.cwd, record.state.worktree);
	const workflow = (await workflowOf(f.root, 43))!;
	assert.equal(workflow.phase, "explore"); assert.equal(workflow.source.title, request.title);
	assert.equal(f.kickoffs().filter((text) => KICKOFF.test(text)).length, 1, "el agente sigue en la sesión nueva");
	assert.ok(f.current().activeTools.includes("omi_workflow")); assert.ok(!f.current().activeTools.includes("omi_work_begin"), "con el harness activo no se empieza otro trabajo");
	const conversation = await readFile(record.sessionFile!, "utf8");
	assert.doesNotMatch(conversation, /No implementar hasta mi próxima indicación/); assert.doesNotMatch(conversation, /Pedido en el chat principal/);
});

test("development_begin con un issue existente no crea otro, y volver a pedirlo retoma sin reclasificar ni duplicar", async (t) => {
	const f = await beginFixture(t);
	await f.ask({ issue: 42, reason: "La persona nombró el #42" });
	assert.deepEqual(f.remote.created, []); assert.equal(f.modelCalls.length, 1);
	const first = (await workflowOf(f.root, 42))!; const record = (await preparation(f.root, 42))!;
	assert.match(f.prompts[0]!.description, /#42/); assert.match(f.prompts[0]!.description, /Corregir resultado/);
	assert.equal(f.current().ctx.cwd, record.state.worktree);
	// De vuelta en el chat del repo principal, se vuelve a pedir el mismo issue.
	await f.openMain();
	await f.ask({ issue: 42, reason: "Retomar" });
	assert.deepEqual(f.switches, [record.sessionFile, record.sessionFile], "retoma la misma sesión");
	assert.equal(f.kickoffs().filter((text) => KICKOFF.test(text)).length, 1);
	assert.equal(f.modelCalls.length, 1, "no reclasifica"); assert.deepEqual(f.remote.created, []);
	assert.equal((await workflowOf(f.root, 42))!.id, first.id, "no duplica el trabajo");
	assert.equal(f.prompts.length, 2);
});

test("development_begin decir que no no crea issue, worktree, sesión ni trabajo", async (t) => {
	const f = await beginFixture(t); f.remote.confirm = false;
	await f.ask(request);
	assert.equal(f.prompts.length, 1); assert.deepEqual(f.remote.created, []); assert.deepEqual(f.switches, []);
	assert.equal(await preparation(f.root, 43), undefined); assert.equal(f.modelCalls.length, 0);
	assert.ok(!f.calls.some((args) => args[0] === "issue" && args[1] === "create"));
	assert.deepEqual(f.kickoffs(), []); assert.equal(f.git("worktree", "list").split("\n").length, 1);
});

test("development_begin no hay entrada manual: sin token no pasa nada, el token es de un solo uso y start ya no existe", async (t) => {
	const f = await beginFixture(t);
	for (const input of ["begin", "begin 00000000-0000-0000-0000-000000000000", "start"]) await f.command(input);
	assert.equal(f.prompts.length, 0); assert.deepEqual(f.switches, []); assert.deepEqual(f.remote.created, []);
	assert.match(f.current().notices.join("\n"), /Uso: \/omi-work resume/); assert.doesNotMatch(f.current().notices.join("\n"), /\bstart\b/);
	requestDevelopmentBegin({ sendUserMessage: (text: string) => { f.current().send(text, { expandPromptTemplates: true }); } }, f.main.getSessionFile()!, { issue: 42 });
	const dispatched = f.current().sent.at(-1)!.text; f.remote.confirm = false; await f.flush();
	assert.equal(f.prompts.length, 1, "el panel de Issues usa el mismo flujo y su confirmación");
	f.current().send(dispatched, { expandPromptTemplates: true }); await f.flush();
	assert.equal(f.prompts.length, 1, "un token ya usado no vuelve a pedir ni arrancar");
});

test("development_begin la tool sólo se ofrece fuera del harness y valida el pedido antes de preguntar", async (t) => {
	const f = await beginFixture(t);
	assert.ok(f.current().activeTools.includes("omi_work_begin"), "el chat normal ofrece empezar");
	for (const name of WORKFLOW_TOOLS) assert.ok(!f.current().activeTools.includes(name), `${name} sigue inactiva fuera del harness`);
	const tool = f.current().tools.get("omi_work_begin")!;
	assert.match(tool.description, /vale la pena/); assert.ok(tool.promptGuidelines?.some((line) => /trivial/.test(line)));
	for (const input of [{ reason: "nada" }, { issue: 42, title: "x", body: "y", reason: "ambos" }, { title: "sin cuerpo", reason: "falta body" }]) await assert.rejects(f.invoke("omi_work_begin", input), /issue|title|body/);
	await f.ask({ ...request, body: "é".repeat(40000) });
	assert.equal(f.prompts.length, 0, "un pedido que no entra en un comentario de GitHub falla antes de preguntar");
	assert.match(f.current().notices.join("\n"), /grande|GitHub/); assert.deepEqual(f.remote.created, []);
});

test("development_begin recargar la sesión del worktree restaura el trabajo sin volver a mandar el arranque", async (t) => {
	const f = await beginFixture(t);
	await f.ask({ issue: 42, reason: "Pedido" });
	const kickoffs = f.kickoffs().length; assert.equal(kickoffs, 1);
	await f.reload();
	assert.deepEqual(f.kickoffs(), [], "restaurar no llama al modelo"); assert.ok(f.current().activeTools.includes("omi_workflow"));
	assert.equal(f.prompts.length, 1);
});

test("development_begin un issue creado sin confirmar no se duplica: falla y pide revisar GitHub", async (t) => {
	const f = await beginFixture(t); f.remote.failCreate = true;
	await f.ask(request);
	assert.match(f.current().notices.join("\n"), /revis/i); assert.deepEqual(f.switches, []); assert.equal(f.modelCalls.length, 0);
	assert.equal(f.calls.filter((args) => args[0] === "issue" && args[1] === "create").length, 1, "no reintenta solo");
});

for (const [name, options, expected] of [
	["sin confianza", { trusted: false }, /confianza/], ["sin sesión persistente", { persistent: false }, /persistente/],
	["offline", { args: ["--offline"] }, /offline/], ["sin modelo autenticado", { authenticated: false }, /modelo autenticado/],
] as const) test(`development_begin ${name}: no pregunta ni toca GitHub`, async (t) => {
	const f = await beginFixture(t, options);
	await assert.rejects(f.ask(request), expected, "el agente recibe el motivo y se lo dice a la persona");
	assert.equal(f.prompts.length, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.switches, []);
	assert.equal(f.current().ctx.cwd, f.root, "sigue en el chat del repo principal");
});
