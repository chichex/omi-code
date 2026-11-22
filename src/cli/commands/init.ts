// `omi init`: vincula el repo. Flags en la CLI, preguntas sólo si hay un humano. Bare con terminal elige
// módulo; `--development` carga su host recién ahí: la ruta legacy no importa Pi, la TUI ni la KB.

import { basename } from "node:path";
import { EXIT_OK, UsageError } from "../../core/errors.ts";
import { cliGuard, isAgentSession } from "../../guardrails/surfaces.ts";
import { enforce } from "../../guardrails/policy.ts";
import { linkProject, type LinkContext, type LinkRequest, type ServiceRequest } from "../../project/init.ts";
import { parseFlags } from "../flags.ts";
import type { Io } from "../io.ts";
import { printJson } from "../output.ts";

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`puerto inválido: ${value}`);
	return port;
}

/** Forma `nombre[:ruta[:puerto[:dockerfile]]]`. */
function parseService(spec: string): ServiceRequest {
	const [name = "", path, port, dockerfile] = spec.split(":");
	if (name === "") throw new UsageError(`service inválido: ${spec}`);
	return {
		name,
		...(path === undefined || path === "" ? {} : { path }),
		...(port === undefined || port === "" ? {} : { port: parsePort(port) }),
		...(dockerfile === undefined || dockerfile === "" ? {} : { dockerfile }),
	};
}

async function orAsk(value: string | undefined, question: string, fallback: string, io: Io): Promise<string> {
	if (value !== undefined) return value;
	if (!io.interactive) throw new UsageError(`falta ${question}`, "`omi init --project <slug> --service <nombre>`");
	return (await io.prompt(`${question} [${fallback}]: `)).trim() || fallback;
}

type DevelopmentInit = (args: string[], io: Io) => Promise<number>;
export interface InitDeps { development?: () => Promise<DevelopmentInit> }
const loadDevelopment = async (): Promise<DevelopmentInit> => (await import("../init-development.ts")).developmentInit;
const LEGACY_FLAGS = ["org", "project", "name", "service", "port", "env", "create"] as const;

/** Sólo bare con terminal y sin --json: los flags legacy y el diagnóstico no interactivo no cambian. */
async function chooseModule(io: Io): Promise<"link" | "development"> {
	io.out("¿Qué configurar?\n  1) Vínculo con OMI: proyecto y services (.omi/project.json)\n  2) Desarrollo: Review, Land y Ship del harness (KB)");
	const answer = (await io.prompt("Módulo [1]: ")).trim();
	if (answer === "" || answer === "1") return "link";
	if (answer === "2") return "development";
	throw new UsageError(`módulo inválido: ${answer}`, "elegí 1 o 2, o usá `omi init --development`");
}

export async function initCommand(args: string[], io: Io, deps: InitDeps = {}): Promise<number> {
	const development = deps.development ?? loadDevelopment;
	if (args.includes("--development")) return (await development())(args, io);
	const { values, positionals } = parseFlags(args, {
		org: { type: "string" },
		project: { type: "string" },
		name: { type: "string" },
		service: { type: "string", multiple: true },
		port: { type: "string" },
		env: { type: "string" },
		create: { type: "boolean" },
	});
	const bare = positionals.length === 0 && LEGACY_FLAGS.every((flag) => values[flag] === undefined);
	if (bare && io.interactive && values.json !== true && await chooseModule(io) === "development") return (await development())(["--development"], io);
	const fallback = basename(io.cwd);
	const projectSlug = await orAsk(values.project, "slug del proyecto", fallback, io);
	const services = (values.service ?? [await orAsk(undefined, "nombre del service", fallback, io)]).map(parseService);
	const [first] = services;
	if (values.port !== undefined && services.length === 1 && first !== undefined) first.port = parsePort(values.port);

	const request: LinkRequest = {
		projectSlug,
		services,
		...(values.org === undefined ? {} : { organizationSlug: values.org }),
		...(values.name === undefined ? {} : { projectName: values.name }),
		...(values.env === undefined ? {} : { environments: values.env.split(",").map((name) => name.trim()) }),
	};
	let approved = false;
	// `--create` pide crear lo que falte: habilita la pregunta, no la responde.
	const guard = cliGuard(io, { yes: false, ...(values.create === true ? { requestFlag: "--create" } : {}) });
	const context: LinkContext = {
		io,
		...(values.api === undefined ? {} : { apiUrl: values.api }),
		confirmCreate: async (what: string) => {
			if (approved) return true;
			// Una CLI humana sin terminal ni --create conserva su diagnóstico de uso.
			if (!io.interactive && values.create !== true && !isAgentSession(io)) return false;
			await enforce({ operation: "link_create", summary: `Crear lo que falte en OMI para ${projectSlug}`,
				diff: `Proyecto: ${projectSlug}\nServices: ${services.map((s) => s.name).join(", ")}\nAmbientes: ${request.environments?.join(", ") ?? "stage"}\n+ ${what}` }, guard);
			approved = true;
			return true;
		},
	};
	const result = await linkProject(request, context);
	if (values.json === true) {
		printJson(result, io);
		return EXIT_OK;
	}
	io.out(`Vinculado ${result.link.organizationSlug}/${result.link.projectSlug}`);
	for (const file of result.kit) io.out(`  ${file.status.padEnd(9)} ${file.path}`);
	for (const warning of result.warnings) io.err(`aviso: ${warning}`);
	return EXIT_OK;
}
