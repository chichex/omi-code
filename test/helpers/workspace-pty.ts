import { spawn } from "node:child_process";

// Node y binario compilado recorren el mismo flujo de TUI en un PTY real.
const driver = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
def size(columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(pid, signal.SIGWINCH)
size(125, 42)
actions = [(2.0, b'\\x0c'), (2.7, b'\\x1b'), (3.1, b'\\x1b[50;5u'), (3.35, b'\\x1b[51;5u'), (3.6, b'\\x1b[49;5u'),
 (4.0, b'/omi-workspace\\r'), (4.7, b'\\x1b'), (5.1, b'/settings\\r'), (5.8, b'\\x1b'),
 (6.1, b'/reload\\r'), (7.0, b'/omi-resources\\r'), (7.7, b'\\x1b'), (8.2, b'\\x04')]
turn = os.environ.get('OMI_TEST_TURN') == '1'
preview = os.environ.get('OMI_TEST_PREVIEW') == '1'
if turn or preview:
    actions = []
start = time.monotonic()
output = b''
resized = False
phase, phase_at = 0, 0
while time.monotonic() - start < 16:
    elapsed = time.monotonic() - start
    while actions and elapsed >= actions[0][0]:
        os.write(fd, actions.pop(0)[1])
    if turn:
        if phase == 0 and b'Test model' in output and elapsed > 1:
            os.write(fd, b'hola\\r')
            phase = 1
        elif phase == 1 and b'Trabajando' in output:
            os.write(fd, b'\\x1b[50;5u')
            phase, phase_at = 2, elapsed
        elif phase == 2 and os.path.exists(os.environ['OMI_TEST_PROMPT']):
            phase, phase_at = 3, elapsed
        elif phase == 3 and elapsed - phase_at > 0.3:
            os.write(fd, b'\\r')
            phase = 4
        elif phase == 4 and os.path.exists(os.environ['OMI_TEST_REPLY']):
            phase, phase_at = 5, elapsed
        elif phase == 5 and elapsed - phase_at > 0.8:
            os.write(fd, b'\\x04')
            phase = 6
    if preview:
        if phase == 0 and b'Enter enviar' in output:
            os.write(fd, b'\\x1b[50;5u')
            phase = 1
        elif phase == 1 and b'test/preview.test.ts' in output:
            os.write(fd, b'\\r')
            phase = 2
        elif phase == 2 and b'LOCAL_FILE_PREVIEW_OK' in output:
            phase, phase_at = 3, elapsed
        elif phase == 3 and elapsed - phase_at > 0.3:
            os.write(fd, b'\\x04')
            phase = 4
    if elapsed > 7.9 and not resized and not turn and not preview:
        size(72, 22)
        resized = True
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    if elapsed > 14 or (not turn and elapsed > 9):
        os.write(fd, b'\\x04')
else:
    os.kill(pid, signal.SIGKILL)
status = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export function exerciseWorkspace(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", driver, command, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...env, TERM: "xterm-256color", HERDR_ENV: "0" } });
		let output = ""; child.stdout.on("data", (chunk: Buffer) => { output += chunk; }); child.stderr.on("data", (chunk: Buffer) => { output += chunk; });
		child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
	});
}
export function plainTerminal(output: string): string { return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }
