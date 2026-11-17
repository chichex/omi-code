// Contenido informativo a partir de snapshots; abrir/cerrar modales y sus efectos queda en index.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workspaceName, type GitSnapshot, type GithubItem, type Resources } from "./data.ts";
import { ACTION_GROUPS, type ActionGroup, type ActionState } from "./github-actions.ts";
import type { IssuePreparationEntry } from "./issue-registry.ts";
import { ISSUE_TYPES } from "./issue-worktree.ts";
import { field, notice, section, type ModalEntry } from "./modals.ts";
import { gib, text, tokens, type ModalOptions } from "./presentation.ts";
import type { BranchPullRequest } from "./pull-request.ts";
import type { GithubView } from "./read-views.ts";
import { subagentDuration, type SubagentTask } from "./subagents.ts";

export interface InfoDetail { title: string; content: ModalEntry[]; options?: ModalOptions & { confirmLabel?: string } }

export function workspaceDetail(snapshot: { cwd: string; git: GitSnapshot | undefined; gitError: boolean }): InfoDetail {
	const { cwd, git, gitError } = snapshot; const linked = git?.linked === true;
	return { title: "Ubicación de trabajo", content: [notice(workspaceName(git), "syntaxType"), field("Branch", git ? `${git.detached ? "HEAD separado · " : ""}${git.branch}` : "—", "syntaxType"),
		"", section("Directorios"), field("Directorio activo", cwd), field("Raíz del checkout", git?.root ?? "—"), field("Repo principal", git?.mainRoot ?? "—"),
		...(git ? ["", section("Estado Git"), field("Archivos modificados", String(git.changeCount)), field("Upstream", git.tracking === false ? "sin configurar" : git.upstream ?? "no disponible"),
			field("Commits", `↑${git.ahead ?? "—"} ↓${git.behind ?? "—"}`), notice("↑ commits locales por subir · ↓ commits del upstream por traer."),
			notice("Comparación con la referencia local del último fetch; no consulta el remoto. Para actualizarla, ejecutá git fetch. Los archivos sin commit se cuentan por separado.")] : []), "",
		notice(git?.linked ? "Este worktree tiene directorio e índice propios. Comparte historia y referencias Git. No es un sandbox: no aísla credenciales, procesos ni servicios." : "No hay un worktree enlazado activo."),
		...(linked ? [notice("Enter vuelve al repo principal y retoma su conversación. Conserva la rama actual de ese checkout y todo el trabajo del issue; no hace git checkout main.", "accent")] : []),
		...(gitError ? [notice("Estado Git desactualizado: no se pudo refrescar.", "warning")] : [])], options: { color: "syntaxType", subtitle: "Proyecto · checkout y sincronización local", ...(linked ? { confirmLabel: "volver al repo" } : {}) } };
}

export function branchPrDetail(snapshot: { git: GitSnapshot | undefined; pr: BranchPullRequest | undefined; error: string | undefined; loading: boolean }): InfoDetail {
	const { git, pr, error, loading } = snapshot;
	return { title: "PR de la rama actual", content: [field("Rama", git ? git.branch : "sin repositorio Git", "syntaxType"), "",
		...(error ? [notice(error + (pr ? " · enlace desactualizado (*)" : ""), "warning")] : []),
		...(pr ? [notice(`PR #${pr.number} · ${pr.title}`, "mdLink"), "", field("Estado", `${pr.state}${pr.draft ? " · borrador" : ""}`,
			pr.draft ? "warning" : pr.state === "MERGED" ? "syntaxType" : pr.state === "OPEN" ? "success" : "muted"), "", pr.url]
			: [notice(!git ? "Sin repositorio Git." : git.detached ? "HEAD separado: no hay una rama actual." : error ? "No se pudo consultar el PR." : loading ? "Consultando PR…" : "No hay un PR asociado a esta rama.")]),
	], options: { color: "mdLink", subtitle: "GitHub · pull request del checkout activo" } };
}

export function actionsDetail(actions: Readonly<Record<ActionGroup, ActionState>>): InfoDetail {
	return { title: "GitHub Actions", content: [notice("Estado de las ejecuciones de Actions; un ✓ no significa aprobación del PR."), "", ...ACTION_GROUPS.flatMap((group): ModalEntry[] => {
		const state = actions[group.id];
		return [section(group.label), ...(state.error ? [notice(state.error + (state.runs ? " · datos desactualizados" : ""), "warning")] : []),
			...(state.runs?.flatMap((run) => [notice(`${run.name} · ${run.status} · ${run.conclusion || "sin conclusión"}`,
				run.status !== "completed" ? "warning" : run.conclusion === "success" ? "success" : ["failure", "timed_out", "startup_failure", "action_required"].includes(run.conclusion) ? "error" : "muted"), notice(run.createdAt), run.url]) ?? [notice("Sin datos")]), ""];
	})], options: { color: "mdLink", subtitle: "GitHub · Claude reviews y releases" } };
}

