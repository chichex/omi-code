// Prueba el proveedor real contra un Claude Code falso: sin login, red ni consumo de cuota.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OmiProcess } from "./foreign-config.ts";

export async function exerciseClaudeBridgeRuntime(omi: OmiProcess, success = false): Promise<void> {
	const bin = join(omi.cwd, "bridge-bin"); await mkdir(bin, { recursive: true });
	await mkdir(omi.agent, { recursive: true });
	const executable = join(bin, "claude"); const captured = join(bin, "captured");
	await writeFile(executable, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["OMI_BRIDGE_PROBE"], "w") as capture:
    capture.write("\\n".join(sys.argv[1:]) + "\\n")
    capture.write("PACKAGE_DIR=" + os.environ.get("PI_PACKAGE_DIR", "unset") + "\\nAGENT=" + os.environ.get("OMI_AGENT_SESSION", "unset") + "\\n")
for line in sys.stdin:
    message = json.loads(line)
    if message["type"] == "control_request":
        print(json.dumps({"type": "control_response", "response": {"subtype": "success", "request_id": message["request_id"], "response": {}}}), flush=True)
    elif message["type"] == "user":
        success = os.environ.get("OMI_BRIDGE_SUCCESS") == "1"
        print(json.dumps({"type": "result", "subtype": "success" if success else "error_during_execution", "is_error": not success, "result": "OMI_FAKE_CLAUDE_SUCCESS", "errors": [] if success else ["OMI_FAKE_CLAUDE_EXIT"], "session_id": "test", "num_turns": 0, "duration_ms": 0, "duration_api_ms": 0, "total_cost_usd": 0, "usage": {}, "modelUsage": {}, "permission_denials": []}), flush=True)
        break
`);
	await chmod(executable, 0o700);
	for (const custom of [false, true]) {
		if (custom) {
			const target = join(bin, "custom claude"); await rename(executable, target);
			await writeFile(join(omi.agent, "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: target } }));
		}
		const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
			const child = spawn(omi.command, [...(omi.args ?? []), "--offline", "--no-session", "--provider", "claude-bridge", "--model", "claude-opus-5-5", "-p", "bridge smoke"], {
				cwd: omi.cwd, env: { ...omi.env, PATH: `${bin}:/usr/bin:/bin`, OMI_BRIDGE_PROBE: captured, OMI_BRIDGE_SUCCESS: success ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Claude bridge no terminó: ${output}`)); }, 15000);
			child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
			child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
			child.on("error", (error) => { clearTimeout(timer); reject(error); });
			child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
		});
		assert.equal(result.code, success ? 0 : 1, result.output);
		assert.match(result.output, success ? /OMI_FAKE_CLAUDE_SUCCESS/ : /OMI_FAKE_CLAUDE_EXIT/);
		const args = await readFile(captured, "utf8");
		assert.match(args, /(?:^|\n)--model=claude-opus-5-5\[1m\]\n/);
		assert.match(args, /--strict-mcp-config/);
		assert.match(args, /(?:^|\n)--setting-sources=\n/, "no habilita ajustes/hooks globales ni del repo de Claude Code");
		assert.match(args, /PACKAGE_DIR=unset\nAGENT=1/);
		await rm(captured);
	}
	await rm(join(omi.agent, "claude-bridge.json"));
}
