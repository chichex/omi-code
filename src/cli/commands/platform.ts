// Subcomandos de plataforma: el registry de la organización y la visibilidad de un ambiente.

import { UsageError } from "../../core/errors.ts";
import { parseFlags } from "../flags.ts";
import type { Io } from "../io.ts";
import { runToolCommand } from "../tool-command.ts";

const YES = { yes: { type: "boolean" } } as const;

const REGISTRY_ACTIONS: Readonly<Record<string, string>> = { status: "status", hosts: "hosts", create: "create", "retry-route": "retry_route" };

export async function registryCommand(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(args, { ...YES, host: { type: "string" }, org: { type: "string" } });
	const [requested] = positionals;
	const action = requested !== undefined && Object.hasOwn(REGISTRY_ACTIONS, requested) ? REGISTRY_ACTIONS[requested] : undefined;
	if (action === undefined) throw new UsageError("uso: omi registry <status|hosts|create|retry-route>");
	return runToolCommand("omi_registry_manage", { action, hostId: values.host, organizationSlug: values.org }, io, values);
}

export async function visibilityCommand(args: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(args, { ...YES, service: { type: "string" }, env: { type: "string" } });
	const [verb, visibility] = positionals;
	if (verb !== "set" || visibility === undefined) throw new UsageError("uso: omi visibility set <privado|organizacion|publico> --env <stage|prod>");
	return runToolCommand("omi_visibility_set", { service: values.service, environment: values.env, visibility }, io, values);
}
