import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readWorkflow } from "../src/harness/store.ts";
import { WORKFLOW_TOOLS } from "../src/harness/permissions.ts";
import { readGit } from "../src/tui/workspace/data.ts";
import { issueRegistryDir, readIssuePreparation } from "../src/tui/workspace/issue-registry.ts";
import { holdSessionSwitch, issueDevelopmentTicket, requestDevelopmentBegin, takeDevelopmentTicket } from "../src/tui/development-tickets.ts";
import { beginFixture } from "./helpers/development-begin.ts";
import { ASK_ALL } from "./helpers/foundations.ts";

const KICKOFF = /Continuá el harness de desarrollo/;
const request = { title: "Mostrar el total del carrito", body: "Pedido: mostrar el total con impuestos.\nCriterio: el total coincide con la suma.", reason: "Cambio de código con criterio verificable" };
const simple = { triage: { type: "chore", summary: "Corregir texto", rationale: "Errata local", scope: [], acceptanceCriteria: [], questions: [] }, assessment: { scope: "localized", impact: "documentation", reversible: "yes", verification: "clear", risk: "low", riskAreas: [], rationale: "Una errata sin efectos externos." } };
async function preparation(root: string, number: number) { return readIssuePreparation((await readGit(root))!, number); }
async function workflowOf(root: string, number: number) {
	const record = (await preparation(root, number))!; const git = (await readGit(record.state.worktree))!;
	return readWorkflow({ root: record.state.worktree, commonDir: git.commonDir, branch: record.state.branch, baseCommit: record.state.baseCommit }, number);
}

test("development_begin simple conserva chat/tools sin issue, preparación, sesión ni harness", async (t) => {
	const f = await beginFixture(t); f.remote.requestClassify = JSON.stringify(simple);
	const original = f.current(); const tools = [...original.activeTools]; await f.ask(request);
	assert.equal(f.current(), original); assert.deepEqual(f.current().activeTools, tools);
	assert.deepEqual(f.prompts, []); assert.deepEqual(f.remote.created, []); assert.deepEqual(f.switches, []);
	assert.equal(await preparation(f.root, 43), undefined); assert.equal(f.git("branch", "--list"), "* main");
	assert.equal(f.git("worktree", "list").split("\n").length, 1);
	assert.equal(f.continuations.length, 1); assert.match(f.continuations[0]!.content, /reglas y permisos/);
	assert.match(f.continuations[0]!.content, /chat/); assert.equal(f.kickoffs().length, 0);
	assert.equal(await f.emit("tool_call", { toolName: "read", input: { path: "value.cjs" } }), undefined);
});

test("development_begin needs-info devuelve preguntas al chat sin interpretar la duda como trivialidad", async (t) => {
	const f = await beginFixture(t); f.remote.requestClassify = JSON.stringify({ ...simple, triage: { ...simple.triage, questions: ["¿Qué texto querés corregir?"] } });
	await f.ask(request);
	assert.deepEqual(f.remote.created, []); assert.deepEqual(f.prompts, []); assert.deepEqual(f.switches, []);
	assert.equal(await preparation(f.root, 43), undefined); assert.equal(f.continuations.length, 1);
	assert.match(f.continuations[0]!.content, /Qué texto/); assert.match(f.continuations[0]!.content, /información|ambig/i);
});

for (const failure of ["cancel", "error", "length", "incomplete", "aborted-session"] as const) test(`development_begin clasificación previa ${failure} no deja recursos ni continuación simple`, async (t) => {
	const f = await beginFixture(t);
	if (failure === "cancel") f.remote.cancelClassify = true;
	if (failure === "error") f.remote.failClassify = true;
	if (failure === "length") f.remote.stopReason = "length";
	if (failure === "incomplete") f.remote.requestClassify = JSON.stringify({ triage: simple.triage });
	if (failure === "aborted-session") f.remote.onClassify = async () => { await f.emit("session_shutdown"); };
	await f.ask(request);
	assert.deepEqual(f.remote.created, []); assert.deepEqual(f.prompts, []); assert.deepEqual(f.switches, []); assert.deepEqual(f.continuations, []);
	assert.equal(await preparation(f.root, 43), undefined); assert.equal(f.git("worktree", "list").split("\n").length, 1);
	assert.equal(f.git("branch", "--list"), "* main");
});

