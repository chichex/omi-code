// Pi y PTY reales: una tanda de dos preguntas dentro del layout fullscreen del workspace, con resize,
// respuesta libre y cancelación. HOME temporal y modelo falso; no es una revisión visual humana.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "./helpers/io.ts";
import { plainTerminal } from "./helpers/workspace-pty.ts";

// Cada paso espera lo que pintó la TUI desde la tecla anterior, nunca un reloj fijo. Lee el PTY hasta el
// final: en macOS un hijo que muere con salida sin leer queda trabado en exit y un waitpid sin leer espera
// para siempre. Al terminar mata todo el grupo y espera con límite, leyendo, antes de cerrar el master.
const driver = String.raw`
import fcntl, os, pty, re, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 125, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
with open(os.environ['OMI_TEST_PID_FILE'], 'w') as f: f.write(str(pid))
output = b''
def read(timeout):
    global output
    if not select.select([fd], [], [], timeout)[0]: return True
    try: chunk = os.read(fd, 65536)
    except OSError: return False
    if not chunk: return False
    output += chunk
    return True
def send(data):
    try: os.write(fd, data)
    except OSError: pass
def resize(columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0)); os.kill(pid, signal.SIGWINCH)
def painted(text, since):
    return text.encode() in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output[since:])
# (lo que tiene que estar pintado desde la tecla anterior, lo que se manda después)
steps = [
    ('Enter enviar', b'/probe-ask\r'),
    ('¿Qué alcance tiene el cambio?', 'resize'),
    ('¿Qué alcance tiene el cambio?', b'2'),
    ('¿Qué riesgo asumimos?', b'5'),
    ('Enter listo', b'lo decide el equipo'),
    ('lo decide el equipo', b'\r'),
    ('Revisá las respuestas', b'\r'),
    ('PROBE_ANSWERED', b'/probe-ask\r'),
    ('¿Qué alcance tiene el cambio?', b'\x1b'),
    ('PROBE_CANCELLED', b'\x04'),
]
start, step, mark, alive = time.monotonic(), 0, 0, True
while alive and time.monotonic() - start < 30 and step < len(steps):
    text, keys = steps[step]
    if painted(text, mark):
        mark = len(output)
        if keys == 'resize': resize(80, 24)
        else: send(keys)
        step += 1
    alive = read(0.05)
end = time.monotonic() + 3
while alive and time.monotonic() < end: alive = read(0.05)
for kill in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
    try: kill()
    except OSError: pass
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0: break
    except ChildProcessError: break
    read(0.05)
os.close(fd)
sys.stdout.buffer.write(output)
sys.stderr.write('\nQUESTIONS_DRIVER_STEP=' + str(step) + '\n')
`;
const source = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
interface Frame { width: number; columns: number; rows: number; lines: string[]; widths: number[] }

