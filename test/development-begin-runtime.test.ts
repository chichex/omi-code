import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/io.ts";
import { plainTerminal } from "./helpers/workspace-pty.ts";

// Camino del agente en Pi real: un pedido en el chat, la tool, el sí, el issue nuevo y el harness en su worktree.
const driver = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 150, 0, 0))
os.kill(pid, signal.SIGWINCH)
start, phase, phase_at, output = time.monotonic(), 0, 0, b''
while time.monotonic() - start < 32:
    elapsed = time.monotonic() - start
    if phase == 0 and b'Enter enviar' in output:
        os.write(fd, b'Mostra el total del carrito\\r'); phase = 1
    elif phase == 1 and b'Crear issue y empezar el trabajo' in output:
        open(os.environ['BEGIN_CONFIRMED'], 'w').close()
        os.write(fd, b'\\r'); phase = 2
    elif phase == 2 and os.path.exists(os.environ['BEGIN_READY']) and os.path.exists(os.environ['BEGIN_REPLY']) and b'PROGRESO' in output:
        phase, phase_at = 3, elapsed
    elif phase == 3 and elapsed - phase_at > 0.5:
        os.write(fd, b'\\x04'); phase = 4
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
sys.stderr.write('\\nBEGIN_DRIVER_PHASE=' + str(phase) + '\\n')
sys.exit(os.waitstatus_to_exitcode(status))
`;
const pedido = { title: "Mostrar el total del carrito", body: "Pedido: mostrar el total con impuestos.\nCriterio: coincide con la suma de los items.", reason: "Cambio de código con criterio verificable" };
function chunk(delta: unknown, finish: string | null): string {
	return `data: ${JSON.stringify({ id: "begin", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 64, completion_tokens: 64, total_tokens: 128 } } : {}) })}\n\n`;
}
const toolNames = (request: string) => ((JSON.parse(request).tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name);

test("development_begin real: el agente propone, la persona confirma una vez y el harness sigue en el worktree del issue nuevo", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
	const home = await tempDir(t); const root = join(home, "repo"); const agent = join(home, ".omi/agent"); const bin = join(home, "bin");
	for (const path of [root, agent, bin]) await mkdir(path, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(root, "main.txt"), "MAIN\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main"); const main = git("rev-parse", "main");
	const created = join(home, "created.json"); const confirmed = join(home, "confirmed"); const ready = join(home, "ready"); const reply = join(home, "reply");
	await writeFile(join(bin, "gh"), `#!${process.execPath}
const fs = require('fs'); const args = process.argv.slice(2); const out = (value) => console.log(JSON.stringify(value));
const saved = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(created)}, 'utf8')); } catch { return undefined; } };
if (args[0] === 'repo' && args[1] === 'view') out({ nameWithOwner: 'test/repo', url: 'https://github.com/test/repo' });
else if (args[0] === 'issue' && args[1] === 'create') { fs.writeFileSync(${JSON.stringify(created)}, JSON.stringify({ args, body: fs.readFileSync(0, 'utf8'), confirmed: fs.existsSync(${JSON.stringify(confirmed)}) })); console.log('https://github.com/test/repo/issues/43'); }
else if (args[0] === 'issue' && args[1] === 'view') { const issue = saved(); out({ number: 43, title: issue ? issue.args[issue.args.indexOf('--title') + 1] : '', body: issue ? issue.body : '', url: 'https://github.com/test/repo/issues/43', labels: [] }); }
else if (args[0] === 'issue' || args[0] === 'run') out([]);
else out({ currentBranch: null });
`, { mode: 0o755 });
	const worktree = join(home, "repo-worktrees/issue-43"); const extension = join(home, "probe.ts");
	await writeFile(extension, `import {writeFile} from 'node:fs/promises';
