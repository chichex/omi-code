import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readWorkflow } from "../src/harness/store.ts";
import { WORKFLOW_TOOLS } from "../src/harness/permissions.ts";
import { readGit } from "../src/tui/workspace/data.ts";
import { readIssuePreparation } from "../src/tui/workspace/issue-registry.ts";
import { issueDevelopmentTicket, requestDevelopmentBegin, takeDevelopmentTicket } from "../src/tui/development-tickets.ts";
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
	const dialog = f.prompts[0]!.description;
	assert.ok(dialog.indexOf("Se crea un issue en test/repo") < dialog.indexOf(request.title) && dialog.indexOf("PR draft") < dialog.indexOf(request.title), "lo que va a pasar se lee antes del cuerpo");
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
	// Si el arranque no llega a correr (cambio cancelado, /resume offline), la sesión no invita a editar sin harness.
	assert.match(conversation, /No cambies código fuera del harness/); assert.doesNotMatch(conversation, /Sigue el harness de desarrollo en Explorar/);
});

test("development_begin con un issue existente no crea otro, y volver a pedirlo retoma sin reclasificar ni duplicar", async (t) => {
	const f = await beginFixture(t);
	await f.ask({ issue: 42, reason: "La persona nombró el #42" });
	assert.deepEqual(f.remote.created, []); assert.equal(f.modelCalls.length, 1);
	const first = (await workflowOf(f.root, 42))!; const record = (await preparation(f.root, 42))!;
	assert.match(f.prompts[0]!.description, /#42/); assert.match(f.prompts[0]!.description, /Corregir resultado/);
	assert.equal(f.current().ctx.cwd, record.state.worktree);
	// De vuelta en el chat del repo principal, se vuelve a pedir el mismo issue.
	await f.openMain(); assert.equal(f.current().ctx.cwd, f.root);
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
	const foreign = issueDevelopmentTicket({ kind: "request", origin: "agent", sessionFile: join(f.home, "otra.jsonl"), request: { issue: 42 } });
	await f.command(`begin ${foreign}`);
	assert.equal(f.prompts.length, 1, "un token de otra sesión no sirve acá"); assert.equal(takeDevelopmentTicket(foreign, join(f.home, "otra.jsonl")), undefined, "y queda consumido");
	await f.command(`begin ${issueDevelopmentTicket({ kind: "start", sessionFile: f.main.getSessionFile()!, issue: 42 })}`);
	assert.match(f.current().notices.at(-1)!, /no corresponde al issue autorizado/); assert.deepEqual(f.switches, []); assert.deepEqual(f.kickoffs(), []);
});

test("development_begin la tool sólo se ofrece fuera del harness y valida el pedido antes de preguntar", async (t) => {
	const f = await beginFixture(t);
	assert.ok(f.current().activeTools.includes("omi_work_begin"), "el chat normal ofrece empezar");
	for (const name of WORKFLOW_TOOLS) assert.ok(!f.current().activeTools.includes(name), `${name} sigue inactiva fuera del harness`);
	const tool = f.current().tools.get("omi_work_begin")!;
	assert.match(tool.description, /vale la pena/); assert.ok(tool.promptGuidelines?.some((line) => /trivial/.test(line)));
	for (const input of [{ reason: "nada" }, { issue: 42, title: "x", body: "y", reason: "ambos" }, { title: "sin cuerpo", reason: "falta body" }]) await assert.rejects(f.invoke("omi_work_begin", input), /Pasá issue con el número de un issue existente/);
	for (const input of [{ title: "Normal\u202Eoculto", body: "x", reason: "bidi" }, { title: "x", body: "cuerpo\u200Bcon ancho cero", reason: "ancho cero" }]) await assert.rejects(f.invoke("omi_work_begin", input), /invisibles|dirección/);
	assert.deepEqual(f.calls, [], "validar no consulta GitHub");
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

test("development_begin si GitHub no confirma la creación, no reintenta y pide revisar antes de volver a pedirlo", async (t) => {
	const f = await beginFixture(t); f.remote.failCreate = true;
	await f.ask(request);
	assert.match(f.current().notices.join("\n"), /revis/i); assert.deepEqual(f.switches, []); assert.equal(f.modelCalls.length, 0);
	assert.equal(f.calls.filter((args) => args[0] === "issue" && args[1] === "create").length, 1, "no reintenta solo");
});

for (const [name, options, expected] of [
	["sin confianza", { trusted: false }, /confianza/], ["sin sesión persistente", { persistent: false }, /persistente/],
	["offline", { args: ["--offline"] }, /offline/], ["sin modelo autenticado", { authenticated: false }, /modelo autenticado/],
] as const) test(`development_begin ${name}: ni un pedido nuevo ni retomar un issue preguntan ni tocan GitHub`, async (t) => {
	const f = await beginFixture(t, options);
	for (const input of [request, { issue: 42, reason: "Retomar" }]) await assert.rejects(f.ask(input), expected, "el agente recibe el motivo y se lo dice a la persona");
	assert.equal(f.prompts.length, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.switches, []);
	assert.equal(f.current().ctx.cwd, f.root, "sigue en el chat del repo principal");
});

test("development_begin el panel usa las mismas guardas y su origen se muestra como de la persona, no del agente", async (t) => {
	const unauthenticated = await beginFixture(t, { authenticated: false });
	requestDevelopmentBegin({ sendUserMessage: (text: string) => unauthenticated.current().send(text, { expandPromptTemplates: true }) }, unauthenticated.main.getSessionFile()!, { issue: 42 }); await unauthenticated.flush();
	assert.match(unauthenticated.current().notices.join("\n"), /modelo autenticado/); assert.equal(unauthenticated.prompts.length, 0); assert.deepEqual(unauthenticated.calls, []);
	const f = await beginFixture(t); f.remote.confirm = false;
	requestDevelopmentBegin({ sendUserMessage: (text: string) => f.current().send(text, { expandPromptTemplates: true }) }, f.main.getSessionFile()!, { issue: 42 }); await f.flush();
	assert.match(f.prompts[0]!.description, /panel de Issues/); assert.doesNotMatch(f.prompts[0]!.description, /Motivo del agente/);
});

test("development_begin lo que se puede comprobar sin efectos falla antes del sí: main local y un worktree ajeno", async (t) => {
	const noMain = await beginFixture(t, { noMain: true });
	await noMain.ask(request);
	assert.match(noMain.current().notices.join("\n"), /main local/); assert.equal(noMain.prompts.length, 0); assert.deepEqual(noMain.remote.created, []);
	const f = await beginFixture(t); await mkdir(join(`${f.root}-worktrees`, "issue-42"), { recursive: true });
	await f.ask({ issue: 42, reason: "Pedido" });
	assert.match(f.current().notices.join("\n"), /Ya existe/); assert.equal(f.prompts.length, 0); assert.equal(f.modelCalls.length, 0);
});

test("development_begin si algo falla después de crear el issue, el aviso trae su número para no duplicarlo", async (t) => {
	const f = await beginFixture(t); f.remote.classify = "no es JSON";
	await f.ask(request);
	assert.deepEqual(f.remote.created.length, 1); assert.match(f.current().notices.join("\n"), /#43 ya se creó/);
	assert.deepEqual(f.switches, []); assert.equal(f.git("worktree", "list").split("\n").length, 1);
});

test("development_begin un cambio de sesión cancelado conserva la preparación, avisa y no arranca nada", async (t) => {
	const f = await beginFixture(t); f.remote.cancelSwitch = true;
	await f.ask({ issue: 42, reason: "Pedido" });
	const record = (await preparation(f.root, 42))!;
	assert.equal(record.phase, "ready"); assert.deepEqual(f.switches, [record.sessionFile]);
	assert.match(f.current().notices.join("\n"), /Cambio de sesión cancelado/); assert.deepEqual(f.kickoffs(), []); assert.equal(f.current().ctx.cwd, f.root);
	f.remote.cancelSwitch = false; await f.ask({ issue: 42, reason: "Otra vez" });
	assert.equal(f.modelCalls.length, 1, "volver a pedirlo retoma sin reclasificar"); assert.equal(f.kickoffs().filter((text) => KICKOFF.test(text)).length, 1);
});

test("development_begin con el agente trabajando no se arranca, y un segundo arranque espera al primero", async (t) => {
	const busy = await beginFixture(t, { busy: true });
	const token = issueDevelopmentTicket({ kind: "request", origin: "panel", sessionFile: busy.main.getSessionFile()!, request: { issue: 42 } });
	await busy.command(`begin ${token}`);
	assert.match(busy.current().notices.join("\n"), /Esperá a que termine el turno/); assert.equal(busy.prompts.length, 0);
	const f = await beginFixture(t); let release!: () => void; f.remote.hold = new Promise((done) => { release = done; }); f.remote.confirm = false;
	const first = f.command(`begin ${issueDevelopmentTicket({ kind: "request", origin: "panel", sessionFile: f.main.getSessionFile()!, request: { issue: 42 } })}`);
	for (let i = 0; i < 50 && !f.prompts.length; i++) await new Promise((done) => setImmediate(done));
	const second = f.command(`begin ${issueDevelopmentTicket({ kind: "request", origin: "panel", sessionFile: f.main.getSessionFile()!, request: { issue: 42 } })}`);
	for (let i = 0; i < 50; i++) await new Promise((done) => setImmediate(done));
	release(); await Promise.all([first, second]);
	assert.equal(f.prompts.length, 1); assert.match(f.current().notices.join("\n"), /Ya hay un arranque en curso/);
});

test("development_begin mientras el pedido espera el sí, el agente no puede seguir con otras tools", async (t) => {
	const f = await beginFixture(t);
	await f.invoke("omi_work_begin", request);
	for (const toolName of ["edit", "write", "bash", "read"]) {
		const blocked = await f.emit("tool_call", { toolName, input: { path: "value.cjs" } });
		assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block, `${toolName} queda bloqueada`);
	}
	await f.emit("agent_settled"); await f.flush();
	assert.equal(f.prompts.length, 1);
});