test("development_begin el loader dice qué modelo clasifica", async (t) => {
	const f = await beginFixture(t); f.remote.requestClassify = JSON.stringify(simple);
	await f.ask(request);
	assert.deepEqual(f.remote.loaderTitles, ["Clasificando el pedido con mock"]);
});

test("development_begin una clasificación sin respuesta corta a tiempo con un aviso en castellano y no crea nada", async (t) => {
	const f = await beginFixture(t, { classifyTimeoutMs: 30 });
	f.remote.onClassify = (signal) => new Promise<void>((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); });
	await f.ask(request);
	assert.deepEqual(f.remote.created, []); assert.deepEqual(f.prompts, []); assert.deepEqual(f.switches, []); assert.deepEqual(f.continuations, []);
	const notice = f.current().notices.at(-1) ?? "";
	assert.match(notice, /mock no respondió la clasificación en 1 s/); assert.match(notice, /\/omi-model/);
	assert.doesNotMatch(notice, /timed out/i);
	assert.equal(f.current().levels.at(-1), "error");
});

test("development_begin cancelar una clasificación iniciada ignora una respuesta válida tardía", async (t) => {
	const f = await beginFixture(t); let entered!: () => void; let release!: () => void;
	f.remote.classifyStarted = new Promise<void>((resolve) => { entered = resolve; });
	const late = new Promise<void>((resolve) => { release = resolve; });
	f.remote.onClassify = async () => { entered(); await late; }; f.remote.cancelInFlight = true;
	f.remote.requestClassify = JSON.stringify(simple);
	await f.ask(request); assert.equal(f.modelCalls.length, 1, "la llamada comenzó antes de cancelar");
	release(); await f.waitCancelled();
	assert.deepEqual(f.prompts, []); assert.deepEqual(f.remote.created, []); assert.deepEqual(f.continuations, []); assert.deepEqual(f.switches, []);
	assert.equal(await preparation(f.root, 43), undefined); assert.equal(f.git("worktree", "list").split("\n").length, 1);
});

test("development_begin un pedido nuevo del chat crea el issue, el worktree y la sesión con un solo sí y sigue en Explorar", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
	const result = await f.ask(request);
	assert.equal(result.terminate, true, "la tool termina el turno: no concede permisos ni sigue sola");
	assert.equal(f.prompts.length, 1, "una sola confirmación humana"); assert.match(f.prompts[0]!.description, /Mostrar el total del carrito/); assert.match(f.prompts[0]!.description, /test\/repo/);
	const dialog = f.prompts[0]!.description;
	assert.ok(dialog.indexOf("Se crea un issue en test/repo") < dialog.indexOf(request.title) && dialog.indexOf("PR draft") < dialog.indexOf(request.title), "lo que va a pasar se lee antes del cuerpo");
	assert.match(f.prompts[0]!.description, /Criterio: el total coincide/); assert.match(f.prompts[0]!.description, /Cambio de código con criterio verificable/);
	assert.deepEqual(f.remote.created, [{ title: request.title, body: request.body }]);
	assert.deepEqual(f.order.slice(0, 3), ["classify", "confirm", "create"]);
	assert.equal(f.modelCalls.length, 1, "la preparación reutiliza la clasificación previa");
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
	const f = await beginFixture(t, { foundations: ASK_ALL });
	await f.ask({ issue: 42, reason: "La persona nombró el #42" });
	assert.deepEqual(f.remote.created, []); assert.equal(f.modelCalls.length, 1);
	const labelReads = () => f.calls.filter((args) => args.includes("labels")).length;
	assert.equal(labelReads(), 1, "las etiquetas se leen para clasificar");
	const first = (await workflowOf(f.root, 42))!; const record = (await preparation(f.root, 42))!;
	assert.match(f.prompts[0]!.description, /#42/); assert.match(f.prompts[0]!.description, /Corregir resultado/);
	assert.equal(f.current().ctx.cwd, record.state.worktree);
	// De vuelta en el chat del repo principal, se vuelve a pedir el mismo issue.
	await f.openMain(); assert.equal(f.current().ctx.cwd, f.root);
	await f.ask({ issue: 42, reason: "Retomar" });
	assert.deepEqual(f.switches, [record.sessionFile, record.sessionFile], "retoma la misma sesión");
	assert.equal(f.kickoffs().filter((text) => KICKOFF.test(text)).length, 1);
	assert.equal(f.modelCalls.length, 1, "no reclasifica"); assert.deepEqual(f.remote.created, []);
	assert.equal(labelReads(), 1, "retomar no vuelve a pedir las etiquetas: no las usa");
	assert.equal((await workflowOf(f.root, 42))!.id, first.id, "no duplica el trabajo");
	assert.equal(f.prompts.length, 2);
});

