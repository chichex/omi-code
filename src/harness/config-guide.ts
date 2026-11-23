// Lo que falta configurar, para el contexto del agente. Proyección pura del diagnóstico que la sesión ya calculó:
// el setup lo corre la persona con /omi-setup; el agente no lo corre, no edita la KB ni concede permisos.
import type { ConfigDiagnosis, ConfigItem } from "./config-doctor.ts";

// Lo que /omi-setup resuelve, también lo postergado: el proyecto OMI y lo no disponible no son del setup.
const MISSING: readonly ConfigItem["status"][] = ["falta", "formato-anterior", "pendiente", "invalido", "postergado"];
const SETUP = "Lo configura la persona con /omi-setup (Foundations y lifecycle). Si pide algo que lo necesita, por ejemplo seguir con Review, Land o Ship después del PR draft, pasale ese comando tal cual. No lo configures vos: no edites la KB ni las perillas.";

/** Vacío sin diagnóstico o si el setup no tiene nada que correr. */
export function configGuide(diagnosis: ConfigDiagnosis | undefined): string {
	if (!diagnosis) return "";
	const parts = { foundations: diagnosis.foundations, lifecycle: diagnosis.lifecycle };
	const missing = diagnosis.items.filter((item) => item.area !== "omi-project" && parts[item.area].kind !== "none" && MISSING.includes(item.status));
	return missing.length ? `Falta configurar en este repo: ${missing.map((item) => item.message).join(" ")} ${SETUP}` : "";
}
