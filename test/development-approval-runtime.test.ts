// Pi y PTY reales; issue de GitHub falso y HOME temporal. No es revisión visual humana.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "./helpers/io.ts";

const driver = String.raw`
import fcntl, os, pty, re, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0: os.execv(sys.argv[1], sys.argv[1:])
def size(columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0)); os.kill(pid, signal.SIGWINCH)
size(80, 24)
def send(data):
    try: os.write(fd, data)
    except OSError: pass
start, phase, phase_at, output, mark = time.monotonic(), 0, 0, b'', 0
while time.monotonic() - start < 22:
    elapsed = time.monotonic() - start
    plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)
    # Lo dibujado desde el segundo /probe-review: el sí se envía con la revisión abierta, no tras una espera fija.
    reopened = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output[mark:])
    if phase == 0 and b'Enter enviar' in plain:
        send(b'/probe-review\r'); phase, phase_at = 1, elapsed
    elif phase == 1 and b'1/9 Resumen' in plain:
        send(b'5'); phase, phase_at = 2, elapsed
    elif phase == 2 and b'5/9 Pruebas' in plain:
        send(b'\x1b[F'); phase, phase_at = 3, elapsed
    elif phase == 3 and b'FINAL_PTY_COMMAND' in plain:
        size(132, 40); phase, phase_at = 4, elapsed
    elif phase == 4 and elapsed - phase_at > .25:
        size(80, 24); phase, phase_at = 5, elapsed
    elif phase == 5 and elapsed - phase_at > .25:
        send(b'\r\x1b'); phase, phase_at = 6, elapsed
    elif phase == 6 and b'PROBE_FALSE' in plain:
        mark = len(output); send(b'/probe-review\r'); phase, phase_at = 7, elapsed
    elif phase == 7 and b'1/9 Resumen' in reopened:
        send(b'\x13'); phase, phase_at = 8, elapsed
    elif phase == 8 and b'PROBE_TRUE' in plain:
        send(b'\x04'); phase = 9
    # La implementación anterior abre confirm genérico: salir y fallar sin esperar todo el timeout.
    elif phase == 1 and elapsed - phase_at > 3:
        send(b'\x1b'); phase, phase_at = -1, elapsed
    elif phase == -1 and elapsed - phase_at > .5:
        send(b'\x04')
    if select.select([fd], [], [], .05)[0]:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
else: os.kill(pid, signal.SIGKILL)
status = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(output)
sys.stderr.write('\nAPPROVAL_DRIVER_PHASE=' + str(phase) + '\n')
sys.exit(os.waitstatus_to_exitcode(status))
`;
const source = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
for (const appearance of ["dark", "light"] as const) test(`approval_runtime: revisión dedicada en Pi real, 80x24/resize, cancelar y sí explícito · ${appearance}`, { timeout: 45000 }, async (t) => {
	const home = await realpath(await tempDir(t)); const root = join(home, "repo"); const agent = join(home, ".omi/agent"); await mkdir(root); await mkdir(agent, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
	await writeFile(join(root, "value.txt"), "initial\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "test: initial"); git("checkout", "-b", "improve/probe");
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-not-a-key", models: [{ id: "probe", name: "Probe", contextWindow: 10000, maxTokens: 1024 }] } } }));
	const extension = join(home, "probe.ts"); const framesPath = join(home, "frames.jsonl"); const resultsPath = join(home, "results.jsonl");
	await writeFile(extension, `
import {appendFileSync} from 'node:fs';
import {DevelopmentSession} from ${JSON.stringify(source("src/tui/development-session.ts"))};
import {createWorkflow} from ${JSON.stringify(source("src/harness/state.ts"))};
import {updateWorkflow} from ${JSON.stringify(source("src/harness/store.ts"))};
import {inspectCheckout} from ${JSON.stringify(source("src/harness/git.ts"))};
import {processRunner} from ${JSON.stringify(source("src/core/exec.ts"))};
import {testIo} from ${JSON.stringify(source("test/helpers/io.ts"))};
import {stripTerminalSequences, visibleWidth} from '@earendil-works/pi-tui';
export default function(pi) {
 let session, edits=0;
 const issue={number:44,title:'Revisar aprobación',body:'Pedido de prueba',url:'https://github.com/test/repo/issues/44',hash:'unused'};
 const runner={async run(command,args,options){
  if(command!=='gh') return processRunner.run(command,args,options);
  let value;
  if(args[0]==='issue'&&args[1]==='edit') {issue.body=options.input; edits++; value={};}
  else if(args[0]==='issue'&&args[1]==='view') value=issue;
  else throw Error('remote no previsto');
  return {code:0,stdout:JSON.stringify(value),stderr:''};
 }};
 pi.on('session_start',async(_event,ctx)=>{
  const checkout={root:ctx.cwd,commonDir:${JSON.stringify(join(root, ".git"))},branch:'improve/probe',baseCommit:${JSON.stringify(git("rev-parse", "HEAD"))}};
  const state=createWorkflow(issue,checkout,'approval-probe',new Date().toISOString());
  state.phase='approve'; state.exploration={references:[{path:'value.txt',line:1,detail:'Valor'}],findings:[],approach:'Revisar',missingFoundation:[],dependencies:[],disposition:'continue',reason:'Listo',fingerprint:(await inspectCheckout(checkout,runner)).fingerprint};
  state.recipe={classification:{type:'improve',size:'small',risk:'high',riskAreas:['Harness'],causeKnown:true},objective:'Entender antes de autorizar',approach:'Separar secciones',scope:['Aprobación'],outOfScope:['Otros diálogos'],cases:[{id:'D1',description:'Comando completo sin ejecutar',command:${JSON.stringify("printf '%s' '" + "LONG_TOKEN".repeat(100) + "'\n  echo FINAL_PTY_COMMAND  ")}}],lenses:['quality','security','compliance'],executor:{mode:'inline',writers:0},route:'direct'};
  state.steps=[{id:'C1',title:'Revisión',cases:['D1'],status:'pending',red:null,green:null,commit:null}];
  await updateWorkflow(checkout,44,undefined,()=>state);
  session=new DevelopmentSession(pi,testIo({homeDir:${JSON.stringify(home)},cwd:ctx.cwd}),[],{runner}); session.state=state;
 });
 pi.registerCommand('probe-review',{handler:async(_args,ctx)=>{
  const original=ctx.ui.custom.bind(ctx.ui);
  const ui={...ctx.ui,custom:(factory,options)=>original((tui,theme,keys,done)=>{
   const component=factory(tui,theme,keys,done); const render=component.render.bind(component);
   component.render=(width)=>{const lines=render(width); appendFileSync(${JSON.stringify(framesPath)},JSON.stringify({width,columns:tui.terminal.columns,rows:tui.terminal.rows,lines:lines.map(stripTerminalSequences),widths:lines.map(visibleWidth)})+'\\n');return lines;};
   return component;
  },options)};
  const approved=await session.approve({...ctx,ui});
  appendFileSync(${JSON.stringify(resultsPath)},JSON.stringify({approved,edits,phase:session.state.phase})+'\\n');
  ctx.ui.notify(approved?'PROBE_TRUE':'PROBE_FALSE','info');
 }});
 pi.on('session_shutdown',()=>session?.shutdown());
}
`);
	const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", driver, process.execPath, source("bin/omi.ts"), "--no-extensions", "--extension", extension, "--no-context-files", "--no-skills", "--no-mcp", "--provider", "mock", "--model", "probe", "--use-theme", appearance, "--approve"],
			{ cwd: root, env: { ...process.env, HOME: home, OMI_HOME: "", TERM: "xterm-256color", HERDR_ENV: "0" }, stdio: ["ignore", "pipe", "pipe"] });
		let output = ""; child.stdout.on("data", (b: Buffer) => { output += b; }); child.stderr.on("data", (b: Buffer) => { output += b; }); child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
	});
	const plainOutput = result.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	assert.equal(result.code, 0, plainOutput); assert.match(plainOutput, /APPROVAL_DRIVER_PHASE=9\b/, plainOutput);
	const results = (await readFile(resultsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(results, [{ approved: false, edits: 0, phase: "approve" }, { approved: true, edits: 1, phase: "implement" }]);
	const frames = (await readFile(framesPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { width: number; columns: number; rows: number; widths: number[]; lines: string[] });
	assert.ok(frames.some((f) => f.columns === 80 && f.rows === 24)); assert.ok(frames.some((f) => f.columns === 132 && f.rows === 40));
	for (const frame of frames) { assert.ok(frame.lines.length <= Math.floor(frame.rows * .9)); assert.ok(frame.widths.every((w) => w <= frame.width)); assert.match(frame.lines.slice(-4).join("\n"), /Ctrl\+S.*aprobar.*Esc.*volver/); }
	assert.ok(frames.some((f) => f.lines.join("\n").includes("FINAL_PTY_COMMAND")));
	assert.doesNotMatch(result.output, /Extension error|TypeError|exceeds terminal width/);
});