test("development_begin decir que no no crea issue, worktree, sesión ni trabajo", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL }); f.remote.confirm = false;
	await f.ask(request);
	assert.equal(f.prompts.length, 1); assert.deepEqual(f.remote.created, []); assert.deepEqual(f.switches, []);
	assert.equal(await preparation(f.root, 43), undefined); assert.equal(f.modelCalls.length, 1, "se clasifica antes de la confirmación rechazada");
	assert.ok(!f.calls.some((args) => args[0] === "issue" && args[1] === "create"));
	assert.deepEqual(f.kickoffs(), []); assert.equal(f.git("worktree", "list").split("\n").length, 1);
});

test("development_begin no hay entrada manual: sin token no pasa nada, el token es de un solo uso y start ya no existe", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
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
	const hidden = ["\u202E", "\u200B", "\u061C", "\u00AD", "\u2066", "\u180E", String.fromCodePoint(0xE0041), String.fromCodePoint(0xE0100)];
	for (const char of hidden) {
		await assert.rejects(f.invoke("omi_work_begin", { title: `Normal${char}oculto`, body: "x", reason: "título" }), /invisibles|dirección/, `título con U+${char.codePointAt(0)!.toString(16)}`);
		await assert.rejects(f.invoke("omi_work_begin", { title: "x", body: `cuerpo${char}oculto`, reason: "cuerpo" }), /invisibles|dirección/, `cuerpo con U+${char.codePointAt(0)!.toString(16)}`);
	}
	await f.invoke("omi_work_begin", { title: "Emoji ❤️ y acentos ñ", body: "Texto común con emoji ✅", reason: "visible" }); await f.emit("agent_settled", { aborted: true }); await f.flush();
	assert.deepEqual(f.calls, [], "validar no consulta GitHub");
	await f.ask({ ...request, body: "é".repeat(40000) });
	assert.equal(f.prompts.length, 0, "un pedido que no entra en el PR draft de GitHub falla antes de preguntar");
	assert.match(f.current().notices.join("\n"), /grande|GitHub/); assert.deepEqual(f.remote.created, []);
});

test("development_begin recargar la sesión del worktree restaura el trabajo sin volver a mandar el arranque", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
	await f.ask({ issue: 42, reason: "Pedido" });
	const kickoffs = f.kickoffs().length; assert.equal(kickoffs, 1);
	await f.reload();
	assert.deepEqual(f.kickoffs(), [], "restaurar no llama al modelo"); assert.ok(f.current().activeTools.includes("omi_workflow"));
	assert.equal(f.prompts.length, 1);
});

