import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { tokens } from "./presentation.ts";

/** Only identify OpenAI IDs in their own namespace, not a custom model called Sol. */
export function openAIModelId(model: Model<Api>): string | undefined {
	const id = model.id.toLowerCase();
	const native = ["openai", "openai-codex", "azure"].includes(model.provider);
	const bare = id.startsWith("openai/") ? id.slice(7) : native ? id : undefined;
	return bare && /^(?:gpt-|o\d+(?:-|$)|chat-latest$)/.test(bare) ? bare : undefined;
}
export function openAIChoice(model: Model<Api>): "named" | "standard" | undefined {
	const id = openAIModelId(model)?.replace(/(?:-\d{4}-\d{2}-\d{2}|-\d{8})$/, "");
	if (!id) return undefined;
	if (/^gpt-\d+(?:[.-]\d+)*-(?:sol|terra|luna|astra)$/.test(id)) return "named";
	if (/^gpt-\d+(?:\.\d+)*(?:-(?:mini|nano|pro|codex(?:-spark)?))?$/.test(id)) return "standard";
	return undefined;
}

export interface ModelProfile {
	capability: "Máxima" | "Muy alta" | "Alta" | "Especializado";
	description: string;
	source: string;
	reviewedOn: string;
	evidence: string;
}
// Editorial translations of the provider's documented positioning, not a score
// inferred from price, context size, or reasoning-effort settings. Exact IDs only:
// a future Sol/Terra version must not inherit an unverified quality claim.
const OPENAI_PROFILES: Readonly<Record<string, Omit<ModelProfile, "source" | "reviewedOn">>> = {
	"gpt-6-astra": {
		capability: "Máxima", description: "Para código y razonamiento de máxima exigencia.",
		evidence: "Our most capable model for the most demanding work.",
	},
	"gpt-6.1-sol": {
		capability: "Muy alta", description: "Código y trabajo complejo; cerca de Astra.",
		evidence: "Near-Astra performance for complex work at a lower cost.",
	},
	"gpt-6.1-terra": {
		capability: "Muy alta", description: "Visión, uso de apps y escritura.",
		evidence: "Reasoning: Highest. A fast, efficient model for visual reasoning, precise computer use, and clear, natural writing.",
	},
	"gpt-6-luna": {
		capability: "Alta", description: "Para tareas puntuales y de alto volumen.",
		evidence: "Reasoning: High. Our most efficient model for focused, high-volume tasks.",
	},
	"gpt-daybreak-blue-latest": {
		capability: "Especializado", description: "Seguridad defensiva; alias obsoleto.",
		evidence: "An alias for flagship general-purpose models with safeguards for defensive cybersecurity work. This alias is deprecated.",
	},
};
export function modelProfile(model: Model<Api>): ModelProfile | undefined {
	const id = openAIModelId(model);
	const profile = id ? OPENAI_PROFILES[id] : undefined;
	return profile ? { ...profile, source: `https://developers.openai.com/api/docs/models/${id}`, reviewedOn: "2026-11-10" } : undefined;
}
export function modelDescription(model: Model<Api>): string {
	const profile = modelProfile(model);
	if (profile) return profile.description;
	const id = openAIModelId(model);
	if (id?.includes("daybreak")) return "Uso no documentado; alias latest sin versión informada.";
	if (id && /(?:^|-)cyber(?:-|$)/.test(id)) return "Uso no documentado en el catálogo.";
	if (/(?:^|[-/])(?:preview|experimental|exp)(?:-|$)/i.test(model.id)) return "Versión de prueba, según su nombre.";
	if (/(?:^|-)latest$/i.test(model.id)) return "Alias latest: el catálogo no informa la versión.";
	if (id?.includes("codex")) return "Para programar (familia Codex).";
	const levels = getSupportedThinkingLevels(model);
	if (!levels.some((level) => level !== "off")) return "No tiene un ajuste de análisis previo.";
	if (!levels.includes("off")) return "Analiza antes de responder; podés regularlo, no apagarlo.";
	return "Podés elegir cuánto analiza o desactivarlo.";
}

/** Catalogue rates are USD per million tokens, not account balance or plan quotas. */
export function modelPrice(model: Model<Api>, compact = false): string {
	const { input, output, cacheRead } = model.cost;
	if (![input, output, cacheRead].every((value) => Number.isFinite(value) && value >= 0) || (input === 0 && output === 0)) {
		return compact ? "Precio API no informado." : "Tarifa API: sin referencia útil en el catálogo; no implica que sea gratis.";
	}
	const usd = (value: number) => `$${Number(value.toPrecision(6))}`;
	return `${compact ? "API base · USD/1M tokens" : "USD / 1M tokens"}: ${usd(input)} entrada · ${usd(output)} salida${!compact && cacheRead > 0 ? ` · ${usd(cacheRead)} lectura caché` : ""}`;
}
export function modelPriceNote(model: Model<Api>): string {
	const thresholds = model.cost.tiers?.map((tier) => tokens(tier.inputTokensAbove)).join(" / ");
	return `${thresholds ? `Tarifa base; cambia sobre ${thresholds} tokens. ` : "Referencia API de catálogo. "}No indica saldo ni cuota del plan.`;
}
export function modelCapabilities(model: Model<Api>): string {
	const input = model.input.map((kind) => kind === "image" ? "imagen" : "texto").join(" + ");
	return `Entrada: ${input} · Salida máx.: ${tokens(model.maxTokens)}`;
}
export function thinkingLabel(level: ThinkingLevel): string {
	const labels: Record<ThinkingLevel, string> = { off: "Sin análisis extra", minimal: "Mínimo", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo" };
	return labels[level];
}
