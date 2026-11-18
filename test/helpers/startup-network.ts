// Qué pide a la red el arranque interactivo de omi, sin que nada salga de la máquina.
// Un proxy local anota y corta cada CONNECT; con Node, una extensión además anota la URL de cada
// pedido de undici (el fetch nativo de bun no los publica). La sonda pide SENTINEL al iniciar la
// sesión: sin esa marca el registro no prueba nada. También anota qué fd y rg resuelve el host como
// Pi: cuando arranca la sesión, Pi ya los buscó o intentó bajarlos.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { delimiter, join } from "node:path";
import { plainTerminal } from "./workspace-pty.ts";

export const SENTINEL = "https://sonda.omi.invalid/arranque";
export const SENTINEL_CONNECT = "sonda.omi.invalid:443";
/** El tamaño del PTY, como `workspace-pty.ts`: sin él Pi arranca en 0x0. */
const SIZE = { columns: 125, rows: 42 };

const probe = `import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import { accessSync, appendFileSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
const log = process.env.OMI_TEST_REQUEST_LOG;
// El túnel al proxy también es un pedido de undici: se anota el pedido de adentro.
diagnostics.channel("undici:request:create").subscribe(({ request }) => { if (request.method !== "CONNECT") appendFileSync(log, request.origin + request.path + "\\n"); });
// Como getToolPath de Pi: primero <agent>/bin, después el PATH.
function resolveTool(name) {
	const managed = join(getAgentDir(), "bin", name);
	if (existsSync(managed)) return managed;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch {}
	}
	return "";
}
export default function (pi) {
	pi.on("session_start", () => {
		appendFileSync(log, "TTY " + process.stdout.columns + "x" + process.stdout.rows + "\\n");
		for (const name of ["fd", "rg"]) {
			const path = resolveTool(name);
			const version = spawnSync(path || name, ["--version"], { encoding: "utf8" }).stdout ?? "";
			appendFileSync(log, "TOOL " + JSON.stringify({ name, path, version: version.split("\\n")[0] }) + "\\n");
		}
		fetch(${JSON.stringify(SENTINEL)}).catch(() => {});
	});
}
`;

// Sale cuando apareció la marca de la sonda, con un margen para los pedidos en vuelo, o a los 20 s.
// Lee el PTY hasta el final: en macOS un hijo que muere con salida sin leer queda trabado en exit
// (estado E) y un waitpid sin leer espera para siempre. Pasa la salida a medida que llega.
const driver = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    # En el hijo y antes del exec: Pi lee el tamaño al arrancar, sin esperar un SIGWINCH.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', int(os.environ['OMI_TEST_PTY_ROWS']), int(os.environ['OMI_TEST_PTY_COLUMNS']), 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
with open(os.environ['OMI_TEST_PID_FILE'], 'w') as f: f.write(str(pid))
log, mark = os.environ['OMI_TEST_REQUEST_LOG'], os.environ['OMI_TEST_SENTINEL_CONNECT']
def seen():
    try:
        with open(log) as f: return mark in f.read()
    except OSError: return False