test("development_begin si GitHub no confirma la creación, no reintenta y pide revisar antes de volver a pedirlo", async (t) => {
	const f = await beginFixture(t); f.remote.failCreate = true;
	await f.ask(request);
	assert.match(f.current().notices.join("\n"), /revis/i); assert.deepEqual(f.switches, []); assert.equal(f.modelCalls.length, 1);
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
	const unauthenticated = await beginFixture(t, { foundations: ASK_ALL, authenticated: false });
	requestDevelopmentBegin({ sendUserMessage: (text: string) => unauthenticated.current().send(text, { expandPromptTemplates: true }) }, unauthenticated.main.getSessionFile()!, { issue: 42 }); await unauthenticated.flush();
	assert.match(unauthenticated.current().notices.join("\n"), /modelo autenticado/); assert.equal(unauthenticated.prompts.length, 0); assert.deepEqual(unauthenticated.calls, []);
	const f = await beginFixture(t, { foundations: ASK_ALL }); f.remote.confirm = false;
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

test("development_begin una clasificación inválida falla antes de crear el issue o preguntar", async (t) => {
	const f = await beginFixture(t); f.remote.requestClassify = "no es JSON";
	await f.ask(request);
	assert.equal(f.remote.created.length, 0); assert.match(f.current().notices.join("\n"), /clasific|evaluación/i);
	assert.deepEqual(f.prompts, []); assert.deepEqual(f.switches, []); assert.equal(f.git("worktree", "list").split("\n").length, 1);
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
	const busy = await beginFixture(t, { foundations: ASK_ALL, busy: true });
	const token = issueDevelopmentTicket({ kind: "request", origin: "panel", sessionFile: busy.main.getSessionFile()!, request: { issue: 42 } });
	await busy.command(`begin ${token}`);
	assert.match(busy.current().notices.join("\n"), /Esperá a que termine el turno/); assert.equal(busy.prompts.length, 0);
	const f = await beginFixture(t, { foundations: ASK_ALL }); let release!: () => void; f.remote.hold = new Promise((done) => { release = done; }); f.remote.confirm = false;
	const first = f.command(`begin ${issueDevelopmentTicket({ kind: "request", origin: "panel", sessionFile: f.main.getSessionFile()!, request: { issue: 42 } })}`);
	for (let i = 0; i < 50 && !f.prompts.length; i++) await new Promise((done) => setImmediate(done));
	const second = f.command(`begin ${issueDevelopmentTicket({ kind: "request", origin: "panel", sessionFile: f.main.getSessionFile()!, request: { issue: 42 } })}`);
	for (let i = 0; i < 50; i++) await new Promise((done) => setImmediate(done));
	release(); await Promise.all([first, second]);
	assert.equal(f.prompts.length, 1); assert.match(f.current().notices.join("\n"), /Ya hay un arranque en curso/);
});

test("development_begin mientras el pedido espera el sí, el agente no puede seguir con otras tools", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
	await f.invoke("omi_work_begin", request);
	for (const toolName of ["edit", "write", "bash", "read"]) {
		const blocked = await f.emit("tool_call", { toolName, input: { path: "value.cjs" } });
		assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block, `${toolName} queda bloqueada`);
	}
	await f.emit("agent_settled"); await f.flush();
	assert.equal(f.prompts.length, 1);
});

test("development_begin retomar con el pedido editado en GitHub lo contrasta, vuelve a Explorar y no duplica el trabajo", async (t) => {
	const f = await beginFixture(t);
	await f.ask({ issue: 42, reason: "Pedido" });
	const first = (await workflowOf(f.root, 42))!;
	f.remote.issues.set(42, { ...f.remote.issues.get(42)!, title: "Corregir resultado (editado)" });
	await f.openMain(); await f.ask({ issue: 42, reason: "Retomar" });
	const after = (await workflowOf(f.root, 42))!;
	assert.equal(after.id, first.id); assert.ok(after.revision > first.revision, "se registró el cambio del pedido");
	assert.equal(after.source.title, "Corregir resultado (editado)"); assert.equal(after.phase, "explore"); assert.equal(after.approval, null);
	assert.match(f.current().notices.join("\n"), /El pedido cambió/);
});

test("development_begin una preparación anterior al registro se retoma desde su sesión, sin reclasificar ni chocar con su worktree", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
	await f.ask({ issue: 42, reason: "Pedido" });
	const record = (await preparation(f.root, 42))!;
	await rm(join(issueRegistryDir((await readGit(f.root))!), "42.json"));
	await f.openMain(); await f.ask({ issue: 42, reason: "Retomar" });
	assert.match(f.prompts.at(-1)!.title, /Retomar el trabajo del issue #42/, f.current().notices.join("\n"));
	assert.deepEqual(f.switches, [record.sessionFile, record.sessionFile]); assert.equal(f.modelCalls.length, 1, "no reclasifica");
});

