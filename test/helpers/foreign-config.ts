// Caja negra del aislamiento: siembra configuración ajena y captura lo que omi le manda al modelo.

import { spawn } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
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

function extensionWithTool(name: string): string {
	return `export default function (pi) { pi.registerTool({ name: "${name}", label: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) }); }\n`;
}

/** Lo que tiene que seguir llegando al modelo después de importar y borrar ~/.pi. */
export const PI_MARKS = ["MARCA_CONTEXTO", "MARCA_SKILL", "MARCA_SKILL_POR_RUTA", "MARCA_SYMLINK", "marca_extension", "marca_extension_por_ruta", "MARCA_PAQUETE"] as const;

/** Un Pi con de todo: rutas en los ajustes, un paquete instalado, un symlink y lo que no se copia. */
export async function seedPi(home: string): Promise<void> {
	const pi = join(home, ".pi/agent");
	await put(join(pi, "settings.json"), JSON.stringify({
		packages: ["git:github.com/fake/paquete"],
		extensions: ["~/.pi/agent/sueltas/por-ruta.ts"],
		skills: [join(pi, "sueltas/skills")],
	}));
	await put(join(pi, "AGENTS.md"), "MARCA_CONTEXTO");
	await put(join(pi, "skills/de-pi/SKILL.md"), skill("de-pi", "MARCA_SKILL"));
	await put(join(pi, "reales/enlazado/SKILL.md"), skill("enlazado", "MARCA_SYMLINK"));
	await symlink("../reales/enlazado", join(pi, "skills/enlazado"));
	await put(join(pi, "sueltas/skills/por-ruta/SKILL.md"), skill("por-ruta", "MARCA_SKILL_POR_RUTA"));
	await put(join(pi, "extensions/de-pi.ts"), extensionWithTool("marca_extension"));
	await put(join(pi, "sueltas/por-ruta.ts"), extensionWithTool("marca_extension_por_ruta"));
	const repo = join(pi, "git/github.com/fake/paquete");
	await put(join(repo, "package.json"), JSON.stringify({ name: "paquete", pi: { skills: ["./skills"] } }));
	await put(join(repo, "skills/de-paquete/SKILL.md"), skill("de-paquete", "MARCA_PAQUETE"));
	await put(join(pi, "sessions/vieja.jsonl"), "{}");
	await put(join(pi, "backups/viejo.json"), "{}");
	await put(join(pi, "trust.json"), "{}");
	await put(join(pi, "settings.json.bak-1"), "{}");
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

/** Manda un comando por RPC al omi real y devuelve el `data` de su respuesta. */
export function rpc(omi: Omit<OmiProcess, "agent">, request: { id: string; type: string; [key: string]: unknown }): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(omi.command, [...(omi.args ?? []), "--mode", "rpc", "--no-session"], { cwd: omi.cwd, env: omi.env, stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		let stderr = "";
		let result: { success: true; data: unknown } | { success: false; error: Error } | undefined;
		const timeout = setTimeout(() => {
			result = { success: false, error: new Error(`RPC ${result ? "no terminó" : "no respondió"}: ${stderr}`) };
			child.kill("SIGKILL");
		}, 20000);
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.stdout.on("data", (chunk: Buffer) => {
			if (result) return;
			output += chunk.toString("utf8");
			for (const line of output.split("\n").slice(0, -1)) {
				if (!line.startsWith("{")) continue;
				const message = JSON.parse(line) as { id?: unknown; type?: string; success?: boolean; data?: unknown; error?: string };
				if (message.type !== "response" || message.id !== request.id) continue;
				result = message.success === false ? { success: false, error: new Error(message.error) } : { success: true, data: message.data };
				child.kill();
				return;
			}
		});
		child.on("error", (error) => { result = { success: false, error }; });
		child.stdin.on("error", (error: Error) => { result = { success: false, error }; child.kill("SIGKILL"); });
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			if (!result) reject(new Error(`RPC terminó sin responder (${signal ?? code}): ${stderr}`));
			else if (result.success) resolve(result.data);
			else reject(result.error);
		});
		child.stdin.write(`${JSON.stringify(request)}\n`);
	});
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
