// Presentation adapter for Pi 1.5.0. Native components, outputs and execution stay untouched.
import { resolve } from "node:path";
import type { Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fit, text } from "./presentation.ts";

type Kind = "shell" | "read" | "edit" | "write" | "search" | "other";
interface ToolRow {
	component: ToolExecutionComponent;
	name: string;
	kind: Kind;
	key: string;
	path: string | undefined;
	status: "preparing" | "running" | "done" | "failed";
	expanded: boolean;
	truncated: boolean;
}
interface Region { y: number; height: number; component?: Component; group?: ToolRow[] }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function kindOf(name: string): Kind {
	if (name === "bash" || name === "powershell") return "shell";
	if (name === "read" || name === "edit" || name === "write") return name;
	return ["grep", "find", "ls"].includes(name) ? "search" : "other";
}

/** Read only this pinned component's presentation metadata; unfamiliar contracts retain the native UI. */
function toolRow(component: ToolExecutionComponent): ToolRow | undefined {
	const name: unknown = Reflect.get(component, "toolName");
	const args: unknown = Reflect.get(component, "args");
	const cwd: unknown = Reflect.get(component, "cwd");
	const partial: unknown = Reflect.get(component, "isPartial");
	const started: unknown = Reflect.get(component, "executionStarted");
	const expanded: unknown = Reflect.get(component, "expanded");
	const result: unknown = Reflect.get(component, "result");
	if (typeof name !== "string" || !object(args) || typeof cwd !== "string" || typeof partial !== "boolean" || typeof started !== "boolean" || typeof expanded !== "boolean") return;
	if (result !== undefined && (!object(result) || typeof result.isError !== "boolean" || !Array.isArray(result.content)
		|| result.content.some((block: unknown) => !object(block) || block.type !== "text"))) return;
	const kind = kindOf(name); const path = typeof args.path === "string" ? resolve(cwd, args.path) : undefined;
	if (["read", "edit", "write"].includes(kind) && !path && !partial) return;
	const details = object(result) && object(result.details) ? result.details : undefined;
	const truncated = details && object(details.truncation) && details.truncation.truncated === true;
	return { component, name: text(name), kind, key: kind === "other" ? `other:${name}` : kind, path,
		status: result !== undefined && !partial ? object(result) && result.isError ? "failed" : "done" : started ? "running" : "preparing", expanded, truncated: !!truncated };
}

function summary(group: ToolRow[]): string {
	const first = group[0]!;
	const count = ["read", "edit", "write"].includes(first.kind) && group.every((item) => item.path)
		? new Set(group.map((item) => item.path)).size : group.length;
	const finished = group.filter((item) => item.status === "done").length;
	const state = first.status === "failed" ? "failed" : finished === group.length ? "done" : group.some((item) => item.status === "running") ? "running" : "preparing";
	const nouns: Record<Exclude<Kind, "other">, string> = { shell: "shell command", read: "file", edit: "file", write: "file", search: "search" };
	const past: Record<Kind, string> = { shell: "Ran", read: "Read", edit: "Edited", write: "Wrote", search: "Ran", other: "Used" };
	const present: Record<Kind, string> = { shell: "Running", read: "Reading", edit: "Editing", write: "Writing", search: "Running", other: "Using" };
	const verb = state === "failed" ? "Failed" : state === "done" ? past[first.kind] : state === "running" ? present[first.kind] : "Preparing";
	const noun = first.kind === "other" ? `${first.name} ${count} time${count === 1 ? "" : "s"}`
		: `${count} ${nouns[first.kind]}${count === 1 ? "" : first.kind === "search" ? "es" : "s"}`;
	return `${verb} ${noun}${(state === "running" || state === "preparing") && group.length > 1 ? ` · ${finished}/${group.length} done` : ""}`;
}

/** Compact adjacent tool rows, including failures. Expansion retains the native output and error details. */
export class CompactTranscript implements Component {
	private chat: Component;
	private Tool: typeof ToolExecutionComponent;
	private theme: () => Theme;
	private redraw: () => void;
	constructor(chat: Component, Tool: typeof ToolExecutionComponent, theme: () => Theme, redraw: () => void) {
		this.chat = chat; this.Tool = Tool; this.theme = theme; this.redraw = redraw;
	}
	private frame(width: number): { lines: string[]; regions: Region[] } {
		const children: unknown = Reflect.get(this.chat, "children");
		const isComponent = (value: unknown): value is Component => object(value) && typeof value.render === "function" && typeof value.invalidate === "function";
		if (!Array.isArray(children) || !children.every(isComponent)) return { lines: this.chat.render(width), regions: [{ y: 0, height: Infinity, component: this.chat }] };
		const lines: string[] = []; const regions: Region[] = []; let group: ToolRow[] = [];
		const native = (component: Component, rendered = component.render(width)) => {
			regions.push({ y: lines.length, height: rendered.length, component }); lines.push(...rendered);
		};
		const flush = () => {
			if (!group.length) return;
			const expanded = group.some((item) => item.expanded); const t = this.theme();
			lines.push(""); regions.push({ y: lines.length, height: 1, group });
			lines.push(fit(t.fg(group[0]?.status === "failed" ? "error" : "muted", ` ${expanded ? "▾" : "▸"} ${summary(group)}`)
				+ (group.some((item) => item.truncated) ? t.fg("warning", " [truncated]") : ""), width));
			if (expanded) for (const item of group) native(item.component);
			group = [];
		};
		for (const component of children) {
			const tool = component instanceof this.Tool ? toolRow(component) : undefined;
			if (tool) {
				if (group[0]?.key !== tool.key || (group[0]?.status === "failed") !== (tool.status === "failed")) flush();
				group.push(tool);
			} else {
				const rendered = component.render(width);
				if (!rendered.length) continue;
				flush(); native(component, rendered);
			}
		}
		flush(); return { lines, regions };
	}
	render(width: number): string[] { return this.frame(width).lines; }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") return;
		// Layout measurements at a different width must not change click targets.
		const { regions } = this.frame(event.width);
		const region = regions.find((item) => event.y >= item.y && event.y < item.y + item.height);
		if (!region) return;
		if (region.group) {
			if (event.type !== "click" || event.button !== "left") return;
			const expand = !region.group.some((item) => item.expanded);
			for (const item of region.group) item.component.setExpanded(expand);
			this.redraw(); return { handled: true };
		}
		return region.component?.handleMouse?.({ ...event, y: event.y - region.y, height: region.height });
	}
	invalidate(): void { this.chat.invalidate(); }
}
