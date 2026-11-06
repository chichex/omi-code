// Catálogo único de tools de OMI: lo consumen la TUI, la CLI y el servidor MCP.

import { linkProjectTool } from "./link.ts";
import type { OmiTool } from "./types.ts";

export const CATALOG: readonly OmiTool[] = [linkProjectTool];
