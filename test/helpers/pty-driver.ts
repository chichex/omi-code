// Guion de PTY para la TUI real: cada paso espera lo que pintó la TUI (o un archivo marcador) desde la
// tecla que lo causa, nunca un reloj fijo. El plazo es por avance: una fase sin progreso en `stallSeconds`
// corta con su nombre; `totalSeconds` es sólo un tope. Bajo carga el guion tarda más, no pierde teclas.
// Regla de las marcas: `m = mark()` se toma antes de mandar la tecla, nunca al ver un archivo (la TUI pudo
// pintar antes de que el guion lo viera). Lee el PTY hasta el final: en macOS un hijo que muere con salida
// sin leer queda trabado en exit (estado E). Al terminar mata el grupo y espera con límite.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Sin avance en una fase por más que esto, es un cuelgue y no lentitud: aislado, ninguna pasa de 3 s. */
export const PTY_STALL_SECONDS = 45;

const prelude = String.raw`
import fcntl, os, pty, re, select, signal, struct, sys, termios, time
STALL, TOTAL = float(os.environ['PTY_STALL_S']), float(os.environ['PTY_TOTAL_S'])
pid, fd = pty.fork()
if pid == 0:
    # En el hijo y antes del exec: Pi lee el tamaño al arrancar, sin esperar un SIGWINCH.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', int(os.environ['PTY_ROWS']), int(os.environ['PTY_COLUMNS']), 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
with open(os.environ['PTY_PID_FILE'], 'w') as f: f.write(str(pid))
start, output, alive = time.monotonic(), b'', True
CONTROL = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
# El estado del pie de OMI: «Esperando decisión» con un modal abierto; «Listo» sin modal ni turno.
STATUS = re.compile(rb'(Listo|Trabajando|Esperando decisi\xc3\xb3n|Ejecutando \S+) \xc2\xb7')
class Failure(Exception): pass
def read(timeout):
    global output, alive
    if not alive or not select.select([fd], [], [], timeout)[0]: return
    try: chunk = os.read(fd, 65536)
    except OSError: chunk = b''
    if not chunk:
        alive = False; return
    output += chunk; sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
def mark(): return len(output)
def plain(since=0): return CONTROL.sub(b'', output[since:])
def painted(text, since=0): return text.encode() in plain(since)
def status():
    found = STATUS.findall(plain())
    return found[-1].decode() if found else ''
# Un modal se da por abierto con su texto y el pie en «Esperando decisión»; por cerrado, con «Listo» después.
def opened(text, since): return painted(text, since) and painted('Esperando decisión', since)
def closed(since): return painted('Listo ·', since)
def exists(name): return os.path.exists(os.environ[name])
def touch(name): open(os.environ[name], 'w').close()
def send(data):
    try: os.write(fd, data)
    except OSError: pass
def fail(reason): raise Failure(reason)
def report(line):
    sys.stderr.buffer.write((line + '\n').encode()); sys.stderr.buffer.flush()
def wait(phase, ready):
    report('PTY_PHASE=%.1f %s' % (time.monotonic() - start, phase))
    since = time.monotonic()
    while not ready():
        if not alive: fail('la TUI terminó')
        if time.monotonic() - since > STALL: fail('sin avance en %g s' % STALL)
        if time.monotonic() - start > TOTAL: fail('pasó el tope de %g s' % TOTAL)
        read(0.05)
def hold(seconds):
    end = time.monotonic() + seconds
    while alive and time.monotonic() < end: read(0.05)
def leave(phase):
    send(b'\x04'); wait(phase, lambda: not alive)
`;

