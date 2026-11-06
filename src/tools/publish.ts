// omi_publish_version: publicación híbrida de D7.

import { Type } from "typebox";
import { RefreshedVersionsSchema } from "../client/views.ts";
import { ApiError, OmiError } from "../core/errors.ts";
import { enforce } from "../guardrails/policy.ts";
import { publishByTag, publishDirect } from "../publish/modes.ts";
import { assertCleanTree, assertServiceContract, assertWorkflow } from "../publish/preflight.ts";
import { assertVersion, tagFor } from "../publish/version.ts";
import { CI_REGISTRY_SECRET } from "../protocol/constants.ts";
import { linkedService, openScope, readService, servicePath, type Scope } from "./scope.ts";
import { readSecretValue } from "./secrets.ts";
import { defineTool, type ToolRuntime } from "./types.ts";

const DEFAULT_TIMEOUT_SECONDS = 900;
/** Refrescar lee el registry: se espacia más que un polling común. */
const REFRESH_BACKOFF = 5;

async function awaitVersion(scope: Scope, service: string, version: string, timeoutSeconds: number, runtime: ToolRuntime): Promise<void> {
	const deadline = Date.now() + timeoutSeconds * 1_000;
	const path = `${servicePath(scope, service)}/versions/refresh`;
	do {
		try {
			const { versions } = await scope.client.request("POST", path, RefreshedVersionsSchema, { body: {} });
			if (versions.some((candidate) => candidate.tag === version)) return;
		} catch (error) {
			// El registry puede fallar un rato: sólo un 4xx dice que no tiene sentido seguir.
			if (!(error instanceof ApiError && error.status >= 500)) throw error;
		}
		runtime.progress?.(`esperando que OMI detecte ${version}`);
		await scope.client.wait(runtime.signal, scope.client.pollIntervalMs * REFRESH_BACKOFF);
	} while (Date.now() < deadline);
	throw new OmiError("version_not_detected", `OMI no detectó ${version} a tiempo`, {
		hint: "revisá el workflow, las labels OCI y que la versión coincida con el tag",
	});
}

export const publishVersionTool = defineTool({
	name: "omi_publish_version",
	label: "OMI: publicar versión",
	description:
		"Publica una versión de un service. via tag (por defecto) empuja el tag para que publique el CI del kit; via direct construye con docker y empuja con regctl. Espera a que OMI la detecte.",
	parameters: Type.Object({
		service: Type.Optional(Type.String()),
		version: Type.String({ description: "Semver sin v, por ejemplo 1.4.2" }),
		via: Type.Optional(Type.Union([Type.Literal("tag"), Type.Literal("direct")])),
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	run: async (params, runtime) => {
		assertVersion(params.version);
		const scope = await openScope(runtime);
		const service = linkedService(scope.link, params.service);
		const via = params.via ?? "tag";
		const root = runtime.io.cwd;
		await assertCleanTree(root, runtime.runner);
		await assertServiceContract(root, service, runtime.runner);
		const tag = tagFor(service.name, params.version, scope.link.services.length > 1);
		if (via === "tag") await assertWorkflow(root, service);
		await enforce(
			{
				operation: "publish",
				summary: `Publicar ${service.name} ${params.version}`,
				diff: via === "tag" ? `tag ${tag}, publica el CI del kit` : `docker build y regctl hacia el registry de ${scope.link.organizationSlug}`,
			},
			runtime.guard,
		);
		if (via === "tag") {
			await publishByTag(root, tag, runtime.runner);
		} else {
			const fromEnv = runtime.io.env[CI_REGISTRY_SECRET] === undefined ? undefined : CI_REGISTRY_SECRET;
			const password = await readSecretValue(CI_REGISTRY_SECRET, fromEnv, runtime);
			const { kit } = await readService(scope, service.name);
			await publishDirect({ root, service, version: params.version, kit, password, runner: runtime.runner });
		}
		await awaitVersion(scope, service.name, params.version, params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, runtime);
		return {
			text: `${service.name} ${params.version} publicada y detectada por OMI`,
			data: { service: service.name, version: params.version, via, ...(via === "tag" ? { tag } : {}) },
		};
	},
});
