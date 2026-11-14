// Motor de guardrails: decide qué puede hacer un agente sin un humano.
// Todo lo que muta omi-api pasa por enforce() antes de salir, en las tres caras.

import { GuardrailError } from "../core/errors.ts";

export type EnvironmentName = "stage" | "prod";

export type GuardedOperation =
	| "read"
	| "variables"
	| "jobs"
	| "publish"
	| "deploy"
	| "promote"
	| "secrets"
	| "resource"
	| "registry"
	| "visibility"
	| "decommission"
	| "link_create";

export interface GuardedAction {
	operation: GuardedOperation;
	environment?: EnvironmentName;
	/** Título corto de la confirmación. */
	summary: string;
	/** Cambio exacto que va a ocurrir. Nunca lleva el valor de un secreto. */
	diff: string;
}

export type Tier = "free" | "stage_autonomous" | "human_required";

export interface Guard {
	readonly surface: "tui" | "cli" | "mcp";
	/** Hay una forma de preguntarle a un humano ahora. */
	readonly canAsk: boolean;
	/** La sesión ya autorizó operar stage: un flag o un sí previo. */
	readonly stageAuthorized: boolean;
	/** Aprobación explícita previa a la operación, como `--yes`. */
	readonly preApproved: boolean;
	ask(action: GuardedAction): Promise<boolean>;
	grantStage(): void;
}

/** Sólo estas operaciones son autónomas en stage. Todo lo demás exige un humano. */
const STAGE_SCOPED: readonly GuardedOperation[] = ["variables", "jobs", "deploy"];

export function classify(action: GuardedAction): Tier {
	if (action.operation === "read") return "free";
	if (action.operation === "publish") return "stage_autonomous";
	if (STAGE_SCOPED.includes(action.operation) && action.environment === "stage") return "stage_autonomous";
	return "human_required";
}

export function decide(action: GuardedAction, guard: Guard): "allow" | "ask" | "reject" {
	const tier = classify(action);
	if (tier === "free") return "allow";
	if (tier === "stage_autonomous" && guard.stageAuthorized) return "allow";
	if (guard.preApproved) return "allow";
	return guard.canAsk ? "ask" : "reject";
}

function rejected(action: GuardedAction): GuardrailError {
	return new GuardrailError(`${action.summary}: requiere confirmación humana`, action.diff);
}

/** Frena antes de mandar nada a la API si ya se sabe que no habrá quien confirme. */
export function assertCanProceed(action: GuardedAction, guard: Guard): void {
	if (decide(action, guard) === "reject") throw rejected(action);
}

export async function enforce(action: GuardedAction, guard: Guard): Promise<void> {
	const decision = decide(action, guard);
	if (decision === "allow") return;
	if (decision === "reject") throw rejected(action);
	if (!(await guard.ask(action))) {
		throw new GuardrailError(`${action.summary}: rechazado por el humano`, action.diff, "guardrail_declined");
	}
	if (classify(action) === "stage_autonomous") guard.grantStage();
}
