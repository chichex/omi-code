// Primer módulo del entry compilado, ANTES de cualquier import de Pi (incluido runtime-setup).
// config.js lee package.json al evaluar el módulo: configurarlo luego de main es demasiado tarde.
import { homedir } from "node:os";
import { join } from "node:path";
import { agentDir, omiHome } from "./paths.ts";

const home = process.env.HOME ?? homedir();
const root = omiHome(home);
process.env.PI_PACKAGE_DIR = join(root, "runtime");
process.env.OMI_RUNTIME_DIR = join(root, "runtime");
process.env.PI_CODING_AGENT_DIR = agentDir(home);
