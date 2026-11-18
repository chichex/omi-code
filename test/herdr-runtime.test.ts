// Arranque TUI real, no sólo callbacks simulados. El servidor Herdr se reemplaza por un socket local.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HerdrReport } from "../src/tui/herdr.ts";
import { tempDir } from "./helpers/io.ts";

const driver = `
import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
# Sale cuando Herdr ya recibió el primer reporte (el test crea el archivo), no a un tiempo fijo:
# un arranque lento no pierde el Ctrl+D ni sale antes de cargar la integración.
ready = os.environ['OMI_TEST_HERDR_READY']
start, exit_sent = time.monotonic(), False
output = b''
while time.monotonic() - start < 12:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    if not exit_sent and os.path.exists(ready):
        os.write(fd, b'\\x04')
        exit_sent = True
else:
    os.kill(pid, signal.SIGKILL)
status = os.waitpid(pid, 0)[1]
if os.waitstatus_to_exitcode(status) != 0:
    sys.stderr.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;

test("Herdr_la TUI real carga la integración y libera el pane al salir", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
	const home = await tempDir(t);
	const path = join(home, "herdr.sock");
	const ready = join(home, "herdr-ready");
	const reports: HerdrReport[] = [];
	const server = createServer((socket) => {
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk;
			if (!data.includes("\n")) return;
			const report = JSON.parse(data.trim()) as HerdrReport;
			reports.push(report);
			if (report.method === "pane.report_agent" && report.params.state === "idle") writeFileSync(ready, "");
			socket.end('{"result":{}}\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const binary = fileURLToPath(new URL("../bin/omi.ts", import.meta.url));
	const result = await new Promise<{ code: number | null; error: string }>((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", driver, process.execPath, binary, "--no-extensions", "--no-context-files", "--no-skills", "--offline"], {
			cwd: home, stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, HOME: home, OMI_HOME: "", TERM: "xterm-256color", HERDR_ENV: "1", HERDR_PANE_ID: "w-test:p1", HERDR_SOCKET_PATH: path, OMI_TEST_HERDR_READY: ready },
		});
		let error = "";
		child.stderr.on("data", (chunk: Buffer) => { error += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, error }));
	});
	assert.equal(result.code, 0, result.error);
	assert.ok(reports.some((report) => report.method === "pane.report_agent" && report.params.agent === "omi" && report.params.state === "idle"), JSON.stringify(reports));
	const first = reports.find((report) => report.params.resume_argv);
	assert.equal(first?.params.resume_argv?.[0], "omi");
	assert.ok(first?.params.agent_session_path?.startsWith(home));
	assert.equal(reports.at(-1)?.method, "pane.release_agent");
});
