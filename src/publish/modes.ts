// Los dos modos de D7: por tag, para que publique el CI del kit, o directo con docker y regctl.

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { OmiError } from "../core/errors.ts";
import type { Runner } from "../core/exec.ts";
import type { PublishKit } from "../project/kit.ts";
import type { ServiceLink } from "../project/link.ts";
import { LABEL_CREATED, LABEL_REVISION, LABEL_VERSION, REGISTRY_CHUNK_BYTES } from "../protocol/constants.ts";
import { runChecked } from "./preflight.ts";
import { registryProvenance } from "./registry-provenance.ts";

export async function publishByTag(root: string, tag: string, runner: Runner, expectedCommit?: string): Promise<void> {
	if (expectedCommit) {
		const actual = (await runChecked(runner, "git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
		if (actual !== expectedCommit) throw new OmiError("publication_sha_changed", "el checkout de publicación cambió de SHA");
	}
	const existing = await runner.run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: root });
	if (existing.code === 0) {
		throw new OmiError("tag_exists", `el tag ${tag} ya existe`, { hint: "publicá una versión nueva: OMI no repite tags" });
	}
	await runChecked(runner, "git", ["tag", tag, ...(expectedCommit ? [expectedCommit] : [])], { cwd: root });
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
	signal?: AbortSignal;
}
export interface PublishedImageReceipt { version: string; commitSha: string; image: string; digest: string; createdAt: string }
export interface EvidencedDirectPublish extends DirectPublish { captureProvenance: true; expectedCommit: string; beforeImport?: () => Promise<void> }

export function publishDirect(request: EvidencedDirectPublish): Promise<PublishedImageReceipt>;
export function publishDirect(request: DirectPublish): Promise<void>;
export async function publishDirect(request: DirectPublish | EvidencedDirectPublish): Promise<void | PublishedImageReceipt> {
	const { root, service, version, kit, password, runner } = request;
	const { stdout } = await runChecked(runner, "git", ["rev-parse", "HEAD"], { cwd: root });
	const commit = stdout.trim();
	if ("captureProvenance" in request && request.captureProvenance && commit !== request.expectedCommit) throw new OmiError("publication_sha_changed", "se publica sólo el SHA integrado fijado");
	request.signal?.throwIfAborted();
	const created = (request.now ?? new Date()).toISOString();
	const image = `${kit.image}:${version}`;
	const workdir = await mkdtemp(join(tmpdir(), "omi-publish-"));
	const iidfile = join(workdir, "built-image-id");
	const evidenced = "captureProvenance" in request && request.captureProvenance;
	try {
		await runChecked(
			runner,
			"docker",
			[
				"build", "--platform", "linux/amd64", ...(evidenced ? ["--iidfile", iidfile] : []),
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
		const builtImage = evidenced ? (await readFile(iidfile, "utf8")).trim() : image;
		if (evidenced && !/^sha256:[a-f0-9]{64}$/.test(builtImage)) throw new OmiError("publication_unverified", "build no informó imagen local inmutable");
		await runChecked(runner, "docker", ["save", builtImage, "-o", archive], { cwd: root });
		// Igual que el kit: HOME temporal para que el login de regctl no quede en la máquina.
		const env = { HOME: workdir };
		const chunk = String(REGISTRY_CHUNK_BYTES);
		await runChecked(runner, "regctl", ["registry", "set", kit.registry_hostname, "--tls", "enabled", "--blob-chunk", chunk, "--blob-max", chunk, "--skip-check"], { env });
		await runChecked(runner, "regctl", ["registry", "login", kit.registry_hostname, "--user", kit.push_username, "--pass-stdin"], { env, input: password });
		if (evidenced) await request.beforeImport?.();
		request.signal?.throwIfAborted();
		await runChecked(runner, "regctl", ["image", "import", image, archive], { env, ...(request.signal ? { signal: request.signal } : {}) });
		if ("captureProvenance" in request && request.captureProvenance) {
			const receipt = await registryProvenance(kit, version, request.expectedCommit, runner, env, request.signal);
			const after = (await runChecked(runner, "git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
			if (after !== request.expectedCommit) throw new OmiError("publication_sha_changed", "HEAD cambió al publicar; conservar recibo y reconciliar");
			return { ...receipt, createdAt: created };
		}
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}