test("preguntas_runtime: una tanda de dos preguntas en el workspace de Pi real, con resize, respuesta libre y Esc", { timeout: 60_000 }, async (t) => {
	const home = await realpath(await tempDir(t)); const root = join(home, "repo"); const agent = join(home, ".omi/agent");
	await mkdir(root); await mkdir(agent, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
	await writeFile(join(root, "value.txt"), "initial\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "test: initial");
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-not-a-key", models: [{ id: "probe", name: "Probe", contextWindow: 10000, maxTokens: 1024 }] } } }));
	const extension = join(home, "probe.ts"); const framesPath = join(home, "frames.jsonl"); const resultsPath = join(home, "results.jsonl"); const pidFile = join(home, "pty.pid");
	await writeFile(extension, `
import { appendFileSync } from "node:fs";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { askQuestions } from ${JSON.stringify(source("src/tui/questions/ask.ts"))};
const free = { multiline: false };
const batch = { title: "El agente pregunta", questions: [
	{ id: "q1", header: "Alcance", question: "¿Qué alcance tiene el cambio?", multiSelect: false, recommended: true, freeText: free, options: [{ label: "Sólo el bug", description: "Arregla el cálculo sin tocar otras partes" }, { label: "Bug y refactor", description: "Aprovecha para ordenar el módulo" }] },
	// Descripciones que se envuelven: a 80×24 no entra todo y la tanda tiene que acomodarse al alto que deja el workspace.
	{ id: "q2", header: "Riesgo", question: "¿Qué riesgo asumimos?", multiSelect: false, recommended: true, freeText: free, options: ["Bajo", "Medio", "Alto", "Crítico"].map((label) => ({ label, description: label + ": " + "toca partes del sistema que conviene revisar con cuidado antes de seguir, ".repeat(2) })) },
] };
export default function (pi) {
	pi.registerCommand("probe-ask", { handler: async (_args, ctx) => {
		const custom = ctx.ui.custom.bind(ctx.ui);
		const ui = { ...ctx.ui, custom: (factory, options) => custom((tui, theme, keys, done) => {
			const component = factory(tui, theme, keys, done); const render = component.render.bind(component);
			component.render = (width) => { const lines = render(width); appendFileSync(${JSON.stringify(framesPath)}, JSON.stringify({ width, columns: tui.terminal.columns, rows: tui.terminal.rows, lines: lines.map(stripTerminalSequences), widths: lines.map(visibleWidth) }) + "\\n"); return lines; };
			return component;
		}, options) };
		const result = await askQuestions({ ...ctx, ui }, batch);
		appendFileSync(${JSON.stringify(resultsPath)}, JSON.stringify(result) + "\\n");
		ctx.ui.notify(result.status === "answered" ? "PROBE_ANSWERED" : "PROBE_CANCELLED", "info");
	} });
}
`);
	const result = await new Promise<{ output: string }>((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", driver, process.execPath, source("bin/omi.ts"), "--no-extensions", "--extension", extension, "--no-context-files", "--no-skills", "--no-mcp", "--offline", "--provider", "mock", "--model", "probe"],
			{ cwd: root, env: { ...process.env, HOME: home, OMI_HOME: "", TERM: "xterm-256color", HERDR_ENV: "0", PI_TELEMETRY: "0", OMI_TEST_PID_FILE: pidFile }, stdio: ["ignore", "pipe", "pipe"] });
		let output = ""; child.stdout.on("data", (b: Buffer) => { output += b; }); child.stderr.on("data", (b: Buffer) => { output += b; });
		// Si el driver mismo se cuelga: el grupo del hijo del PTY es líder de su sesión.
		const timer = setTimeout(async () => { const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim()); if (pid > 0) try { process.kill(-pid, "SIGKILL"); } catch { /* ya terminó */ } child.kill("SIGKILL"); }, 50_000);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", () => { clearTimeout(timer); resolve({ output }); });
	});
	const plain = plainTerminal(result.output);
	assert.match(plain, /QUESTIONS_DRIVER_STEP=10\b/, plain.slice(-3000));
	assert.doesNotMatch(result.output, /Extension error|TypeError|exceeds terminal width/);
	const results = (await readFile(resultsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(results, [
		{ status: "answered", answers: [
			{ id: "q1", question: "¿Qué alcance tiene el cambio?", options: ["Bug y refactor"], text: null },
			{ id: "q2", question: "¿Qué riesgo asumimos?", options: [], text: "lo decide el equipo" },
		] },
		{ status: "cancelled" },
	]);
	const frames = (await readFile(framesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Frame);
	// 125 columnas: la tanda va en la columna principal, al lado de la lateral; a 80 ocupa todo el ancho.
	assert.ok(frames.some((f) => f.columns === 125 && f.rows === 42 && f.width < 125 - 30), "al lado de la lateral");
	assert.ok(frames.some((f) => f.columns === 80 && f.rows === 24 && f.width === 80), "después del resize");
	for (const frame of frames) {
		assert.ok(frame.widths.every((w) => w === frame.width), `${frame.columns}×${frame.rows}: cada fila ocupa el ancho, sin pasarse`);
		assert.ok(frame.lines.length <= frame.rows - 8, `${frame.columns}×${frame.rows}: deja lugar al encabezado y al pie del workspace`);
		assert.match(frame.lines.at(-1)!, /Esc (cancelar|volver)/, "la ayuda queda a la vista");
	}
	assert.ok(frames.some((f) => f.lines.some((l) => /□ Alcance.*□ Riesgo.*Enviar/.test(l))), "pestañas con encabezados y Enviar");
	assert.ok(frames.some((f) => f.lines.some((l) => l.includes("1. Sólo el bug (Recomendada)"))));
	// El workspace sigue alrededor: su encabezado y el pie, que avisa que OMI espera una decisión.
	assert.match(plain, / > omi code/); assert.match(plain, /Esperando decisión/);
});
