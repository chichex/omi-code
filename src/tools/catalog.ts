// Catálogo único de tools de OMI: lo consumen la TUI, la CLI y el servidor MCP.

import { deployTool, promoteTool } from "./deploy.ts";
import { envListTool, envSetTool } from "./env.ts";
import { jobsManageTool } from "./jobs.ts";
import { linkProjectTool } from "./link.ts";
import { crashLogsTool, logsTailTool } from "./logs.ts";
import { publishVersionTool } from "./publish.ts";
import { registryManageTool } from "./registry.ts";
import { postgresManageTool, resourcesListTool } from "./resources.ts";
import { postgresExecTool, postgresQueryTool } from "./sql.ts";
import { projectStatusTool } from "./status.ts";
import type { OmiTool } from "./types.ts";
import { visibilitySetTool } from "./visibility.ts";

export const CATALOG: readonly OmiTool[] = [
	linkProjectTool,
	projectStatusTool,
	envListTool,
	envSetTool,
	resourcesListTool,
	postgresManageTool,
	postgresQueryTool,
	postgresExecTool,
	registryManageTool,
	visibilitySetTool,
	jobsManageTool,
	publishVersionTool,
	deployTool,
	promoteTool,
	logsTailTool,
	crashLogsTool,
];