def read(timeout):
    """False si el PTY ya no da más."""
    if not select.select([fd], [], [], timeout)[0]: return True
    try: chunk = os.read(fd, 65536)
    except OSError: return False
    if not chunk: return False
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    return True
def drain(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not read(0.05): time.sleep(0.05)
start, seen_at = time.monotonic(), None
while time.monotonic() - start < 20:
    if seen_at is None and seen(): seen_at = time.monotonic()
    if seen_at is not None and time.monotonic() - seen_at > 1: break
    if not read(0.1): break
for _ in range(2):
    try: os.write(fd, b'\\x04')
    except OSError: pass
    drain(0.3)
# Todo el grupo: un nieto vivo puede tener una conexión abierta al proxy.
for kill in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
    try: kill()
    except OSError: pass
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0: break
    except ChildProcessError: break
    drain(0.1)
# Cerrar el master destraba a un hijo que todavía espera vaciar su salida.
os.close(fd)
`;

/** El arranque entero tarda unos 20 s como mucho: más que esto es un cuelgue, no lentitud. */
const DEADLINE_MS = 60_000;

/**
 * `path` sin `names`: cada directorio que trae alguno se reemplaza, dentro de `shadow`, por otro con
 * symlinks a todo lo demás. Por ejemplo, un runner con /usr/bin/rg conserva /usr/bin/python3.
 */
export async function pathWithout(names: readonly string[], path: string, shadow: string): Promise<string> {
	const dirs: string[] = [];
	for (const [index, dir] of path.split(delimiter).entries()) {
		const entries = await readdir(dir).catch(() => [] as string[]);
		if (!entries.some((entry) => names.includes(entry))) { dirs.push(dir); continue; }
		const copy = join(shadow, String(index));
		await mkdir(copy, { recursive: true });
		for (const entry of entries) if (!names.includes(entry)) await symlink(join(dir, entry), join(copy, entry));
		dirs.push(copy);
	}
	return dirs.join(delimiter);
}

export interface FoundTool {
	/** El que usaría Pi: `<agent>/bin/<name>` o el primero del PATH; vacío si no hay. */
	path: string;
	/** Primera línea de `<name> --version`, como `fd 10.5.2`. */
	version: string;
}

export interface StartupNetwork {
	/** URLs que pidió el proceso, en orden. Sólo con Node. */
	requests: string[];
	/** Destinos que llegaron al proxy, como `pi.dev:443`. */
	connects: string[];
	/** fd y rg como los ve el host al iniciar la sesión. */
	tools: Record<string, FoundTool>;
	output: string;
}

function readOr(path: string, fallback: string): string {
	try { return readFileSync(path, "utf8"); } catch { return fallback; }
}

/** El grupo del hijo del PTY: es líder de su sesión, así que su pid es el del grupo. */
function killGroup(pidFile: string): void {
	const pid = Number(readOr(pidFile, "").trim());
	if (Number.isInteger(pid) && pid > 0) try { process.kill(-pid, "SIGKILL"); } catch {}
}

/**
 * Arranca `command` en un PTY con `--extension` de la sonda y devuelve lo que intentó pedir.
 * Falla a los `timeoutMs` con el registro y el final de la terminal, en lugar de colgar la suite.
 */
export async function startupNetwork(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<StartupNetwork> {
	const timeoutMs = options.timeoutMs ?? DEADLINE_MS;
	const extension = join(cwd, "omi-network-probe.ts");
	const log = join(cwd, "omi-network-probe.log");
	const pidFile = join(cwd, "omi-network-probe.pid");
	await writeFile(extension, probe);
	await writeFile(log, "");
	// Se cortan al final: una conexión que nunca manda nada no puede trabar proxy.close.
	const sockets = new Set<Socket>();
	const proxy = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.once("data", (data: Buffer) => { appendFileSync(log, `CONNECT ${data.toString("latin1").split(" ")[1] ?? ""}\n`); socket.destroy(); });
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const address = proxy.address();
	const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
	try {
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn("python3", ["-I", "-c", driver, command, ...args, "--extension", extension], {
				cwd, stdio: ["ignore", "pipe", "pipe"],
				env: { ...env, TERM: "xterm-256color", HERDR_ENV: "0", HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: "", no_proxy: "",
					OMI_TEST_REQUEST_LOG: log, OMI_TEST_SENTINEL_CONNECT: SENTINEL_CONNECT, OMI_TEST_PID_FILE: pidFile,
					OMI_TEST_PTY_COLUMNS: String(SIZE.columns), OMI_TEST_PTY_ROWS: String(SIZE.rows) },
			});
			let text = "";
			const timer = setTimeout(() => {
				killGroup(pidFile);
				child.kill("SIGKILL");
				reject(new Error(`startupNetwork: ${command} no terminó en ${timeoutMs} ms\n--- registro del proxy y la sonda ---\n${readOr(log, "(sin registro)")}\n--- final de la terminal ---\n${plainTerminal(text).slice(-2000)}`));
			}, timeoutMs);
			child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
			child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
			child.on("error", (error) => { clearTimeout(timer); reject(error); });
			child.on("close", () => { clearTimeout(timer); resolve(text); });
		});
		const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
		const size = lines.find((line) => line.startsWith("TTY "))?.slice("TTY ".length);
		if (size !== undefined && size !== `${SIZE.columns}x${SIZE.rows}`) throw new Error(`el PTY arrancó en ${size}, no en ${SIZE.columns}x${SIZE.rows}`);
		const tagged = (tag: string): string[] => lines.filter((line) => line.startsWith(tag)).map((line) => line.slice(tag.length));
		const tools = tagged("TOOL ").map((line) => JSON.parse(line) as FoundTool & { name: string });
		return {
			requests: lines.filter((line) => !line.startsWith("CONNECT ") && !line.startsWith("TOOL ") && !line.startsWith("TTY ")),
			connects: tagged("CONNECT "),
			tools: Object.fromEntries(tools.map(({ name, path, version }) => [name, { path, version }])),
			output,
		};
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => proxy.close(resolve));
	}
}
