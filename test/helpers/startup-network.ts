// Qué pide a la red el arranque interactivo de omi, sin que nada salga de la máquina.
// Un proxy local anota y corta cada CONNECT; con Node, una extensión además anota la URL de cada
// pedido de undici (el fetch nativo de bun no los publica). La sonda pide SENTINEL al iniciar la
// sesión: sin esa marca el registro no prueba nada.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export const SENTINEL = "https://sonda.omi.invalid/arranque";
export const SENTINEL_CONNECT = "sonda.omi.invalid:443";
/** El tamaño del PTY, como `workspace-pty.ts`: sin él Pi arranca en 0x0. */
const SIZE = { columns: 125, rows: 42 };

const probe = `import diagnostics from "node:diagnostics_channel";
import { appendFileSync } from "node:fs";
const log = process.env.OMI_TEST_REQUEST_LOG;
// El túnel al proxy también es un pedido de undici: se anota el pedido de adentro.
diagnostics.channel("undici:request:create").subscribe(({ request }) => { if (request.method !== "CONNECT") appendFileSync(log, request.origin + request.path + "\\n"); });
export default function (pi) {
	pi.on("session_start", () => {
		appendFileSync(log, "TTY " + process.stdout.columns + "x" + process.stdout.rows + "\\n");
		fetch(${JSON.stringify(SENTINEL)}).catch(() => {});
	});
}
`;

// Sale cuando apareció la marca de la sonda, con un margen para los pedidos en vuelo, o a los 20 s.
const driver = `
import fcntl, os, pty, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    # En el hijo y antes del exec: Pi lee el tamaño al arrancar, sin esperar un SIGWINCH.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', int(os.environ['OMI_TEST_PTY_ROWS']), int(os.environ['OMI_TEST_PTY_COLUMNS']), 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
log, mark = os.environ['OMI_TEST_REQUEST_LOG'], os.environ['OMI_TEST_SENTINEL_CONNECT']
def seen():
    try:
        with open(log) as f: return mark in f.read()
    except OSError: return False
start, seen_at, output = time.monotonic(), None, b''
while time.monotonic() - start < 20:
    if seen_at is None and seen(): seen_at = time.monotonic()
    if seen_at is not None and time.monotonic() - seen_at > 1: break
    if select.select([fd], [], [], 0.1)[0]:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
for _ in range(2):
    try: os.write(fd, b'\\x04')
    except OSError: pass
    time.sleep(0.3)
try: os.kill(pid, 9)
except OSError: pass
os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
`;

export interface StartupNetwork {
	/** URLs que pidió el proceso, en orden. Sólo con Node. */
	requests: string[];
	/** Destinos que llegaron al proxy, como `pi.dev:443`. */
	connects: string[];
	output: string;
}

/** Arranca `command` en un PTY con `--extension` de la sonda y devuelve lo que intentó pedir. */
export async function startupNetwork(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<StartupNetwork> {
	const extension = join(cwd, "omi-network-probe.ts");
	const log = join(cwd, "omi-network-probe.log");
	await writeFile(extension, probe);
	await writeFile(log, "");
	const proxy = createServer((socket) => {
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
					OMI_TEST_REQUEST_LOG: log, OMI_TEST_SENTINEL_CONNECT: SENTINEL_CONNECT, OMI_TEST_PTY_COLUMNS: String(SIZE.columns), OMI_TEST_PTY_ROWS: String(SIZE.rows) },
			});
			let text = "";
			child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
			child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
			child.on("error", reject);
			child.on("close", () => resolve(text));
		});
		const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
		const size = lines.find((line) => line.startsWith("TTY "))?.slice("TTY ".length);
		if (size !== undefined && size !== `${SIZE.columns}x${SIZE.rows}`) throw new Error(`el PTY arrancó en ${size}, no en ${SIZE.columns}x${SIZE.rows}`);
		return {
			requests: lines.filter((line) => !line.startsWith("CONNECT ") && !line.startsWith("TTY ")),
			connects: lines.filter((line) => line.startsWith("CONNECT ")).map((line) => line.slice("CONNECT ".length)),
			output,
		};
	} finally {
		await new Promise((resolve) => proxy.close(resolve));
	}
}
