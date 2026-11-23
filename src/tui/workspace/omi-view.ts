// Presenter de la pestaña OMI: proyecto, Foundations, lifecycle, continuidad y lo que falta, todo a la vista y en
// vertical, sin apretar nada. Puro: recibe el pin y la configuración que publicó el harness (otra extensión); la carga
// y las teclas viven en el controlador.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { configItemLines, type ConfigStatus } from "../../harness/config-doctor.ts";
import { continuityOverviewLines, lifecycleOverviewLines } from "../../harness/lifecycle-overview.ts";
import type { ConfigSnapshot, ConfigView } from "../development-config-view.ts";
import { foundationsDetail, type FoundationsPin } from "../development-foundations.ts";
import type { EnvironmentStatus } from "./data.ts";
import { surface, text } from "./presentation.ts";
import { age } from "./read-views.ts";

/** `pin`: Foundations fijo de la sesión, si ya se decidió. `config`: lo último que publicó el harness. `session`: hay sesión persistente. */
export interface OmiSnapshot {
	project: string | undefined; services: readonly string[]; environments: readonly EnvironmentStatus[]; error: string | undefined; at: number | undefined; now: number;
	pin: FoundationsPin | undefined; config: ConfigView | undefined; session: boolean;
}
type Tone = Parameters<Theme["fg"]>[0];
const HELP = "r actualizar · s configurar lo que falta · f editar Foundations · Esc chat";
const TONES: Record<ConfigStatus, Tone> = { ok: "success", falta: "warning", "formato-anterior": "warning", pendiente: "warning", invalido: "error", "no-disponible": "muted", postergado: "muted", "no-aplica": "dim" };

/** Parte cada línea al ancho sin cortar nada: lo partido sigue dos columnas más adentro que su sangría. */
function wrapped(lines: readonly string[], width: number): string[] {
	return lines.flatMap((line) => {
		const indent = line.length - line.trimStart().length, head = " ".repeat(1 + indent), rest = " ".repeat(3 + indent);
		return wrapTextWithAnsi(text(line.trimStart()), Math.max(1, width - rest.length)).map((part, index) => `${index ? rest : head}${part}`);
	});
}
/** Sin pin, el motivo explica qué va a regir. Con pin, su aviso ya lo dice, salvo el formato anterior, que el aviso no nombra. */
function foundations(pin: FoundationsPin | undefined, config: ConfigSnapshot | undefined): string[] {
	const item = config?.diagnosis.items.find((entry) => entry.id === "foundations");
	const motive = item && item.status !== "ok" && (!pin || item.status === "formato-anterior") ? item.message : null;
	return foundationsDetail(pin, config ? { reading: config.reading, local: config.local, motive } : undefined);
}
/** Por qué todavía no hay datos de lifecycle, continuidad ni lo que falta. */
function waiting(config: Exclude<ConfigView, { status: "ready" }> | undefined, session: boolean): string {
	if (!session) return "Sin sesión persistente: la configuración no se lee.";
	if (!config) return "Todavía no hay datos: se leen al abrir la sesión. r vuelve a leer.";
	return config.status === "reading" ? "Leyendo la configuración de la KB…" : `No se pudo leer la configuración: ${config.reason}. r vuelve a leer.`;
}
function missing(t: Theme, snapshot: ConfigSnapshot, width: number): string[] {
	const items = snapshot.diagnosis.items.filter((item) => item.status !== "ok");
	if (!items.length) return wrapped(["Todo configurado."], width).map((line) => t.fg("success", line));
	return items.flatMap((item) => {
		const [head, ...resolve] = configItemLines(item);
		return [...wrapped([head], width).map((line) => t.fg(TONES[item.status], line)), ...wrapped(resolve, width).map((line) => t.fg("dim", line))];
	});
}

export function omiViewLines(t: Theme, snapshot: OmiSnapshot, width: number): string[] {
	const { project, services, environments, error, at, now, config, pin, session } = snapshot;
	const ready = config?.status === "ready" ? config : undefined;
	const heading = (title: string) => ["", t.fg("accent", ` ${title}`)];
	const lines = [t.bold(" OMI"), ...wrapped([HELP], width).map((line) => t.fg("dim", line)), "", t.fg("accent", ` PROYECTO OMI · ${age(at, now)}`)];
	if (error) lines.push(...wrapped([`${error}${project ? " · datos desactualizados" : ""}`], width).map((line) => t.fg("warning", line)));
	if (project) {
		lines.push(...wrapped([project], width), "", t.fg("accent", " SERVICIOS Y AMBIENTES"));
		for (const service of services) {
			lines.push(...wrapped([service], width).map((line) => t.bold(line)));
			const serviceEnvironments = environments.filter((environment) => environment.service === service);
			// El estado va al final: partir la línea lo deja a la vista.
			for (const environment of serviceEnvironments) lines.push(...wrapped([`  ${environment.name} · ${environment.version ?? "sin versión"} · ${environment.state}`], width));
			if (!serviceEnvironments.length) lines.push(...wrapped(["  Sin ambientes informados."], width).map((line) => t.fg("muted", line)));
		}
	} else if (!error) lines.push(...wrapped([at ? "Sin proyecto OMI vinculado. Usá omi init para vincularlo." : "Consultando vínculo y ambientes OMI…"], width));
	// Sin datos, cada sección dice por qué; con datos, cada una muestra lo suyo.
	const rows = (build: (shown: ConfigSnapshot) => string[]) => config?.status === "ready" ? build(config.snapshot) : wrapped([waiting(config, session)], width);
	lines.push(...heading("FOUNDATIONS · cuándo te pide confirmación el agente"), ...wrapped(foundations(pin, ready?.snapshot), width));
	lines.push(...heading("LIFECYCLE · Review · Land · Ship"), ...rows((shown) => wrapped(lifecycleOverviewLines(shown.lifecycle), width)));
	lines.push(...heading("CONTINUIDAD · cómo sigue después del PR draft"), ...rows((shown) => wrapped(continuityOverviewLines(shown.lifecycle), width)));
	lines.push(...heading(`FALTA CONFIGURAR${ready ? ` · ${age(ready.at, now)}${ready.refreshing ? " · actualizando…" : ""}` : ""}`));
	if (ready?.error) lines.push(...wrapped([`No se pudo actualizar: ${ready.error}. Se muestra la lectura anterior.`], width).map((line) => t.fg("warning", line)));
	lines.push(...rows((shown) => missing(t, shown, width)));
	lines.push("", t.fg("accent", " OPERACIONES OMI"), " Estado, variables, recursos, jobs, versiones, logs y deploys:", " pedilos en Chat. Se conservan las herramientas y confirmaciones.", "", t.fg("dim", " Vista de sólo lectura. Un estado running no es un health check."));
	return lines.map((line) => surface(t, line, width));
}
