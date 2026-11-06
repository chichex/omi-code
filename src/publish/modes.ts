// Los dos modos de D7: por tag, para que publique el CI del kit, o directo con docker y regctl.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { OmiError } from "../core/errors.ts";
import type { Runner } from "../core/exec.ts";
import type { PublishKit } from "../project/kit.ts";
import type { ServiceLink } from "../project/link.ts";
import { LABEL_CREATED, LABEL_REVISION, LABEL_VERSION, REGISTRY_CHUNK_BYTES } from "../protocol/constants.ts";
import { runChecked } from "./preflight.ts";

export async function publishByTag(root: string, tag: string, runner: Runner): Promise<void> {
	const existing = await runner.run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: root });
	if (existing.code === 0) {
		throw new OmiError("tag_exists", `el tag ${tag} ya existe`, { hint: "publicá una versión nueva: OMI no repite tags" });
	}
	await runChecked(runner, "git", ["tag", tag], { cwd: root });
	try {
		await runChecked(runner, "git", ["push", "origin", `refs/tags/${tag}`], { cwd: root });
	} catch (error) {
		// Un tag local sin empujar bloquearía el reintento.
		await runner.run("git", ["tag", "-d", tag], { cwd: root });
		throw error;
	}
}

export interface DirectPublish {
	root: string;
	service: ServiceLink;
	version: string;
	kit: PublishKit;
	/** Credencial de push. Sólo viaja por stdin de regctl. */
	password: string;
	runner: Runner;
	now?: Date;
}

export async function publishDirect(request: DirectPublish): Promise<void> {
	const { root, service, version, kit, password, runner } = request;
	const { stdout } = await runChecked(runner, "git", ["rev-parse", "HEAD"], { cwd: root });
	const commit = stdout.trim();
	const created = (request.now ?? new Date()).toISOString();
	const image = `${kit.image}:${version}`;
	const workdir = await mkdtemp(join(tmpdir(), "omi-publish-"));
	try {
		await runChecked(
			runner,
			"docker",
			[
				"build",
				"--build-arg", `VERSION=${version}`,
				"--build-arg", `GIT_COMMIT=${commit}`,
				"--build-arg", `BUILD_DATE=${created}`,
				"--label", `${LABEL_VERSION}=${version}`,
				"--label", `${LABEL_REVISION}=${commit}`,
				"--label", `${LABEL_CREATED}=${created}`,
				"-t", image,
				"-f", posix.join(service.path, service.dockerfile),
				service.path,
			],
			{ cwd: root },
		);
		const archive = join(workdir, "image.tar");
		await runChecked(runner, "docker", ["save", image, "-o", archive], { cwd: root });
		// Igual que el kit: HOME temporal para que el login de regctl no quede en la máquina.
		const env = { HOME: workdir };
		const chunk = String(REGISTRY_CHUNK_BYTES);
		await runChecked(runner, "regctl", ["registry", "set", kit.registry_hostname, "--tls", "enabled", "--blob-chunk", chunk, "--blob-max", chunk, "--skip-check"], { env });
		await runChecked(runner, "regctl", ["registry", "login", kit.registry_hostname, "--user", kit.push_username, "--pass-stdin"], { env, input: password });
		await runChecked(runner, "regctl", ["image", "import", image, archive], { env });
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}
