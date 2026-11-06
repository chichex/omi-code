// Extensiones embebidas en `omi`. Los imports son estáticos para que `bun build --compile` las
// empaquete: una ruta dinámica quedaría afuera del binario.

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "#extensions/ask-user-question/index.ts";
import claudeToolRenderer from "#extensions/claude-tool-renderer.ts";
import githubIssueSelector from "#extensions/github-issue-selector.ts";
import githubIssues from "#extensions/github-issues.ts";
import githubPrs from "#extensions/github-prs/index.ts";
import grillTools from "#extensions/grill-tools/index.ts";
import inlineSkillAutocomplete from "#extensions/inline-skill-autocomplete/index.ts";
import subagent from "#extensions/subagent/index.ts";
import visualFooter from "#extensions/visual-footer.ts";
import warpStatus from "#extensions/warp-status.ts";
import workflowOrchestrator from "#extensions/workflow-orchestrator/index.ts";

export function embeddedExtensions(): InlineExtension[] {
	return [
		{ name: "ask-user-question", factory: askUserQuestion },
		{ name: "claude-tool-renderer", factory: claudeToolRenderer },
		{ name: "github-issue-selector", factory: githubIssueSelector },
		{ name: "github-issues", factory: githubIssues },
		{ name: "github-prs", factory: githubPrs },
		{ name: "grill-tools", factory: grillTools },
		{ name: "inline-skill-autocomplete", factory: inlineSkillAutocomplete },
		{ name: "subagent", factory: subagent },
		{ name: "visual-footer", factory: visualFooter },
		{ name: "warp-status", factory: warpStatus },
		{ name: "workflow-orchestrator", factory: workflowOrchestrator },
	];
}
