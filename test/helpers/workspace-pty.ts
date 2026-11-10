import { spawn } from "node:child_process";

// Node y binario compilado recorren el mismo flujo de TUI en un PTY real.
const driver = `
import fcntl, os, pty, re, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
def size(columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(pid, signal.SIGWINCH)
size(125, 42)
actions = [(2.0, b'\\x0c'), (2.7, b'\\x1b'), (3.0, b'\\x1b[50;5u'), (3.2, b'\\x1b[51;5u'), (3.4, b'\\x1b[52;5u'), (3.6, b'\\x1b[53;5u'), (3.8, b'\\x1b[49;5u'),
 (4.0, b'/omi-workspace\\r'), (4.7, b'\\x1b'), (5.1, b'/settings\\r'), (5.8, b'\\x1b'),
 (6.1, b'/reload\\r'), (7.0, b'/omi-resources\\r'), (7.7, b'\\x1b'), (8.2, b'\\x04')]
turn = os.environ.get('OMI_TEST_TURN') == '1'
preview = os.environ.get('OMI_TEST_PREVIEW') == '1'
pr_click = os.environ.get('OMI_TEST_PR_CLICK') == '1'
if turn or preview or pr_click:
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
            os.write(fd, b'\\x1b[52;5u')
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
            os.write(fd, b'\\x1b[52;5u')
            phase = 1
        elif phase == 1 and b'test/preview.test.ts' in output:
            os.write(fd, b'\\r')
            phase = 2
        elif phase == 2 and b'LOCAL_FILE_PREVIEW_OK' in output:
            phase, phase_at = 3, elapsed
        elif phase == 3 and elapsed - phase_at > 0.3:
            os.write(fd, b'\\x04')
            phase = 4
    if pr_click:
        # Leer la posición que se pintó realmente, no llamar el callback con coordenadas inventadas.
        footer_rows = re.findall(rb'\\x1b\\[41;1H\\x1b\\[2K(.*?)(?=\\x1b\\[\\d+;\\d+H|$)', output, re.S)
        if phase == 0 and footer_rows and elapsed > 1:
            row = re.sub(rb'\\x1b\\].*?(?:\\x07|\\x1b\\\\)', b'', footer_rows[-1], flags=re.S)
            row = re.sub(rb'\\x1b\\[[0-?]*[ -/]*[@-~]', b'', row).decode('utf-8', errors='replace')
            column = row.find('PR #21')
            if column >= 0:
                # El padding a la izquierda del texto forma parte del botón.
                x, y = column, 41
                os.write(fd, ('\\x1b[<0;%d;%dM\\x1b[<0;%d;%dm' % (x, y, x, y)).encode())
                phase, phase_at = 1, elapsed
        elif phase == 1 and (os.path.exists(os.environ['OMI_TEST_BROWSER_LOG']) or b'Ubicaci\\xc3\\xb3n de trabajo' in output):
            os.write(fd, b'\\x1b')
            phase, phase_at = 2, elapsed
        elif phase == 2 and elapsed - phase_at > 0.3:
            os.write(fd, b'\\x04')
            phase = 3
    if elapsed > 7.9 and not resized and not turn and not preview and not pr_click:
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
