import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGit, type GithubItem } from "../src/tui/workspace/data.ts";
import { prepareIssue } from "../src/tui/workspace/issue-preparation.ts";
import { readSessionSnapshot } from "../src/tui/workspace/session-files.ts";
import { tempDir } from "./helpers/io.ts";
import { plainTerminal } from "./helpers/workspace-pty.ts";

const driver = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 150, 0, 0))
os.kill(pid, signal.SIGWINCH)
start, phase, phase_at, mark, output = time.monotonic(), 0, 0, 0, b''
while time.monotonic() - start < 22:
    elapsed = time.monotonic() - start
    if phase == 0 and b'Worktree \\xc2\\xb7 issue-42' in output:
        os.write(fd, b'\\x0b'); phase, mark = 1, len(output)
    elif phase == 1 and b'Volver al repo principal' in output[mark:]:
        os.write(fd, b'\\x1b'); phase, phase_at = 2, elapsed
    elif phase == 2 and elapsed - phase_at > 0.2:
        os.write(fd, b'/omi-workspace\\r'); phase, mark = 3, len(output)
    elif phase == 3 and b'volver al repo' in output[mark:]:
        if os.path.exists(os.environ['MAIN_READY']): raise RuntimeError('Entrar al detalle cambió la sesión')
        os.write(fd, b'\\x1b'); phase, phase_at = 4, elapsed
    elif phase == 4 and elapsed - phase_at > 0.2:
        if os.path.exists(os.environ['MAIN_READY']): raise RuntimeError('Esc cambió la sesión')
        os.write(fd, b'\\x0b' if os.environ['MAIN_MODE'] == 'original' else b'/omi-workspace\\r'); phase, mark = 5, len(output)
    elif phase == 5 and (b'Volver al repo principal' if os.environ['MAIN_MODE'] == 'original' else b'volver al repo') in output[mark:]:
        open(os.environ['MAIN_ENTER'], 'w').close()
        os.write(fd, b'\\x1b[B' * 5 + b'\\r' if os.environ['MAIN_MODE'] == 'original' else b'\\r'); phase = 6
    elif phase == 6 and os.path.exists(os.environ['MAIN_READY']):
        phase, phase_at = 7, elapsed
    elif phase == 7 and elapsed - phase_at > 0.5:
        os.write(fd, b'/omi-main\\r'); phase, mark = 8, len(output)
    elif phase == 8 and b'Ya est' in output[mark:]:
        os.write(fd, b'/omi-triage 42\\r'); phase = 9
    elif phase == 9 and os.path.exists(os.environ['MAIN_BACK_ISSUE']):
        phase, phase_at = 10, elapsed
    elif phase == 10 and elapsed - phase_at > 0.3:
        os.write(fd, b'/omi-main\\r'); phase = 11
    elif phase == 11 and os.path.exists(os.environ['MAIN_AGAIN']):
        phase, phase_at = 12, elapsed
    elif phase == 12 and elapsed - phase_at > 0.4:
        os.write(fd, b'\\x04'); phase = 13
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk: break
        output += chunk
    if elapsed > 20: os.write(fd, b'\\x04')
else:
    os.kill(pid, signal.SIGKILL)
status = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(output)
sys.stderr.write('\\nMAIN_DRIVER_PHASE=' + str(phase) + '\\n')
sys.exit(os.waitstatus_to_exitcode(status))
`;

for (const mode of ["original", "empty"] as const) test(`workspace_main PTY · ${mode}: paleta/Ubicación y /omi-main reemplazan cwd/sesión, Esc cancela y el ida y vuelta reutiliza ambas`, { skip: process.platform === "win32", timeout: 35000 }, async (t) => {
	const home = await tempDir(t); const root = join(home, "repo"); const agent = join(home, ".omi/agent"); const sessions = join(home, "sessions"); await mkdir(root); await mkdir(agent, { recursive: true });
	const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const git = (...args: string[]) => gitAt(root, ...args);
	git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
	await writeFile(join(root, "file.txt"), "main\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "main"); if (mode === "original") git("checkout", "-b", "develop");
	const original = SessionManager.create(root, sessions);
	if (mode === "original") { original.appendModelChange("mock", "selected"); original.appendThinkingLevelChange("off"); original.appendMessage({ role: "user", content: "MAIN_CONVERSATION_PRESERVED", timestamp: Date.now() }); }
	const issue: GithubItem = { number: 42, title: "ISSUE_MAIN_ROUNDTRIP", url: "https://github.com/test/repo/issues/42", labels: [], author: "ada", updatedAt: "", draft: false, head: "", base: "", review: "" };
	const context = { sessionManager: original, model: { provider: "mock", id: "selected" }, thinkingLevel: "off" } as unknown as ExtensionContext;
	const prepared = (await prepareIssue((await readGit(root))!, 42, issue, context, { sessionDir: sessions, signal: new AbortController().signal, isCurrent: () => true,
		classify: async () => ({ triage: { type: "fix", summary: "Corregir", rationale: "Bug", scope: [], acceptanceCriteria: [], questions: [] }, body: "ISSUE_SOURCE_CONTEXT", provider: "mock", model: "selected", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } }),
	}))!;
	const { state, sessionFile } = prepared.record;
	for (const cwd of [root, state.worktree]) { await writeFile(join(cwd, "file.txt"), "staged\n"); gitAt(cwd, "add", "file.txt"); await writeFile(join(cwd, "file.txt"), "unstaged\n"); await writeFile(join(cwd, "keep-local"), "UNCOMMITTED\n"); }
	const fingerprint = () => [root, state.worktree].map((cwd) => [gitAt(cwd, "symbolic-ref", "HEAD"), gitAt(cwd, "rev-parse", "HEAD"), gitAt(cwd, "write-tree"), gitAt(cwd, "status", "--porcelain")]); const before = fingerprint();
	const issueText = await readFile(sessionFile!, "utf8"); const originalText = mode === "original" ? await readFile(original.getSessionFile()!, "utf8") : undefined;
	let requests = 0; const server = createServer((request, response) => {
		request.resume();
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
		requests++; response.writeHead(500); response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", apiKey: "test-not-a-key", models: [{ id: "selected", name: "Main test", contextWindow: 200000, maxTokens: 8192 }] } } }));
	const markers = { MAIN_READY: join(home, "main-ready"), MAIN_ENTER: join(home, "main-enter"), MAIN_AGAIN: join(home, "main-again"), MAIN_BACK_ISSUE: join(home, "back-issue"), MAIN_EVENTS: join(home, "events") };
	const extension = join(home, "probe.ts"); await writeFile(extension, `import {appendFile,writeFile,access} from 'node:fs/promises';
export default function(pi) { pi.on('session_start', async (event,ctx) => {
 const main = ctx.cwd === ${JSON.stringify(root)};
 const state = {cwd:ctx.cwd,session:ctx.sessionManager.getSessionFile(),issue:ctx.sessionManager.getBranch().some(e=>e.type==='custom'&&e.customType==='omi-issue-triage')};
 await appendFile(process.env.MAIN_EVENTS, JSON.stringify(state)+'\\n');
 if (main) { try {await access(process.env.MAIN_ENTER)} catch {throw new Error('Se volvió antes de confirmar')};
   let again=false; try {await access(process.env.MAIN_READY);again=true} catch {}
   await writeFile(again?process.env.MAIN_AGAIN:process.env.MAIN_READY,JSON.stringify(state));
 } else if (event.reason==='resume') await writeFile(process.env.MAIN_BACK_ISSUE,JSON.stringify(state));
}); }
`);
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", driver, process.execPath, binary, "--session", sessionFile!, ...(mode === "original" ? ["--session-dir", sessions] : []), "--offline", "--provider", "mock", "--model", "selected", "--no-extensions", "--extension", extension, "--no-context-files", "--no-skills", "--approve"], {
			cwd: state.worktree, env: { ...process.env, HOME: home, OMI_HOME: "", HERDR_ENV: "0", TERM: "xterm-256color", MAIN_MODE: mode, ...markers }, stdio: ["ignore", "pipe", "pipe"],
		});
		let output = ""; child.stdout.on("data", (data: Buffer) => { output += data; }); child.stderr.on("data", (data: Buffer) => { output += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
	});
	const plain = plainTerminal(result.output); assert.equal(result.code, 0, plain); assert.match(plain, /MAIN_DRIVER_PHASE=13/);
	const first = JSON.parse(await readFile(markers.MAIN_READY, "utf8")); const again = JSON.parse(await readFile(markers.MAIN_AGAIN, "utf8")); const back = JSON.parse(await readFile(markers.MAIN_BACK_ISSUE, "utf8"));
	assert.equal(first.cwd, root); assert.equal(first.issue, false); assert.deepEqual(again, first); assert.equal(back.cwd, state.worktree); assert.equal(back.session, sessionFile); assert.equal(back.issue, true);
	assert.equal(requests, 0, "volver, repetir /omi-main y retomar el issue no llama al modelo"); assert.deepEqual(fingerprint(), before); assert.equal(await readFile(sessionFile!, "utf8"), issueText);
	const homeSession = await readSessionSnapshot(first.session); assert.equal(homeSession.getCwd(), root); assert.doesNotMatch(await readFile(first.session, "utf8"), /ISSUE_SOURCE_CONTEXT|omi-issue-triage/);
	if (mode === "original") { assert.equal(first.session, original.getSessionFile()); assert.equal(await readFile(first.session, "utf8"), originalText); assert.match(plain, /MAIN_CONVERSATION_PRESERVED/); }
	else assert.deepEqual(homeSession.buildSessionContext().messages, []);
	const sourceCount = (await readdir(sessions)).filter((file) => file.endsWith(".jsonl")).length;
	const mainCount = dirname(first.session) === sessions ? 0 : (await readdir(dirname(first.session))).filter((file) => file.endsWith(".jsonl")).length;
	assert.equal(sourceCount + mainCount, 2, "una sesión por destino, con --session-dir o con el store default");
	assert.equal((await readFile(markers.MAIN_EVENTS, "utf8")).trim().split("\n").length, 4, "el no-op en el principal no reemplaza la sesión");
	assert.match(plain, /Volver al repo principal/); assert.match(plain, /Enter volver al repo/); assert.doesNotMatch(plain, /Extension error|TypeError|exceeds terminal width|Stale extension/);
});
