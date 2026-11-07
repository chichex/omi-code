import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, decide, enforce, type Guard, type GuardedAction, type Tier } from "../src/guardrails/policy.ts";
import { cliGuard, isAgentSession } from "../src/guardrails/surfaces.ts";
import { GUARDRAIL_CONFIRMATION_REQUIRED, GuardrailError } from "../src/core/errors.ts";
import { testIo } from "./helpers/io.ts";

function action(operation: GuardedAction["operation"], environment?: GuardedAction["environment"]): GuardedAction {
	return { operation, ...(environment === undefined ? {} : { environment }), summary: "resumen", diff: "diff exacto" };
}

const matrix: [string, GuardedAction, Tier][] = [
	["una lectura", action("read"), "free"],
	["una lectura de prod", action("read", "prod"), "free"],
	["variables no secretas en stage", action("variables", "stage"), "stage_autonomous"],
	["jobs en stage", action("jobs", "stage"), "stage_autonomous"],
	["publicar una versión", action("publish"), "stage_autonomous"],
	["desplegar en stage", action("deploy", "stage"), "stage_autonomous"],
	["desplegar en prod", action("deploy", "prod"), "human_required"],
	["promover a prod", action("promote", "prod"), "human_required"],
	["variables en prod", action("variables", "prod"), "human_required"],
	["jobs en prod", action("jobs", "prod"), "human_required"],
	["secretos en stage", action("secrets", "stage"), "human_required"],
	["secretos en prod", action("secrets", "prod"), "human_required"],
	["Postgres en stage", action("resource", "stage"), "human_required"],
	["Postgres en prod", action("resource", "prod"), "human_required"],
	["baja en stage", action("decommission", "stage"), "human_required"],
	["baja de proyecto", action("decommission"), "human_required"],
	["crear proyecto o service", action("link_create"), "human_required"],
	["variables sin ambiente", action("variables"), "human_required"],
	["deploy sin ambiente", action("deploy"), "human_required"],
];

for (const [name, target, tier] of matrix) {
	test(`classify_${name} es ${tier}`, () => {
		assert.equal(classify(target), tier);
	});
}

function guard(overrides: Partial<Guard> = {}): Guard {
	let stage = overrides.stageAuthorized ?? false;
	return {
		surface: "tui",
		canAsk: false,
		preApproved: false,
		ask: async () => false,
		...overrides,
		get stageAuthorized() {
			return stage;
		},
		grantStage() {
			stage = true;
		},
	};
}

const decisions: [string, GuardedAction, Partial<Guard>, "allow" | "ask" | "reject"][] = [
	["lectura sin nada", action("read"), {}, "allow"],
	["stage con sesión autorizada", action("deploy", "stage"), { stageAuthorized: true }, "allow"],
	["stage sin autorizar y con humano", action("deploy", "stage"), { canAsk: true }, "ask"],
	["stage sin autorizar ni humano", action("deploy", "stage"), {}, "reject"],
	["prod con sesión autorizada y humano", action("deploy", "prod"), { stageAuthorized: true, canAsk: true }, "ask"],
	["prod con sesión autorizada sin humano", action("deploy", "prod"), { stageAuthorized: true }, "reject"],
	["prod con aprobación explícita", action("deploy", "prod"), { preApproved: true }, "allow"],
	["secreto en stage autorizado sin humano", action("secrets", "stage"), { stageAuthorized: true }, "reject"],
	["secreto con humano", action("secrets", "stage"), { canAsk: true }, "ask"],
];

for (const [name, target, overrides, expected] of decisions) {
	test(`decide_${name} da ${expected}`, () => {
		assert.equal(decide(target, guard(overrides)), expected);
	});
}

test("enforce_sin humano rechaza con guardrail_confirmation_required y el diff", async () => {
	await assert.rejects(enforce(action("deploy", "prod"), guard()), (error: GuardrailError) => {
		assert.ok(error instanceof GuardrailError);
		assert.equal(error.code, GUARDRAIL_CONFIRMATION_REQUIRED);
		assert.equal(error.exitCode, 2);
		assert.equal(error.diff, "diff exacto");
		return true;
	});
});

test("enforce_muestra el diff exacto al preguntar y respeta un no", async () => {
	const seen: GuardedAction[] = [];
	const asking = guard({
		canAsk: true,
		ask: async (target) => {
			seen.push(target);
			return false;
		},
	});
	await assert.rejects(enforce(action("deploy", "prod"), asking), (error: GuardrailError) => error.code === "guardrail_declined" && error.exitCode === 2);
	assert.equal(seen[0]?.diff, "diff exacto");
});

test("enforce_un sí en stage autoriza el resto de la sesión", async () => {
	let asked = 0;
	const asking = guard({
		canAsk: true,
		ask: async () => {
			asked += 1;
			return true;
		},
	});
	await enforce(action("deploy", "stage"), asking);
	await enforce(action("variables", "stage"), asking);
	assert.equal(asked, 1);
});

test("enforce_un sí en prod no autoriza el siguiente", async () => {
	let asked = 0;
	const asking = guard({
		canAsk: true,
		ask: async () => {
			asked += 1;
			return true;
		},
	});
	await enforce(action("deploy", "prod"), asking);
	await enforce(action("deploy", "prod"), asking);
	assert.equal(asked, 2);
	assert.equal(asking.stageAuthorized, false);
});

test("cliGuard_un humano en la CLI tiene stage autorizado", () => {
	const cli = cliGuard(testIo({ homeDir: "/h" }), { yes: false });
	assert.equal(cli.stageAuthorized, true);
	assert.equal(cli.canAsk, false);
	assert.equal(cli.preApproved, false);
});

test("cliGuard_--yes aprueba en modo no interactivo", () => {
	assert.equal(cliGuard(testIo({ homeDir: "/h" }), { yes: true }).preApproved, true);
});

test("cliGuard_dentro de una sesión agéntica --yes no vale y stage no está autorizado", () => {
	const io = testIo({ homeDir: "/h", env: { OMI_AGENT_SESSION: "1" } });
	assert.equal(isAgentSession(io), true);
	const nested = cliGuard(io, { yes: true });
	assert.equal(nested.preApproved, false);
	assert.equal(nested.stageAuthorized, false);
});

test("cliGuard en sesión agéntica no confía en un TTY ni consume su respuesta", async () => {
	const io = testIo({ homeDir: "/h", env: { OMI_AGENT_SESSION: "1" }, interactive: true, answers: ["s"] });
	await assert.rejects(enforce(action("deploy", "prod"), cliGuard(io, { yes: true })), /confirmación humana/);
	assert.deepEqual(io.prompts, []);
});

test("cliGuard_interactivo muestra el diff por stderr y pregunta", async () => {
	const io = testIo({ homeDir: "/h", interactive: true, answers: ["s"] });
	const cli = cliGuard(io, { yes: false });
	assert.equal(await cli.ask(action("deploy", "prod")), true);
	assert.match(io.errors(), /diff exacto/);
});
