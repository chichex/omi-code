/**
 * @deprecated Usá `./artifact-paths.ts` (issue #103, CA-1). Este módulo solo
 * reexporta los nombres anteriores hasta que una spec posterior retire la
 * lectura de `.sdd/`.
 *
 * Cambio de forma: `resolveSddArtifactDirs` y `trackedSddArtifactDirs` ahora
 * devuelven los seis lugares,
 * `{ tracked, local, chicheTracked, chicheLocal, legacyTracked, legacyLocal }`,
 * y `tracked`/`local` apuntan a `.omi/` y `<git-common-dir>/omi/`. Un
 * objeto con la forma vieja `{ tracked, local }` se sigue aceptando al leer:
 * los lugares que faltan se saltean. `localSddArtifactDir` conserva su
 * resultado, `<git-common-dir>/sdd/<kind>`.
 */
import { type ArtifactKind, localArtifactDir } from "./artifact-paths.ts";

export {
	artifactReadDirs as sddArtifactReadDirs,
	defaultGitRunner,
	isArtifactPath as isSddArtifactPath,
	listArtifacts as listSddArtifacts,
	resolveArtifactDirs as resolveSddArtifactDirs,
	resolveArtifactName as resolveSddArtifactName,
	resolveGitCommonDir,
	resolveRepoWorktrees,
	trackedArtifactDirs as trackedSddArtifactDirs,
} from "./artifact-paths.ts";
export type {
	ArtifactDirs as SddArtifactDirs,
	ArtifactEntry as SddArtifactEntry,
	ArtifactKind as SddArtifactKind,
	GitRunner,
} from "./artifact-paths.ts";

/** @deprecated `<git-common-dir>/sdd/<kind>`, como antes; lo nuevo va a `localArtifactDir`. */
export function localSddArtifactDir(commonDir: string, kind: ArtifactKind): string {
	return localArtifactDir(commonDir, kind, "sdd");
}
