// GitHub Releases de omi-code: nombres de assets, versión más nueva y checksums.

import { Type } from "typebox";
import { Value } from "typebox/value";
import { OmiError } from "../core/errors.ts";

export const RELEASES_URL = "https://api.github.com/repos/chichex/omi-code/releases/latest";
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

export type Platform = (typeof PLATFORMS)[number];

const CHECKSUMS_FILE = "checksums.txt";
const REQUEST_TIMEOUT_MS = 30_000;

const ReleaseSchema = Type.Object({
	tag_name: Type.String(),
	assets: Type.Array(Type.Object({ name: Type.String(), browser_download_url: Type.String() })),
});

export interface LatestRelease {
	version: string;
	assets: Map<string, string>;
}

export function assetNames(platform: string): { binary: string; runtime: string; checksums: string } {
	return { binary: `omi-${platform}`, runtime: `omi-${platform}-runtime.tar.gz`, checksums: CHECKSUMS_FILE };
}

export function currentPlatform(platform: string = process.platform, arch: string = process.arch): Platform {
	const name = `${platform}-${arch}`;
	const known = PLATFORMS.find((candidate) => candidate === name);
	if (known === undefined) throw new OmiError("platform_unsupported", `omi no publica binarios para ${name}`);
	return known;
}

function parseVersion(version: string): { core: number[]; prerelease: boolean } {
	const [core = "", ...prerelease] = version.split("-");
	return { core: core.split(".").map(Number), prerelease: prerelease.length > 0 };
}

export function isNewer(current: string, latest: string): boolean {
	const a = parseVersion(current);
	const b = parseVersion(latest);
	for (const index of [0, 1, 2]) {
		const difference = (b.core[index] ?? 0) - (a.core[index] ?? 0);
		if (difference !== 0) return difference > 0;
	}
	return a.prerelease && !b.prerelease;
}

/** Formato de `sha256sum`: `<hash>  <nombre>`, con `*` opcional en modo binario. */
export function parseChecksums(text: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([0-9a-f]+)\s+\*?(.+)$/.exec(line.trim());
		if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[2], match[1]);
	}
	return entries;
}

export async function fetchLatestRelease(url: string): Promise<LatestRelease> {
	let response: Response;
	try {
		response = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch (error) {
		throw new OmiError("release_unreachable", "no se pudo consultar GitHub Releases", { cause: error });
	}
	if (response.status === 404) {
		throw new OmiError("release_not_found", "no hay releases publicadas de omi-code", {
			hint: "si el repo sigue privado, GitHub responde 404 sin credenciales",
		});
	}
	if (!response.ok) throw new OmiError("release_unreachable", `GitHub Releases respondió ${response.status}`);
	const payload: unknown = await response.json();
	if (!Value.Check(ReleaseSchema, payload)) throw new OmiError("release_unreachable", "GitHub Releases respondió algo inesperado");
	return {
		version: payload.tag_name.replace(/^v/, ""),
		assets: new Map(payload.assets.map((asset) => [asset.name, asset.browser_download_url])),
	};
}
