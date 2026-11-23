// Preload de `npm test`: ningún proceso de un test sale de loopback.
// Lo carga cada archivo de test y, por NODE_OPTIONS, cada hijo de Node que herede su entorno.
// La conexión no sale: falla como una red caída, queda anotada y el archivo de test falla al terminar.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG = "OMI_TEST_NETWORK_LOG";
// Los nombres DNS no distinguen mayúsculas y admiten el punto final. 0.0.0.0 no se enruta: en Linux
// y macOS un connect ahí llega a la máquina misma, y en Windows falla.
const LOCAL = /^(localhost\.?|127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/i;

const outside = (host: string | undefined, port: unknown) => host === undefined || LOCAL.test(host) ? undefined : `${host}:${String(port)}`;

/** Host:puerto de un connect que sale de la máquina; undefined si es loopback o un socket unix. */
function external(args: unknown[]): string | undefined {
	// net.connect pasa los argumentos ya normalizados como un array.
	const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (typeof first === "object" && first !== null) {
		if ("path" in first && first.path) return undefined;
		return outside("host" in first && typeof first.host === "string" ? first.host : undefined, "port" in first ? first.port : undefined);
	}
	if (typeof first === "string" && !/^\d+$/.test(first)) return undefined;
	return outside(typeof args[1] === "string" ? args[1] : undefined, first);
}

/** Anota la conexión en el log del archivo de test; sin log, o si su after ya lo borró, en stderr. */
function record(line: string): void {
	const log = process.env[LOG];
	try {
		if (log) { appendFileSync(log, `${line}\n`); return; }
	} catch {}
	process.stderr.write(`red bloqueada en tests: ${line}\n`);
}

const connect = net.Socket.prototype.connect;
// connect tiene overloads: el reemplazo los acepta todos y delega con Reflect.apply.
Object.assign(net.Socket.prototype, {
	connect(this: net.Socket, ...args: unknown[]): net.Socket {
		const target = external(args);
		if (target === undefined) return Reflect.apply(connect, this, args);
		record(`${target} desde ${process.argv.slice(1).join(" ")}`);
		process.nextTick(() => this.destroy(Object.assign(new Error(`red bloqueada en tests: ${target}`), { code: "ECONNREFUSED" })));
		return this;
	},
});

if (!process.env.NODE_OPTIONS?.includes(import.meta.url)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${import.meta.url}`.trim();
// git no es Node y no pasa por el connect de arriba: sólo transportes locales (rutas y file://). Un fetch o un push
// a GitHub de un test falla al instante, como una red caída.
process.env.GIT_ALLOW_PROTOCOL = "file";

// Cada archivo de test anota aparte: así la falla cae en el archivo que lanzó el proceso.
if (process.argv[1]?.endsWith(".test.ts")) {
	const dir = mkdtempSync(join(tmpdir(), "omi-network-"));
	const log = join(dir, "log");
	process.env[LOG] = log;
	const { after } = await import("node:test");
	after(() => {
		let seen = "";
		try { seen = readFileSync(log, "utf8"); } catch {}
		rmSync(dir, { recursive: true, force: true });
		assert.deepEqual(seen.split("\n").filter(Boolean), [], `${process.argv[1]}: un proceso del test intentó salir de loopback (¿Pi interactivo con HOME nuevo sin PI_TELEMETRY=0, o sin fd y rg en el PATH?)`);
	});
}
