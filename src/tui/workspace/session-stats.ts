import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SessionStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	lastCost: number;
	responses: number;
}

/** Use the active branch, including pre-compaction usage, not alternative histories. */
export function sessionStats(entries: readonly SessionEntry[]): SessionStats {
	const total: SessionStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastCost: 0, responses: 0 };
	const amount = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
	const add = (usage: Usage) => {
		total.input += amount(usage.input); total.output += amount(usage.output);
		total.cacheRead += amount(usage.cacheRead); total.cacheWrite += amount(usage.cacheWrite); total.cost += amount(usage.cost.total);
	};
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			add(entry.message.usage); total.responses++; total.lastCost = amount(entry.message.usage.cost.total);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) add(entry.message.usage);
		else if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) add(entry.usage);
	}
	return total;
}