export default function(pi) { pi.on('session_start', async (_event, ctx) => { if (ctx.cwd === ${JSON.stringify(worktree)}) await writeFile(${JSON.stringify(ready)}, JSON.stringify({ cwd: ctx.cwd, session: ctx.sessionManager.getSessionFile() })); }); }\n`);
	const kinds: string[] = []; const requests: string[] = []; let classifiedAfterYes = false;
	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { request.resume(); response.writeHead(404); response.end(); return; }
		let body = ""; request.on("data", (data: Buffer) => { body += data; });
		request.on("end", async () => {
			requests.push(body); response.writeHead(200, { "content-type": "text/event-stream" });
			if (body.includes("clasificador de issues")) {
				kinds.push("classify");
				try { await access(confirmed); classifiedAfterYes = true; } catch { /* clasificó sin el sí */ }
				const triage = { type: "feature", summary: "Mostrar el total", rationale: "Capacidad nueva", scope: [], acceptanceCriteria: [], questions: [] };
				response.end(chunk({ role: "assistant", content: JSON.stringify(triage) }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			} else if (body.includes("Continuá el harness de desarrollo")) {
				kinds.push("kickoff");
				response.end(chunk({ role: "assistant", content: "KICKOFF_OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n"); await writeFile(reply, "done");
			} else if (body.includes("Pedido registrado")) {
				// Si la tool no terminara el turno, el agente seguiría acá antes del sí.
				kinds.push("continued");
				response.end(chunk({ role: "assistant", content: "NO_DEBERIA_SEGUIR" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			} else {
				kinds.push("turn");
				response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "begin", type: "function", function: { name: "omi_work_begin", arguments: JSON.stringify(pedido) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "test-not-a-key", models: [{ id: "begin", name: "Test begin", contextWindow: 200000, maxTokens: 8192 }] } } }));
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", driver, process.execPath, binary, "--provider", "mock", "--model", "begin", "--no-extensions", "--extension", extension, "--no-context-files", "--no-skills", "--approve"], {
			cwd: root, env: { ...process.env, HOME: home, OMI_HOME: "", TERM: "xterm-256color", HERDR_ENV: "0", PI_TELEMETRY: "0", PATH: bin + delimiter + process.env.PATH, BEGIN_CONFIRMED: confirmed, BEGIN_READY: ready, BEGIN_REPLY: reply }, stdio: ["ignore", "pipe", "pipe"],
		});
		let output = ""; child.stdout.on("data", (data: Buffer) => { output += data; }); child.stderr.on("data", (data: Buffer) => { output += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
	});
	const plain = plainTerminal(result.output);
	assert.equal(result.code, 0, plain); assert.match(plain, /BEGIN_DRIVER_PHASE=4\b/, plain);
	assert.deepEqual(kinds, ["turn", "classify", "kickoff"], "la tool termina el turno; clasificar y seguir vienen después del sí");
	assert.ok(toolNames(requests[0]!).includes("omi_work_begin"), "el chat normal ofrece empezar");
	assert.equal(classifiedAfterYes, true, "no se clasifica antes del sí");
	const issue = JSON.parse(await readFile(created, "utf8")) as { args: string[]; body: string; confirmed: boolean };
	assert.equal(issue.confirmed, true, "el issue se crea sólo después del sí");
	assert.deepEqual(issue.args.slice(0, 6), ["issue", "create", "--repo", "test/repo", "--title", pedido.title]); assert.equal(issue.body, pedido.body);
	const kickoff = toolNames(requests[2]!);
	for (const name of ["read", "omi_workflow"]) assert.ok(kickoff.includes(name), name);
	for (const name of ["bash", "write", "edit", "omi_work_begin"]) assert.ok(!kickoff.includes(name), `${name} no se ofrece en Explorar`);
	assert.equal(JSON.parse(await readFile(ready, "utf8")).cwd, worktree);
	assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(), "feat/issue-43-mostrar-el-total-del-carrito");
	assert.equal(git("branch", "--show-current"), "main"); assert.equal(git("rev-parse", "main"), main);
	for (const expected of [/Crear issue y empezar el trabajo/, /Motivo del agente: Cambio de código con criterio verificable/, /PROGRESO · #43/, /KICKOFF_OK/]) assert.match(plain, expected);
	assert.doesNotMatch(plain, /NO_DEBERIA_SEGUIR|Extension error|TypeError|exceeds terminal width|Stale extension/);
});