export function resourcesDetail(r: Resources | undefined): InfoDetail {
	return { title: "Recursos · equipo donde corre OMI", content: r ? [field("Host", r.host, "syntaxVariable"), "", section("Equipo"),
		field("CPU total", r.cpu === undefined ? "esperando muestra" : `${r.cpu.toFixed(1)}%`, (r.cpu ?? 0) >= 90 ? "warning" : "syntaxVariable"),
		field("RAM usada", `${gib(r.totalRam - r.availableRam)} / ${gib(r.totalRam)}${r.memoryEstimated ? " (estimada)" : ""}`), field("RAM disponible", gib(r.availableRam)),
		field("Disco del proyecto", r.disk ? `${gib(r.disk.used)} usados / ${gib(r.disk.total)} · ${gib(r.disk.available)} disponibles` : "no disponible"), "", section("Proceso OMI"),
		field("Proceso OMI", `CPU ${r.processCpu?.toFixed(1) ?? "—"}% · RAM ${gib(r.rss)}`, "syntaxVariable"),
		notice("RAM OMI es RSS de este proceso; no suma herramientas ni otros subprocesos."), notice("CPU de OMI normalizada a la capacidad total del equipo."), "",
		notice("Estas métricas son del host de OMI, no de tu Mac si te conectaste por SSH.")] : [notice("Recolectando datos…")], options: { color: "syntaxVariable", subtitle: "Equipo · métricas del host, no de la infraestructura desplegada" } };
}

export function contextDetail(model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id" | "contextWindow"> | undefined, usage: ReturnType<ExtensionContext["getContextUsage"]>): InfoDetail {
	return { title: "Ventana de contexto", content: [field("Modelo", model ? `${model.provider}/${model.id}` : "sin modelo", "accent"), "",
		field("Uso", usage?.tokens == null ? "desconocido" : `${tokens(usage.tokens)} tokens (estimado)`), field("Límite", `${tokens(usage?.contextWindow ?? model?.contextWindow ?? 0)} tokens`),
		field("Ocupación", usage?.percent == null ? "—" : `${usage.percent.toFixed(1)}%`, (usage?.percent ?? 0) >= 90 ? "error" : (usage?.percent ?? 0) >= 80 ? "warning" : "success"), "",
		notice("El runtime usa el último uso informado por el modelo y estima los mensajes posteriores. Después de compactar puede ser desconocido hasta la siguiente respuesta."),
		notice("No inventamos un desglose por sistema, conversación y tools."), "", notice("Para compactar usá /compact. Cambiar el modelo no descarta contenido.", "warning")], options: { color: "warning", subtitle: "Sesión · uso estimado de la ventana del modelo" } };
}

export function subagentsDetail(tasks: readonly SubagentTask[], now: number): InfoDetail {
	return { title: "Subagentes", content: tasks.length ? tasks.flatMap((task): ModalEntry[] => [section(`${task.agent} · ${task.status}`), field("ID", text(task.id)), field("Tarea", task.title), field("Estado", task.status, task.status === "error" ? "error" : task.status === "done" ? "success" : "accent"), field("Tool actual", task.activity || "—"), field("Tiempo observado", subagentDuration(task, now)), field("Turnos", String(task.turns)), ""])
		.concat([notice("Cancelar un lote: /omi-subagents cancel <ID de tarea o lote>. No se guardan outputs ni historiales privados.")]) : [notice("Sin subagentes activos")], options: { color: "syntaxVariable", subtitle: "Delegación · roles, tareas y actividad" } };
}

// canBegin: el harness puede leer GitHub. Si no, el detalle no promete un Enter que va a fallar.
export function githubDetail(snapshot: { kind: GithubView; item: GithubItem; saved: IssuePreparationEntry | undefined; body: string; staleBody: boolean; canBegin: boolean }): InfoDetail {
	const { kind, item, saved, body, staleBody, canBegin } = snapshot; const offer = kind === "issues" && !saved?.error && canBegin; const record = saved?.record; const description = body.split("\n");
	return { title: `${kind === "issues" ? "Issue" : "PR"} #${item.number} · ${text(item.title)}`, content: [field("Autor", item.author, "accent"), field("Etiquetas GitHub", item.labels.join(", ") || "—", "syntaxType"),
		...(record ? [field("Clasificación local", ISSUE_TYPES[record.state.triage.type].label, "accent"), field("Rama", record.state.branch), field("Worktree", record.state.worktree),
			...(saved?.error || !canBegin ? [] : [notice(record.phase === "ready" ? "Enter pide tu confirmación para retomar el trabajo en la sesión guardada de este worktree. Conserva la conversación y los cambios; no reclasifica." : "Preparación pendiente. Enter pide tu confirmación y continúa lo guardado sin repetir el triage ni sobrescribir trabajo.", "accent")])] : offer ? [notice("Enter pide tu confirmación para empezar el trabajo: worktree nuevo desde main local, sesión propia y exploración. No escribe código hasta que apruebes la receta.", "accent")] : []),
		...(saved?.error ? [notice(`Recuperación pendiente: ${saved.error}`, "warning")] : []),
		...(kind === "issues" && !canBegin ? [notice("Offline (--offline o PI_OFFLINE): empezar o retomar el trabajo necesita GitHub. Para abrir una sesión guardada usá /resume.", "warning")] : []),
		...(kind === "prs" ? [notice(`${item.draft ? "Borrador" : "Abierto"} · ${item.head} → ${item.base}`, item.draft ? "warning" : "success"), field("Revisión", item.review || "sin decisión")] : []),
		item.url, "", section("Descripción"), ...(staleBody ? [notice(body ? "No se pudo actualizar GitHub; se muestra la descripción local guardada." : "No se pudo cargar la descripción de GitHub. El estado local guardado sigue disponible.", "warning")] : []), ...description.slice(0, 1000), ...(description.length > 1000 ? [notice("[Descripción recortada a 1000 líneas]", "warning")] : [])],
		options: { color: kind === "issues" ? "syntaxType" : "mdLink", subtitle: `GitHub · ${kind === "issues" ? "issue · preparar o retomar" : "pull request · sólo lectura"}`, ...(offer ? { confirmLabel: record ? "retomar trabajo" : "iniciar trabajo" } : {}) } };
}
