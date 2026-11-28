import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { acceptFoundations, ASK_ALL } from "./helpers/foundations.ts";
import { plainTerminal } from "./helpers/workspace-pty.ts";
import { ptyReport, runPty } from "./helpers/pty-driver.ts";
import { MAX_IDLE_CONTINUATIONS } from "../src/tui/development-continue.ts";

// Cada paso espera lo que la TUI pintó desde su tecla: bajo carga el guion tarda más, no pierde teclas.
// Ctrl+2 (\x1b[50;5u) abre Issues. Después de un Esc, la próxima tecla espera a ver su efecto.
const firstRun = String.raw`
def run():
    failure = os.environ.get('TRIAGE_FAILURE', '')
    wait('chat', lambda: painted('Enter enviar'))
    m = mark(); send(b'\x1b[50;5u')
    wait('issues', lambda: painted('ISSUE_RUNTIME_TRIAGE', m))
    m = mark(); send(b'\r')
    wait('detalle', lambda: painted('iniciar trabajo', m))
    m = mark(); send(b'\r')
    wait('confirmación', lambda: painted('Empezar el trabajo del issue #42', m))
    touch('TRIAGE_CONFIRMED'); m = mark(); send(b'\r')
    if failure:
        wait('clasificando', lambda: exists('TRIAGE_STARTED'))
        if failure == 'cancel':
            m = mark(); send(b'\x1b')
            wait('cancelación', lambda: painted('Clasificación cancelada', m) and closed(m))
        else: wait('formato inválido', lambda: painted('formato válido', m))
        leave('salida sin trabajo'); return
    wait('harness', lambda: exists('TRIAGE_READY') and exists('TRIAGE_REPLY') and painted('PROGRESO'))
    wait('reposo', lambda: status() == 'Listo')
    m = mark(); send(b'/omi-workspace\r')
    wait('ubicación', lambda: opened('Ubicación de trabajo', m))
    # «Listo» tras el Esc: cerró el modal y no hay un turno en curso; Pi no rechaza /reload.
    m = mark(); send(b'\x1b')
    wait('ubicación cerrada', lambda: closed(m))
    m = mark(); send(b'/reload\r')
    # Pi pinta «Reloaded» al terminar, después de devolverle el foco al editor: recién ahí Ctrl+2 no se pierde.
    wait('recarga', lambda: painted('Wait for the current response', m) or (exists('TRIAGE_RELOADED') and painted('Reloaded', m)))
    if painted('Wait for the current response', m): fail('Pi rechazó /reload: el agente seguía respondiendo')
    m = mark(); send(b'\x1b[50;5u')
    wait('issues tras recarga', lambda: painted('[issue-42]', m))
    m = mark(); send(b'\r')
    wait('detalle del worktree', lambda: opened('retomar trabajo', m))
    m = mark(); send(b'\x1b')
    wait('detalle cerrado', lambda: closed(m))
    m = mark(); send(b'\r')
    wait('detalle otra vez', lambda: painted('retomar trabajo', m))
    m = mark(); send(b'\r')
    wait('ya estás', lambda: painted('Ya est', m) and closed(m))
    leave('salida')
`;
const resumeRun = String.raw`
def run():
    wait('chat', lambda: painted('Enter enviar'))
    m = mark(); send(b'\x1b[50;5u')
    wait('issues', lambda: painted('[issue-42]', m) and painted('[Fix]', m))
    m = mark(); send(b'\r')
    wait('detalle', lambda: opened('retomar trabajo', m))
    # Haber abierto el detalle no debe reemplazar la sesión de main.
    if exists('TRIAGE_RESUME_READY'): fail('Se retomó antes del segundo Enter')
    m = mark(); send(b'\x1b')
    wait('detalle cerrado', lambda: closed(m))
    hold(0.3)
    if exists('TRIAGE_RESUME_READY'): fail('Esc cambió la sesión')
    m = mark(); send(b'\r')
    wait('detalle otra vez', lambda: painted('retomar trabajo', m))
    m = mark(); send(b'\r')
    wait('confirmación', lambda: painted('Retomar el trabajo del issue #42', m))
    # Sin el sí no se cambia de sesión.
    if exists('TRIAGE_RESUME_READY'): fail('Se retomó antes de confirmar')
    touch('TRIAGE_RESUME_ENTER'); send(b'\r')
    wait('retomado', lambda: exists('TRIAGE_RESUME_READY') and exists('TRIAGE_RESUME_REPLY'))
    wait('reposo', lambda: status() == 'Listo')
    leave('salida')
`;
/** Lo que tardan a propósito la última continuación y la recarga: el guion no depende de que sean rápidas. */
const SLOW_MS = 2500;
function chunk(delta: unknown, finish: string | null): string {
	return `data: ${JSON.stringify({ id: "triage", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 128, completion_tokens: 128, total_tokens: 256 } } : {}) })}\n\n`;
}

