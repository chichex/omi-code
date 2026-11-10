import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { modelCapabilities, modelDescription, modelPrice, modelPriceNote, modelProfile, openAIChoice, openAIModelId, thinkingLabel } from "./model-info.ts";
import { align, fit, modalLines, text, tokens } from "./presentation.ts";

export interface ModelChoice { model: Model<Api>; thinking: ThinkingLevel }
export interface PickerResult { choice?: ModelChoice; favorites: string[] }
export function modelKey(model: Model<Api>): string { return `${model.provider}/${model.id}`; }
export function filterModels(models: Model<Api>[], query: string, favorites: ReadonlySet<string>, onlyFavorites: boolean): Model<Api>[] {
	const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((model) => (!onlyFavorites || favorites.has(modelKey(model))) && words.every((word) => `${model.provider} ${model.id} ${model.name}`.toLocaleLowerCase().includes(word)))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}
// The catalogue has no release dates. Collapse known versioned families instead of
// maintaining a hard-coded list of model IDs that would immediately become stale.
// Unknown/custom models are kept; this is a recommendation, not an access check.
export function recommendedModels(models: Model<Api>[], keep: ReadonlySet<string> = new Set()): Model<Api>[] {
	const families = new Map<string, Model<Api>>();
	for (const model of models) {
		const id = model.id.toLowerCase();
		const family = /(?:^|[/:.])(?:claude|gpt|gemini|grok|kimi)-/.test(id)
			? id.replace(/-(?:preview|exp|latest).*$/, "").replace(/\d+(?:[.-]\d+)*/g, "").replace(/-+/g, "-").replace(/-$/, "")
			: /^o\d+(?:-|$)/.test(id) ? id.replace(/^o\d+/, "o") : undefined;
		const key = `${model.provider}/${family ?? model.id}`;
		const previous = families.get(key);
		// Prefer the newest numeric version, then an undated alias over its snapshots.
		const version = (value: Model<Api>) => (value.id.toLowerCase()
			.replace(/(?:[-@:]\d{8}|-\d{4}-\d{2}-\d{2})(?=$|[-:])/g, "")
			.replace(/-(?:preview|exp|latest).*$/, "").match(/\d+/g) ?? []).join(".");
		const order = previous ? version(model).localeCompare(version(previous), undefined, { numeric: true }) : 1;
		const unstable = (value: Model<Api>) => /preview|experimental|(?:^|-)exp(?:-|$)/.test(value.id) ? 1 : 0;
		const tie = previous ? unstable(previous) - unstable(model) || previous.id.length - model.id.length : 0;
		if (!previous || order > 0 || (order === 0 && tie > 0)) families.set(key, model);
	}
	const latest = [...families.values()];
	const keys = new Set(latest.map(modelKey));
	// For OpenAI, a latest version of every historic/experimental branch is still
	// a huge list. Prefer the named range when present; otherwise the standard GPT
	// range. Never manufacture models or hide an explicit current/favorite choice.
	const namedProviders = new Set(latest.filter((model) => openAIChoice(model) === "named").map((model) => model.provider));
	const standardProviders = new Set(latest.filter((model) => openAIChoice(model) === "standard").map((model) => model.provider));
	return models.filter((model) => {
		if (keep.has(modelKey(model))) return true;
		if (!keys.has(modelKey(model))) return false;
		if (!openAIModelId(model)) return true;
		if (namedProviders.has(model.provider)) return openAIChoice(model) === "named";
		if (standardProviders.has(model.provider)) return openAIChoice(model) === "standard";
		return true; // No familiar range in scope: don't leave the picker empty.
	});
}
export class OmiModelPicker implements Component, Focusable {
	focused = true;
	capturesViewportInput = true;
	private input = new Input();
	private index = 0;
	private onlyFavorites = false;
	private showAll = false;
	private provider: string | undefined;
	private providers: string[];
	private recommended: ReadonlySet<string>;
	private thinking: ThinkingLevel;
	private selected: Model<Api> | undefined;
	private phase: "list" | "review" = "list";
	private rowMap = new Map<number, number>();
	private favoriteSet: Set<string>;
	private options: {
		models: Model<Api>[]; current?: Model<Api> | undefined; thinking: ThinkingLevel; favorites: string[]; initialQuery?: string;
		contextTokens: number | null; theme: Theme; maxRows: () => number; render: () => void; done: (result: PickerResult) => void;
	};
	constructor(options: OmiModelPicker["options"]) {
		this.options = options;
		this.thinking = options.thinking; this.favoriteSet = new Set(options.favorites);
		this.providers = [...new Set(options.models.map((model) => model.provider))].sort();
		this.recommended = new Set(recommendedModels(options.models).map(modelKey));
		this.provider = !options.initialQuery && options.current && this.providers.includes(options.current.provider) ? options.current.provider : undefined;
		this.input.setValue(options.initialQuery ?? "");
		const current = this.list().findIndex((model) => modelKey(model) === (options.current ? modelKey(options.current) : ""));
		this.index = Math.max(0, current);
	}
	private list(): Model<Api>[] {
		const keep = new Set(this.favoriteSet);
		if (this.options.current) keep.add(modelKey(this.options.current));
		// Searching and favorites can always recover older models without a mode change.
		const curated = !this.showAll && !this.onlyFavorites && !this.input.getValue().trim();
		const models = curated ? this.options.models.filter((model) => this.recommended.has(modelKey(model)) || keep.has(modelKey(model))) : this.options.models;
		const list = filterModels(models.filter((model) => !this.provider || model.provider === this.provider), this.input.getValue(), this.favoriteSet, this.onlyFavorites);
		if (curated) {
			const order = (model: Model<Api>) => { const id = openAIModelId(model); const index = ["sol", "terra", "luna", "astra"].findIndex((variant) => id?.endsWith(`-${variant}`)); return index < 0 ? 4 : index; };
			list.sort((a, b) => a.provider.localeCompare(b.provider) || order(a) - order(b));
		}
		return list;
	}
	private cycleProvider(direction: number): void {
		const tabs = [undefined, ...this.providers];
		this.provider = tabs[(tabs.indexOf(this.provider) + tabs.length + direction) % tabs.length];
		this.index = 0;
	}
	private cancel(): void { this.options.done({ favorites: [...this.favoriteSet] }); }
	private choose(): void {
		const model = this.list()[this.index]; if (!model) return;
		this.selected = model; this.phase = "review";
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		if (!levels.includes(this.thinking)) this.thinking = levels.includes("high") ? "high" : levels[0] ?? "off";
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.cancel(); return; }
		if (this.phase === "review" && this.selected) {
			if (matchesKey(data, "backspace")) { this.phase = "list"; }
			else if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "left")) {
				const levels = getSupportedThinkingLevels(this.selected) as ThinkingLevel[];
				const direction = matchesKey(data, "left") ? -1 : 1;
				if (levels.length) this.thinking = levels[(Math.max(0, levels.indexOf(this.thinking)) + levels.length + direction) % levels.length]!;
			} else if (matchesKey(data, "return") && (this.options.contextTokens ?? 0) <= this.selected.contextWindow) {
				this.options.done({ choice: { model: this.selected, thinking: this.thinking }, favorites: [...this.favoriteSet] }); return;
			}
		} else {
			const list = this.list();
			if (matchesKey(data, "tab")) this.cycleProvider(1);
			else if (matchesKey(data, "shift+tab")) this.cycleProvider(-1);
			else if (matchesKey(data, "ctrl+a")) { this.showAll = !this.showAll; this.index = 0; }
			else if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
			else if (matchesKey(data, "down")) this.index = Math.min(Math.max(0, list.length - 1), this.index + 1);
			else if (matchesKey(data, "pageUp")) this.index = Math.max(0, this.index - 6);
			else if (matchesKey(data, "pageDown")) this.index = Math.min(Math.max(0, list.length - 1), this.index + 6);
			else if (matchesKey(data, "ctrl+f")) { this.onlyFavorites = !this.onlyFavorites; this.index = 0; }
			else if (matchesKey(data, "ctrl+s")) { const model = list[this.index]; if (model) { const key = modelKey(model); if (this.favoriteSet.has(key)) this.favoriteSet.delete(key); else this.favoriteSet.add(key); this.index = Math.min(this.index, Math.max(0, this.list().length - 1)); } }
			else if (matchesKey(data, "return")) this.choose();
			else { this.input.handleInput(data); this.index = 0; }
		}
		this.options.render();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.phase !== "list") return undefined;
		if (event.type === "wheel") { const list = this.list(); this.index = Math.max(0, Math.min(list.length - 1, this.index + Math.sign(event.wheelDelta ?? 0))); this.options.render(); return { handled: true }; }
		const index = this.rowMap.get(event.y);
		if (event.type === "click" && index !== undefined) { this.index = index; this.choose(); this.options.render(); return { handled: true }; }
		return undefined;
	}
	private details(model: Model<Api>, width: number): string[] {
		const { theme } = this.options; const profile = modelProfile(model);
		return [
			...wrapTextWithAnsi(text(modelDescription(model)), Math.max(1, width - 4)).slice(0, 2).map((line) => theme.fg("muted", line)),
			theme.fg("muted", `Capacidad: ${profile?.capability ?? "Sin referencia"}${profile ? " · guía de OpenAI" : ""}`),
			theme.fg("muted", modelCapabilities(model)),
			theme.fg("accent", modelPrice(model)),
			theme.fg("dim", modelPriceNote(model)),
			...(profile ? [theme.fg("dim", `Fuente: ${profile.source} · ${profile.reviewedOn}`)] : []),
		];
	}
	render(width: number): string[] {
		const { theme } = this.options; this.rowMap.clear();
		if (this.phase === "review" && this.selected) {
			const overflow = (this.options.contextTokens ?? 0) > this.selected.contextWindow;
			return modalLines(theme, "Usar modelo", [theme.fg("accent", text(this.selected.name)), text(modelKey(this.selected)), ...this.details(this.selected, width), '', `Contexto: ${tokens(this.selected.contextWindow)} tokens`, `Análisis: ${thinkingLabel(this.thinking)}  ← / → cambiar`, '',
				...(overflow ? [theme.fg("warning", "La sesión supera el límite del modelo."), "Revisá /compact antes de cambiar. No se descarta contenido."] : ["Misma conversación. Se aplica al próximo turno.", theme.fg("success", "Enter aplicar · Backspace volver")])], width);
		}
		this.input.focused = this.focused;
		const list = this.list();
		const selected = list[this.index]; const maxRows = this.options.maxRows();
		const detail = selected && maxRows >= 20 ? ['', theme.fg("muted", modelDescription(selected)), theme.fg("muted", modelPrice(selected, true))] : [];
		const pageSize = Math.max(1, Math.min(8, maxRows - 16 - detail.length));
		const start = Math.max(0, Math.min(this.index - Math.floor(pageSize / 2), list.length - pageSize));
		const providerLabel = this.provider ?? "Todos los proveedores";
		const mode = this.onlyFavorites ? "★ Favoritos" : this.showAll || this.input.getValue().trim() ? "Catálogo" : "Recomendados";
		const position = list.length > pageSize ? ` · ${this.index + 1}/${list.length}` : "";
		const lines = [theme.fg("accent", `‹ ${text(providerLabel)} ›  · Tab / Shift Tab`),
			this.input.render(Math.max(1, width - 4))[0] ?? "", '', theme.fg("muted", `${mode} · ${list.length} modelos${position}`), ''];
		for (let i = start; i < Math.min(list.length, start + pageSize); i++) {
			const model = list[i]!;
			const active = this.options.current && modelKey(model) === modelKey(this.options.current);
			const label = `${i === this.index ? "›" : " "} ${this.favoriteSet.has(modelKey(model)) ? "★" : " "} ${text(model.name)}${!this.provider ? ` · ${text(model.provider)}` : ""}${active ? " · actual" : ""}`;
			this.rowMap.set(4 + lines.length, i);
			const context = tokens(model.contextWindow);
			const badge = width >= 60 ? `  [${modelProfile(model)?.capability ?? "Sin referencia"}]` : "";
			const row = truncateToWidth(label, Math.max(1, width - 6 - context.length - visibleWidth(badge)), "…") + badge;
			lines.push(i === this.index ? theme.fg("accent", align(row, context, width - 4)) : align(row, theme.fg("muted", context), width - 4));
		}
		if (!list.length) lines.push(theme.fg("muted", "Sin modelos. Cambiá filtros/proveedor o usá /login."));
		lines.push(...detail, '', theme.fg("dim", "↑ ↓ elegir · Enter configurar"), theme.fg("dim", `Ctrl A ${this.showAll ? "recomendados" : "catálogo"} · Ctrl F favoritos · Ctrl S marcar`));
		return modalLines(theme, "Elegir modelo · OMI", lines, width).map((line) => fit(line, width));
	}
	invalidate(): void { this.input.invalidate(); }
}