const epilogue = String.raw`
result = 'fin'
try: run()
except Failure as error: result = 'falla: ' + str(error)
# Un error del guion también termina la TUI y se informa: nunca deja un hijo suelto.
except Exception as error: result = 'falla: el guion falló: %r' % error
def killgroup():
    for kill in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
        try: kill()
        except OSError: pass
# Sin salida limpia, todo el grupo: un nieto vivo (git, gh) no debe trabar el PTY.
if result != 'fin': killgroup()
exit_status, deadline = None, time.monotonic() + 10
while exit_status is None and time.monotonic() < deadline:
    try:
        done, code = os.waitpid(pid, os.WNOHANG)
        if done: exit_status = code
    except ChildProcessError: break
    read(0.05)
if exit_status is None and result == 'fin': result = 'falla: no terminó tras Ctrl+D'
killgroup()
os.close(fd)
report('PTY_RESULT=' + result)
sys.exit(os.waitstatus_to_exitcode(exit_status) if result == 'fin' else 3)
`;

export interface PtyOptions { cwd: string; env: NodeJS.ProcessEnv; totalSeconds: number; stallSeconds?: number; columns?: number; rows?: number }
export interface PtyRun {
	/** El código de salida de la TUI si el guion terminó; 3 si falló. */
	code: number | null;
	output: string;
	/** `fin`, o `falla: <motivo>`. */
	result: string;
	/** La última fase que empezó: donde quedó si falló. */
	phase: string;
	/** Cada fase con el segundo en que empezó. */
	trace: string[];
}

function killGroup(pid: number): void { if (Number.isInteger(pid) && pid > 0) try { process.kill(-pid, "SIGKILL"); } catch { /* ya terminó */ } }

/** Corre `body` (Python que define `run()`) contra `command` en un PTY. Nunca rechaza por la TUI: el resultado lo dice. */
export async function runPty(body: string, command: string, args: readonly string[], options: PtyOptions): Promise<PtyRun> {
	const dir = await mkdtemp(join(tmpdir(), "omi-pty-")); const pidFile = join(dir, "pid");
	const stall = options.stallSeconds ?? PTY_STALL_SECONDS;
	try {
		return await new Promise<PtyRun>((resolve, reject) => {
			const child = spawn("python3", ["-I", "-c", prelude + body + epilogue, command, ...args], {
				cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"],
				// PI_TELEMETRY=0: Pi interactivo con un HOME nuevo reporta la instalación a pi.dev.
				env: { ...options.env, TERM: "xterm-256color", HERDR_ENV: "0", PI_TELEMETRY: "0", PTY_PID_FILE: pidFile, PTY_STALL_S: String(stall), PTY_TOTAL_S: String(options.totalSeconds), PTY_COLUMNS: String(options.columns ?? 150), PTY_ROWS: String(options.rows ?? 42) },
			});
			// setEncoding: un carácter de varios bytes partido entre dos lecturas no se convierte en «�».
			let output = ""; let errors = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => { output += chunk; }); child.stderr.on("data", (chunk: string) => { errors += chunk; });
			// El guion se corta solo antes del tope; esto cubre un Python colgado.
			const timer = setTimeout(async () => { killGroup(Number(await readFile(pidFile, "utf8").catch(() => ""))); child.kill("SIGKILL"); }, (options.totalSeconds + 30) * 1000);
			child.on("error", (error) => { clearTimeout(timer); reject(error); });
			child.on("close", (code) => {
				clearTimeout(timer);
				const trace = [...errors.matchAll(/^PTY_PHASE=(.*)$/gm)].map((match) => match[1]!);
				const result = /^PTY_RESULT=(.*)$/m.exec(errors)?.[1] ?? `falla: el guion terminó sin resultado\n${errors.replace(/^PTY_PHASE=.*\n/gm, "")}`;
				resolve({ code, output, result, phase: trace.at(-1)?.replace(/^[\d.]+ /, "") ?? "ninguna", trace });
			});
		});
	} finally { await rm(dir, { recursive: true, force: true }); }
}

/** Para el mensaje de un assert: dónde quedó, el recorrido y el final de la terminal sin controles. */
export function ptyReport(run: PtyRun): string {
	const tail = run.output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-3000);
	return `${run.result} · fase «${run.phase}»\nrecorrido: ${run.trace.join(" → ")}\n--- final de la terminal ---\n${tail}`;
}
