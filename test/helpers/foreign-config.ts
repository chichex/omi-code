// Caja negra del aislamiento: siembra configuración ajena y captura lo que omi le manda al modelo.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

/** Marcas que no pueden llegar al modelo. */
export const FOREIGN = {
	homeContext: "CANARIO_CONTEXTO_HOME",
	parentContext: "CANARIO_CONTEXTO_PADRE",
	piContext: "CANARIO_CONTEXTO_PI",
	agentsSkill: "CANARIO_SKILL_AGENTS",
	piSkill: "CANARIO_SKILL_PI",
	claudeSkill: "CANARIO_SKILL_CLAUDE",
} as const;

/** Marcas que sí tienen que llegar: viven en la instalación o en el proyecto. */
export const OWN = {
	omiContext: "PROPIO_CONTEXTO_OMI",
	omiSkill: "PROPIO_SKILL_OMI",
	repoContext: "PROPIO_CONTEXTO_REPO",
	nestedContext: "PROPIO_CONTEXTO_ANIDADO",
} as const;

async function put(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

function skill(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\ncuerpo\n`;
}

/** Devuelve el cwd para arrancar omi: un subdirectorio de un repo que está bajo el home. */
export async function seedConfig(home: string, agent: string): Promise<string> {
	const repo = join(home, "work", "repo");
	const cwd = join(repo, "paquete");
	await mkdir(join(repo, ".git"), { recursive: true });
	await put(join(home, "AGENTS.md"), FOREIGN.homeContext);
	await put(join(home, "work", "AGENTS.md"), FOREIGN.parentContext);
	await put(join(home, ".pi/agent/AGENTS.md"), FOREIGN.piContext);
	await put(join(home, ".agents/skills/intruso/SKILL.md"), skill("intruso", FOREIGN.agentsSkill));
	await put(join(home, ".pi/agent/skills/intruso-pi/SKILL.md"), skill("intruso-pi", FOREIGN.piSkill));
	await put(join(home, ".claude/skills/intruso-claude/SKILL.md"), skill("intruso-claude", FOREIGN.claudeSkill));
	await put(join(agent, "AGENTS.md"), OWN.omiContext);
	await put(join(agent, "skills/propio/SKILL.md"), skill("propio", OWN.omiSkill));
	await put(join(repo, "AGENTS.md"), OWN.repoContext);
	await put(join(cwd, "AGENTS.md"), OWN.nestedContext);
	return cwd;
}

function completion(): string {
	const chunk = (delta: unknown, finish: string | null): string =>
		`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	return `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
}

export interface OmiProcess {
	command: string;
	args?: string[];
	cwd: string;
	agent: string;
	env: NodeJS.ProcessEnv;
}

/** Arranca omi contra un proveedor local y devuelve el body del request que recibió. */
export async function requestSeenByModel(omi: OmiProcess): Promise<string> {
	let captured = "";
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
		request.on("end", () => {
			captured = body;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(completion());
		});
	});
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	try {
		const { port } = server.address() as AddressInfo;
		await writeFile(join(omi.agent, "models.json"), JSON.stringify({
			providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "m" }] } },
		}));
		const child = spawn(omi.command, [...(omi.args ?? []), "--provider", "mock", "--model", "m", "--no-session", "-p", "hola"], {
			cwd: omi.cwd, env: omi.env, stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		if (code !== 0) throw new Error(`omi salió con ${code}: ${stderr}`);
		return captured;
	} finally {
		server.close();
	}
}
