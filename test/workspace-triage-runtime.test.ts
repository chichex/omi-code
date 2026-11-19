import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { acceptFoundations, ASK_ALL } from "./helpers/foundations.ts";
import { plainTerminal } from "./helpers/workspace-pty.ts";

const driver = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 150, 0, 0))
os.kill(pid, signal.SIGWINCH)
start, phase, phase_at, mark, output = time.monotonic(), 0, 0, 0, b''
failure = os.environ.get('TRIAGE_FAILURE', '')
while time.monotonic() - start < 32:
    elapsed = time.monotonic() - start
    if phase == 0 and b'Enter enviar' in output:
        os.write(fd, b'\\x1b[50;5u'); phase = 1
    elif phase == 1 and b'ISSUE_RUNTIME_TRIAGE' in output:
        os.write(fd, b'\\r'); phase = 2
    elif phase == 2 and b'iniciar trabajo' in output:
        os.write(fd, b'\\r'); phase, mark = 3, len(output)
    elif phase == 3 and b'Empezar el trabajo del issue #42' in output[mark:]:
        open(os.environ['TRIAGE_CONFIRMED'], 'w').close()
        os.write(fd, b'\\r'); phase = 4
    elif phase == 4 and failure == 'cancel' and os.path.exists(os.environ['TRIAGE_STARTED']):
        os.write(fd, b'\\x1b'); phase, phase_at = 20, elapsed
    elif phase == 4 and failure == 'invalid' and os.path.exists(os.environ['TRIAGE_STARTED']):
        phase, phase_at = 20, elapsed
    elif phase == 20 and elapsed - phase_at > (1.0 if failure == 'invalid' else 0.5):
        os.write(fd, b'\\x04'); phase = 21
    elif phase == 4 and os.path.exists(os.environ['TRIAGE_READY']) and os.path.exists(os.environ['TRIAGE_REPLY']) and b'PROGRESO' in output:
        phase, phase_at = 6, elapsed
    elif phase == 6 and elapsed - phase_at > 0.4:
        os.write(fd, b'/omi-workspace\\r'); phase, phase_at = 7, elapsed
    elif phase == 7 and elapsed - phase_at > 0.4:
        os.write(fd, b'\\x1b'); phase, phase_at = 8, elapsed
    elif phase == 8 and elapsed - phase_at > 0.2:
        os.write(fd, b'/reload\\r'); phase = 9
    elif phase == 9 and os.path.exists(os.environ['TRIAGE_RELOADED']):
        phase, phase_at = 10, elapsed
    elif phase == 10 and elapsed - phase_at > 0.7:
        os.write(fd, b'\\x1b[50;5u'); phase, phase_at, detail_at = 11, elapsed, len(output)
    elif phase == 11 and b'[issue-42]' in output[detail_at:]:
        os.write(fd, b'\\r'); phase, detail_at = 12, len(output)
    elif phase == 12 and b'retomar trabajo' in output[detail_at:]:
        os.write(fd, b'\\x1b'); phase, phase_at = 13, elapsed
    elif phase == 13 and elapsed - phase_at > 0.3:
        os.write(fd, b'\\r'); phase, detail_at = 14, len(output)
    elif phase == 14 and b'retomar trabajo' in output[detail_at:]:
        os.write(fd, b'\\r'); phase, detail_at = 15, len(output)
    elif phase == 15 and b'Ya est' in output[detail_at:]:
        os.write(fd, b'\\x04'); phase = 16
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk: break
        output += chunk
    if elapsed > 30:
        try: os.write(fd, b'\\x04')
        except OSError: break
else:
    os.kill(pid, signal.SIGKILL)
status = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(output)
sys.stderr.write('\\nTRIAGE_DRIVER_PHASE=' + str(phase) + '\\n')
sys.exit(os.waitstatus_to_exitcode(status))
`;
const resumeDriver = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 150, 0, 0))
os.kill(pid, signal.SIGWINCH)
start, phase, phase_at, detail_at, output = time.monotonic(), 0, 0, 0, b''
while time.monotonic() - start < 26:
    elapsed = time.monotonic() - start
    if phase == 0 and b'Enter enviar' in output:
        os.write(fd, b'\\x1b[50;5u'); phase, detail_at = 1, len(output)
    elif phase == 1 and b'[issue-42]' in output[detail_at:] and b'[Fix]' in output[detail_at:]:
        os.write(fd, b'\\r'); phase, detail_at = 2, len(output)
    elif phase == 2 and b'retomar trabajo' in output[detail_at:]:
        # Haber abierto el detalle no debe reemplazar la sesión de main.
        if os.path.exists(os.environ['TRIAGE_RESUME_READY']): raise RuntimeError('Se retomó antes del segundo Enter')
        os.write(fd, b'\\x1b'); phase, phase_at = 3, elapsed
    elif phase == 3 and elapsed - phase_at > 0.3:
        if os.path.exists(os.environ['TRIAGE_RESUME_READY']): raise RuntimeError('Esc cambió la sesión')
        os.write(fd, b'\\r'); phase, detail_at = 4, len(output)
    elif phase == 4 and b'retomar trabajo' in output[detail_at:]:
        os.write(fd, b'\\r'); phase, detail_at = 5, len(output)
    elif phase == 5 and b'Retomar el trabajo del issue #42' in output[detail_at:]:
        # Sin el sí no se cambia de sesión.
        if os.path.exists(os.environ['TRIAGE_RESUME_READY']): raise RuntimeError('Se retomó antes de confirmar')
        open(os.environ['TRIAGE_RESUME_ENTER'], 'w').close()
        os.write(fd, b'\\r'); phase = 51
    elif phase == 51 and os.path.exists(os.environ['TRIAGE_RESUME_READY']) and os.path.exists(os.environ['TRIAGE_RESUME_REPLY']):
        phase, phase_at = 6, elapsed
    elif phase == 6 and elapsed - phase_at > 0.5:
        os.write(fd, b'\\x04'); phase = 7
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk: break
        output += chunk
    if elapsed > 24:
        try: os.write(fd, b'\\x04')
        except OSError: break
else:
    os.kill(pid, signal.SIGKILL)
status = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(output)
sys.stderr.write('\\nRESUME_DRIVER_PHASE=' + str(phase) + '\\n')
sys.exit(os.waitstatus_to_exitcode(status))
`;
function chunk(delta: unknown, finish: string | null): string {
	return `data: ${JSON.stringify({ id: "triage", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 128, completion_tokens: 128, total_tokens: 256 } } : {}) })}\n\n`;
}

for (const mode of ["ready", "cancel", "invalid"] as const) test(`workspace_begin real · ${mode}: Enter en Issues pide el sí, Esc cancela la clasificación y sólo un resultado válido crea el worktree y arranca el harness`, { skip: process.platform === "win32", timeout: 70000 }, async (t) => {
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
}); }\n`);
	const requests: string[] = []; let confirmedFirst = false;
	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { request.resume(); response.writeHead(404); response.end(); return; }
		let body = ""; request.on("data", (data: Buffer) => { body += data; });
		request.on("end", async () => {
			requests.push(body); response.writeHead(200, { "content-type": "text/event-stream" });
			if (requests.length === 1) {
				try { await access(confirmed); confirmedFirst = true; } catch { /* clasificó sin el sí */ }
				await writeFile(started, "ready");
				const result = { type: mode === "invalid" ? "unknown" : "fix", summary: "Corregir el filtro roto", rationale: "El issue describe un bug", scope: ["Revisar el filtro"], acceptanceCriteria: ["El filtro funciona"], questions: [] };
				const send = () => response.end(chunk({ role: "assistant", content: JSON.stringify(result) }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
				if (mode === "cancel") setTimeout(send, 1500); else send();
			} else if (requests.length === 2) {
				response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "worktree-only.txt" }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
			} else if (requests.length === 3) { response.end(chunk({ role: "assistant", content: "WORKTREE_PROBE_COMPLETED" }, null) + chunk({}, "stop") + "data: [DONE]\n\n"); await writeFile(reply, "done"); }
			else { response.end(chunk({ role: "assistant", content: "RESUME_KICKOFF_DONE" }, null) + chunk({}, "stop") + "data: [DONE]\n\n"); await writeFile(resumeReply, "done"); }
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl, api: "openai-completions", apiKey: "test-not-a-key", models: [{ id: "triage", name: "Test triage", contextWindow: 200000, maxTokens: 8192 }] } } }));
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const run = (script: string, extra: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", script, process.execPath, binary, "--provider", "mock", "--model", "triage", "--no-extensions", "--extension", extension, "--no-context-files", "--no-skills", "--approve"], {
			cwd: root, env: { ...process.env, HOME: home, OMI_HOME: "", TERM: "xterm-256color", HERDR_ENV: "0", PI_TELEMETRY: "0", PATH: bin + delimiter + process.env.PATH, TRIAGE_READY: ready, TRIAGE_RELOADED: reloaded, TRIAGE_CONFIRMED: confirmed, TRIAGE_REPLY: reply, TRIAGE_RESUME_REPLY: resumeReply, TRIAGE_FAILURE: mode === "ready" ? "" : mode, TRIAGE_STARTED: started, ...extra }, stdio: ["ignore", "pipe", "pipe"],
		});
		let output = ""; child.stdout.on("data", (data: Buffer) => { output += data; }); child.stderr.on("data", (data: Buffer) => { output += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
	});
	const result = await run(driver);
	const plain = plainTerminal(result.output);
	assert.equal(result.code, 0, plain);
	// Salir por tiempo también da 0: la fase final prueba que el guion recorrió todo el flujo.
	assert.match(plain, mode === "ready" ? /TRIAGE_DRIVER_PHASE=16\b/ : /TRIAGE_DRIVER_PHASE=21\b/);
	assert.equal(confirmedFirst, true, "no se clasifica antes del sí");
	if (mode !== "ready") {
		assert.equal(requests.length, 1, plain); await assert.rejects(access(worktree)); await assert.rejects(access(ready));
		assert.equal(git("branch", "--show-current"), "main"); assert.equal(git("branch", "--list"), "* main");
		assert.equal(await readFile(join(root, "local.txt"), "utf8"), "LOCAL_UNCOMMITTED\n");
		if (mode === "invalid") assert.match(plain, /formato válido/);
		assert.doesNotMatch(plain, /Extension error|TypeError|exceeds terminal width|Stale extension/); return;
	}
	assert.equal(requests.length, 3, plain);
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
	const resumedReady = join(home, "resumed-ready"); const resumed = await run(resumeDriver, { TRIAGE_RESUME_READY: resumedReady, TRIAGE_RESUME_ENTER: join(home, "resume-enter") });
	const resumedPlain = plainTerminal(resumed.output); assert.equal(resumed.code, 0, resumedPlain); assert.match(resumedPlain, /RESUME_DRIVER_PHASE=7\b/);
	assert.deepEqual(JSON.parse(await readFile(resumedReady, "utf8")), { cwd: worktree, session: sessionFile });
	assert.equal(requests.length, 4, "retomar desde main no vuelve a clasificar: sólo sigue el trabajo");
	assert.match(requests[3]!, /Continuá el harness de desarrollo/);
	const after = await readFile(sessionFile, "utf8"); assert.ok(after.startsWith(conversation), "la conversación guardada se conserva");
	const added = after.slice(conversation.length);
	assert.equal(added.match(/Continuá el harness de desarrollo/g)?.length, 1, "retomar agrega sólo el kickoff"); assert.doesNotMatch(added, /omi-issue-triage|omi\.issue-triage/, "ni otro triage ni otra clasificación"); assert.equal(await readFile(join(worktree, "keep-uncommitted.txt"), "utf8"), "NO PISAR AL RETOMAR\n");
	assert.equal((await readdir(join(sessionFile, ".."))).filter((file) => file.endsWith(".jsonl")).length, 1);
	assert.equal(git("branch", "--show-current"), "main"); assert.equal(git("rev-parse", "main"), main); assert.equal(await readFile(join(root, "local.txt"), "utf8"), "LOCAL_UNCOMMITTED\n");
	assert.match(resumedPlain, /Enter retomar trabajo/); assert.match(resumedPlain, /Retomar el trabajo del issue #42/); assert.match(resumedPlain, /RESUME_KICKOFF_DONE/);
	assert.doesNotMatch(plain + resumedPlain, /Extension error|TypeError|exceeds terminal width|Stale extension/);
});