for (const mode of ["ready", "cancel", "invalid"] as const) test(`workspace_begin real · ${mode}: Enter en Issues pide el sí, Esc cancela la clasificación y sólo un resultado válido crea el worktree y arranca el harness`, { skip: process.platform === "win32", timeout: 300_000 }, async (t) => {
	const home = await tempDir(t); const root = join(home, "repo"); const agent = join(home, ".omi/agent"); const bin = join(home, "bin");
	for (const path of [root, agent, bin]) await mkdir(path, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	// Sin Foundations el arranque no pregunta: arranque ask, aceptado localmente, para probar el sí.
	git("remote", "add", "origin", "https://github.com/test/repo.git"); await acceptFoundations(join(agent, "foundations"), ASK_ALL);
	// El probe escribe en el worktree al abrirse: ignorado, para que el harness lo encuentre limpio.
	await writeFile(join(root, "main.txt"), "MAIN_ONLY\n"); await writeFile(join(root, ".gitignore"), "worktree-only.txt\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main");
	const main = git("rev-parse", "main"); await writeFile(join(root, "local.txt"), "LOCAL_UNCOMMITTED\n");
	await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst args = process.argv.slice(2); console.log(JSON.stringify(args[0] === 'issue' ? args[1] === 'list' ? [{number:42,title:'ISSUE_RUNTIME_TRIAGE',url:'https://github.com/test/repo/issues/42',labels:[{name:'bug'}],author:{login:'ada'}}] : {number:42,title:'ISSUE_RUNTIME_TRIAGE',url:'https://github.com/test/repo/issues/42',labels:[{name:'bug'}],body:'Fix the broken filter'} : args[0] === 'run' ? [] : {currentBranch:null}));\n`, { mode: 0o755 });
	const ready = join(home, "ready"); const reloaded = join(home, "reloaded"); const confirmed = join(home, "confirmed"); const reply = join(home, "reply"); const started = join(home, "started"); const resumeReply = join(home, "resume-reply");
	const extension = join(home, "probe.ts"); const worktree = join(home, "repo-worktrees/issue-42");
	await writeFile(extension, `import {appendFile,writeFile} from 'node:fs/promises';
export default function(pi) { pi.on('session_start', async (event,ctx) => {
 if (ctx.cwd !== ${JSON.stringify(worktree)}) return;
 await appendFile(${JSON.stringify(join(home, "session-starts"))}, event.reason + '\\n');
 if (process.env.TRIAGE_RESUME_READY) await writeFile(process.env.TRIAGE_RESUME_READY, JSON.stringify({cwd:ctx.cwd,session:ctx.sessionManager.getSessionFile()}));
 await writeFile(ctx.cwd + '/worktree-only.txt', 'WORKTREE_READ_OK');
 await writeFile(event.reason === 'reload' ? ${JSON.stringify(reloaded)} : ${JSON.stringify(ready)}, JSON.stringify({cwd:ctx.cwd,session:ctx.sessionManager.getSessionFile()}));
 // Una recarga lenta: el workspace de OMI, que carga después de esta sonda, arranca ${SLOW_MS} ms más tarde.
 if (event.reason === 'reload') await new Promise((done) => setTimeout(done, ${SLOW_MS}));
}); }\n`);
	// La continuación de OMI llega como último mensaje; se cuenta aparte de la secuencia del flujo.
	const requests: string[] = []; const continuations: string[] = []; let confirmedFirst = false;
	const continuation = (request: string) => JSON.stringify((JSON.parse(request) as { messages?: unknown[] }).messages?.at(-1) ?? "").includes("nadie lo pausó");
	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { request.resume(); response.writeHead(404); response.end(); return; }
		let body = ""; request.on("data", (data: Buffer) => { body += data; });
		request.on("end", async () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (continuation(body)) {
				// El modelo vuelve a cortar en Explorar: OMI retoma dos veces y frena. Recién ahí terminó el turno.
				continuations.push(body);
				const send = () => response.end(chunk({ role: "assistant", content: "CONTINUE_OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
				// El aviso llega antes que la respuesta, que tarda: el fin del turno lo dice la TUI, no el mock.
				if (continuations.length === MAX_IDLE_CONTINUATIONS) { await writeFile(reply, "done"); setTimeout(send, SLOW_MS); return; }
				send();
				if (continuations.length === 2 * MAX_IDLE_CONTINUATIONS) await writeFile(resumeReply, "done");
				return;
			}
			requests.push(body);
			if (requests.length === 1) {
				try { await access(confirmed); confirmedFirst = true; } catch { /* clasificó sin el sí */ }
				await writeFile(started, "ready");
				const result = { type: mode === "invalid" ? "unknown" : "fix", summary: "Corregir el filtro roto", rationale: "El issue describe un bug", scope: ["Revisar el filtro"], acceptanceCriteria: ["El filtro funciona"], questions: [] };
				const send = () => response.end(chunk({ role: "assistant", content: JSON.stringify(result) }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
				// Con cancel no responde: sólo el Esc termina la clasificación, sin carrera contra un plazo.
				if (mode !== "cancel") send();
			} else if (requests.length === 2) {
				response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "worktree-only.txt" }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
			} else if (requests.length === 3) response.end(chunk({ role: "assistant", content: "WORKTREE_PROBE_COMPLETED" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			else response.end(chunk({ role: "assistant", content: "RESUME_KICKOFF_DONE" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl, api: "openai-completions", apiKey: "test-not-a-key", models: [{ id: "triage", name: "Test triage", contextWindow: 200000, maxTokens: 8192 }] } } }));
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const run = (body: string, totalSeconds: number, extra: NodeJS.ProcessEnv = {}) => runPty(body, process.execPath, [binary, "--provider", "mock", "--model", "triage", "--no-extensions", "--extension", extension, "--no-context-files", "--no-skills", "--approve"], {
		cwd: root, totalSeconds, env: { ...process.env, HOME: home, OMI_HOME: "", PATH: bin + delimiter + process.env.PATH, TRIAGE_READY: ready, TRIAGE_RELOADED: reloaded, TRIAGE_CONFIRMED: confirmed, TRIAGE_REPLY: reply, TRIAGE_RESUME_REPLY: resumeReply, TRIAGE_FAILURE: mode === "ready" ? "" : mode, TRIAGE_STARTED: started, ...extra },
	});
	const result = await run(firstRun, 120);
	const plain = plainTerminal(result.output);
	// El guion recorrió todo el flujo de su modo y la TUI salió limpia.
	assert.equal(result.result, "fin", ptyReport(result)); assert.equal(result.phase, mode === "ready" ? "salida" : "salida sin trabajo", ptyReport(result));
	assert.equal(result.code, 0, ptyReport(result));
	assert.equal(confirmedFirst, true, "no se clasifica antes del sí");
	if (mode !== "ready") {
		assert.equal(requests.length, 1, plain); await assert.rejects(access(worktree)); await assert.rejects(access(ready));
		assert.equal(git("branch", "--show-current"), "main"); assert.equal(git("branch", "--list"), "* main");
		assert.equal(await readFile(join(root, "local.txt"), "utf8"), "LOCAL_UNCOMMITTED\n");
		if (mode === "invalid") assert.match(plain, /formato válido/);
		assert.doesNotMatch(plain, /Extension error|TypeError|exceeds terminal width|Stale extension/); return;
	}
	assert.equal(requests.length, 3, plain);
	assert.equal(continuations.length, MAX_IDLE_CONTINUATIONS, "el modelo cortó en Explorar: OMI retomó dos veces y frenó");
	assert.ok(!JSON.parse(requests[0]!).tools?.length, "el clasificador no recibe tools");
	// Con el sí, el harness arranca solo en la sesión del worktree, con sus tools y sin shell ni escrituras.
	assert.match(requests[1]!, /Continuá el harness de desarrollo/);
	const tools = (JSON.parse(requests[1]!).tools as { function: { name: string } }[]).map((tool) => tool.function.name);
	for (const name of ["read", "omi_workflow", "omi_workflow_check"]) assert.ok(tools.includes(name), name);
	for (const name of ["bash", "write", "edit", "omi_work_begin"]) assert.ok(!tools.includes(name), `${name} no se ofrece en Explorar`);
	// worktree-only.txt existe sólo en el worktree: leerlo prueba que el agente trabaja ahí y no en main.
	assert.match(requests[2]!, /WORKTREE_READ_OK/); await assert.rejects(access(join(root, "worktree-only.txt")));
	for (const marker of [ready, reloaded]) { const state = JSON.parse(await readFile(marker, "utf8")); assert.equal(state.cwd, worktree); assert.match(await readFile(state.session, "utf8"), /omi-issue-triage/); }
	assert.equal(git("branch", "--show-current"), "main"); assert.equal(git("rev-parse", "main"), main); assert.equal(await readFile(join(root, "local.txt"), "utf8"), "LOCAL_UNCOMMITTED\n");
	assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(), "fix/issue-42-issue-runtime-triage");
	for (const expected of [/PROGRESO · #42/, /Tipo: Fix/, /Worktree/, /WORKTREE_PROBE_COMPLETED/, /Ubicación de trabajo/]) assert.match(plain, expected);
	assert.match(plain, /Enter retomar trabajo/); assert.match(plain, /Ya estás trabajando en el issue #42/);
	assert.equal((await readFile(join(home, "session-starts"), "utf8")).trim(), "resume\nreload", "retomar la sesión actual no dispara un nuevo session_start");
	const record = JSON.parse(await readFile(join(root, ".git/omi/issue-workspaces/42.json"), "utf8"));
	const sessionFile = record.sessionFile as string; const conversation = await readFile(sessionFile, "utf8");
	await writeFile(join(worktree, "keep-uncommitted.txt"), "NO PISAR AL RETOMAR\n");
	const resumedReady = join(home, "resumed-ready"); const resumed = await run(resumeRun, 90, { TRIAGE_RESUME_READY: resumedReady, TRIAGE_RESUME_ENTER: join(home, "resume-enter") });
	assert.equal(resumed.result, "fin", ptyReport(resumed)); assert.equal(resumed.phase, "salida", ptyReport(resumed)); assert.equal(resumed.code, 0, ptyReport(resumed));
	const resumedPlain = plainTerminal(resumed.output);
	assert.deepEqual(JSON.parse(await readFile(resumedReady, "utf8")), { cwd: worktree, session: sessionFile });
	assert.equal(requests.length, 4, "retomar desde main no vuelve a clasificar: sólo sigue el trabajo");
	assert.equal(continuations.length, 2 * MAX_IDLE_CONTINUATIONS, "al retomar, el tope vuelve a empezar");
	assert.match(requests[3]!, /Continuá el harness de desarrollo/);
	const after = await readFile(sessionFile, "utf8"); assert.ok(after.startsWith(conversation), "la conversación guardada se conserva");
	const added = after.slice(conversation.length);
	assert.equal(added.match(/Continuá el harness de desarrollo/g)?.length, 1, "retomar agrega sólo el kickoff"); assert.doesNotMatch(added, /omi-issue-triage|omi\.issue-triage/, "ni otro triage ni otra clasificación"); assert.equal(await readFile(join(worktree, "keep-uncommitted.txt"), "utf8"), "NO PISAR AL RETOMAR\n");
	assert.equal((await readdir(join(sessionFile, ".."))).filter((file) => file.endsWith(".jsonl")).length, 1);
	assert.equal(git("branch", "--show-current"), "main"); assert.equal(git("rev-parse", "main"), main); assert.equal(await readFile(join(root, "local.txt"), "utf8"), "LOCAL_UNCOMMITTED\n");
	assert.match(resumedPlain, /Enter retomar trabajo/); assert.match(resumedPlain, /Retomar el trabajo del issue #42/); assert.match(resumedPlain, /RESUME_KICKOFF_DONE/);
	assert.doesNotMatch(plain + resumedPlain, /Extension error|TypeError|exceeds terminal width|Stale extension/);
});