test("development_begin una preparación guardada rota falla antes de preguntar", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
	await f.ask({ issue: 42, reason: "Pedido" });
	const record = (await preparation(f.root, 42))!;
	await f.openMain(); await rm(record.sessionFile!);
	await f.ask({ issue: 42, reason: "Retomar" });
	assert.equal(f.prompts.length, 1, "no se pregunta por algo que no se puede retomar"); assert.match(f.current().notices.join("\n"), /Falta la sesión guardada/);
	assert.equal(f.current().ctx.cwd, f.root);
});

test("development_begin retomar un trabajo pausado lo dice en el diálogo y el sí lo reanuda, en el worktree y desde main", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
	await f.ask({ issue: 42, reason: "Pedido" }); await f.command("stop");
	const kickoffs = () => f.kickoffs().filter((text) => KICKOFF.test(text)).length;
	await f.ask({ issue: 42, reason: "Seguir acá" });
	assert.match(f.prompts.at(-1)!.title, /Retomar el trabajo del issue #42/); assert.match(f.prompts.at(-1)!.description, /pausado/); assert.match(f.prompts.at(-1)!.description, /se reanuda/);
	// Igual que /omi-work resume: deja de estar pausado y el bloqueo propio de la etapa lo resuelve el agente.
	assert.notEqual((await workflowOf(f.root, 42))!.status, "paused"); assert.equal(kickoffs(), 2, "el agente sigue después del sí");
	await f.command("stop"); await f.openMain(); await f.ask({ issue: 42, reason: "Seguir desde main" });
	assert.match(f.prompts.at(-1)!.title, /Retomar/); assert.match(f.prompts.at(-1)!.description, /pausado/); assert.match(f.prompts.at(-1)!.description, /se reanuda/);
	assert.notEqual((await workflowOf(f.root, 42))!.status, "paused"); assert.equal(kickoffs(), 1, "sigue en la sesión del worktree");
});

test("development_begin un Esc en el turno del agente descarta el pedido sin preguntar", async (t) => {
	const f = await beginFixture(t);
	await f.invoke("omi_work_begin", request); await f.emit("agent_settled", { aborted: true }); await f.flush();
	assert.equal(f.prompts.length, 0); assert.match(f.current().notices.join("\n"), /Esc/); assert.deepEqual(f.calls, []);
	await f.emit("agent_settled", { aborted: false }); await f.flush();
	assert.equal(f.prompts.length, 0, "el pedido descartado no vuelve en el turno siguiente");
	assert.equal(await f.emit("tool_call", { toolName: "read", input: { path: "value.cjs" } }), undefined, "las tools vuelven a estar disponibles");
});

test("development_begin no arranca mientras otro cambio de sesión está en curso", async (t) => {
	const f = await beginFixture(t, { foundations: ASK_ALL });
	const release = holdSessionSwitch("regreso al repo principal")!; t.after(release);
	assert.equal(holdSessionSwitch("arranque"), undefined, "el cerrojo es exclusivo");
	await f.ask(request);
	assert.match(f.current().notices.join("\n"), /regreso al repo principal en curso/); assert.equal(f.prompts.length, 0); assert.deepEqual(f.calls, []);
	release(); await f.ask({ issue: 42, reason: "Ahora sí" });
	assert.equal(f.prompts.length, 1, "liberado, se puede arrancar");
});

test("development_begin un lock ocupado después de crear el issue se avisa como advertencia, con el número del issue", async (t) => {
	const f = await beginFixture(t); const dir = issueRegistryDir((await readGit(f.root))!);
	await mkdir(dir, { recursive: true }); await writeFile(join(dir, "43.lock"), "{}\n");
	await f.ask(request);
	const index = f.current().notices.findIndex((message) => /#43 ya se creó/.test(message));
	assert.ok(index >= 0, f.current().notices.join("\n")); assert.match(f.current().notices[index]!, /otra ventana/); assert.equal(f.current().levels[index], "warning");
});
