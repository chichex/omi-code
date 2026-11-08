# Grill — Harness agéntico de codificación e infraestructura para OMI (omi-code) sobre Pi
<!-- Estado: finalized. Proyecto: /Users/ayrtonmarini/workspace/platform. Fuente: pedido en chat 2026-11-05. -->
<!-- Chiche-Tracking: version=2; type=grill; state=finalized; issue=none; grill=harness-agentico-de-codificacion-e-infraestructu-20261105-6d466312; project=%2FUsers%2Fayrtonmarini%2Fworkspace%2Fplatform -->

## Hechos comprobados

- `platform` (`github.com/chichex/omi`, Go 1.26 + Next.js 16) implementa Platform API (`cmd/api`), el daemon de host (`cmd/agent`), el ejecutor de jobs (`cmd/disparador` con el paquete público `trigger/`) y el panel web (`web/`).
- El nombre `agent` pertenece al daemon instalado en cada host Linux bajo systemd (`installer/install.sh`).
- En `internal/api/http.go`, `POST /api/v1/sessions` valida email y contraseña y emite un token de sesión (7 días) en cookie, y `principalFromRequest` hoy lee únicamente esa cookie.
- La superficie de proyecto ya implementada en `platform-api` cubre:
  - Proyectos (`internal/api/projects.go`): creación y listado por organización (exige registry configurado).
  - Services y ambientes (`internal/api/services.go`, `internal/api/kit.go`): alta con ambiente inicial (`stage`/`prod`), segundo ambiente, kit de publicación (Dockerfile, contrato `/health` + `/version` + labels OCI, workflow GHA y script `regctl` en chunks de 50 MB).
  - Variables y secretos (`internal/api/variables.go`): reemplazo atómico por ambiente, secretos write-only (con `value: nil` preservando el secreto existente) y validación de colisiones con variables reservadas y de recursos (`POSTGRES_URL_<SLUG>`).
  - Recursos y disparadores: Postgres externo y local, `jobs` cron con `Lease` y firma HMAC-SHA256.
  - Deploys y logs (`internal/api/deployments.go`): deploy rolling por versión/digest, pasos por instancia en vivo, promoción `stage` → `prod`, logs en vivo (SSE) y crash logs (1.000 líneas por 7 días).
- `skills` (`/Users/ayrtonmarini/workspace/skills`, licencia MIT) contiene los skills SDD actuales y las extensiones de Pi en `pi-extensions/`.
- El rebranding de `platform` (`prama` → `omi` / `PRAMA_*` → `OMI_*`) se está ejecutando en paralelo en otra sesión.
- Diseño UI: `no aplica` (el harness es CLI/TUI + servidor MCP stdio y no modifica pantallas de `web/`).

## Decisiones resueltas

1. **Producto, repo y distribución — Nombre del binario/producto y repositorio (`D1-nombre-y-repo`)**: el código vive en un repositorio open source independiente `chichex/omi-code` y el comando CLI/TUI que ejecuta el desarrollador se llama `omi` (`omi`, `omi login`, `omi status`, `omi publish`, `omi deploy`, `omi logs`, `omi mcp`, `omi upgrade`).
2. **Producto, repo y distribución — Empaquetado y distribución del binario (`D2-distribucion-binario`)**: se distribuye como binario standalone compilado con `bun build --compile` por plataforma (`darwin/linux` `arm64/x64`) en GitHub Releases e instalado mediante `install.sh` en `~/.omi` (con fallback a bundle autocontenido en `~/.omi/runtime` si algún asset dinámico de Pi requiere archivos en disco, sin exigir Node ni Bun instalados al usuario).
3. **Producto, repo y distribución — Convención de naming de protocolo `OMI_*` en `platform-api` (`D3-naming-protocolo`)**: el rebranding de `platform` (`PRAMA_*` → `OMI_*`) se está ejecutando en paralelo en otra sesión; `omi-code` nace usando directamente la nomenclatura `OMI` (centralizada en un único módulo de constantes de protocolo para sincronizar cualquier detalle final con `platform`).
4. **Autenticación y contrato con Platform API — Autenticación del harness contra Platform API (`D4-auth-api`)**: en el Corte 1 `omi login` pide email y contraseña en terminal contra `POST /api/v1/sessions`, persiste el token en `~/.omi/credentials.json` (`0600`) y en `platform-api` se habilita que `principalFromRequest` acepte tanto la cookie de sesión como `Authorization: Bearer <token>`.
5. **Autenticación y contrato con Platform API — Vínculo repo local ↔ proyecto OMI (`D5-vinculo-repo`)**: el vínculo se guarda en `.omi/project.json` versionado en git con `organizationSlug`, `projectSlug` y un arreglo `services` (`{ name, path, port, dockerfile }`), soportando tanto repositorios de un único service como monorepos con múltiples services del mismo proyecto OMI.
6. **Flujo agéntico SDD+OMI y guardrails — Etapas del workflow SDD + OMI (`D6-etapas-flujo`)**: mantiene las etapas `init` → `grill` → `spec` → `run` → `land` enriquecidas con OMI (`init` vincula `.omi/project.json` y el kit de publicación; `spec` declara impacto en variables, recursos y disparadores; `run` implementa y verifica el contrato `/health` + `/version`; `land` mergea los PRs) y agrega la etapa `ship` (encadenable tras `land` o invocable sola) para publicar versión, desplegar en `stage`, observar el rolling y los logs en vivo/crash logs, y promover a `prod`.
7. **Flujo agéntico SDD+OMI y guardrails — Mecanismo de publicación de versiones desde el agente (`D7-publicacion-versiones`)**: híbrido; por defecto publica creando y pusheando el tag de git (`<service>/vX.Y.Z` en monorepo o `vX.Y.Z` en single-service) para que el workflow de CI del kit publique la imagen y espera el version scan de OMI; además soporta `omi publish` directo (ejecutando `docker build` con labels OCI + `regctl` en chunks de 50 MB del kit) cuando se quiera publicar sin pasar por CI.
8. **Flujo agéntico SDD+OMI y guardrails — Guardrails de autonomía y confirmaciones humanas (`D8-guardrails-confirmacion`)**: lecturas y diagnóstico son libres; en `stage` el agente tiene autonomía para declarar variables no secretas, crear/actualizar jobs y desplegar versiones dentro de un `ship` autorizado; exigen confirmación humana explícita toda operación en `prod`, escribir o rotar secretos, crear/modificar/borrar recursos con disco (bases, colas, storage) y cualquier baja (ambiente, service o proyecto).

## Ramas pendientes

Ninguna dentro del alcance del Corte 1. Fuera de alcance para cortes posteriores: gestión de hosts/infraestructura y Personal Access Tokens (PATs) de larga vida.

## Handoff

### Tema y alcance

Diseño del **Corte 1** de **`omi-code`** (comando **`omi`**), el harness agéntico open source construido sobre el SDK de Pi (`@earendil-works/pi-coding-agent`) que absorbe y evoluciona el flujo SDD (`chiche`) integrando de forma nativa el ciclo completo de un proyecto en **OMI (`ohmyinfra.com` / `platform`)**: autenticación, vínculo repo ↔ proyecto/services, kit de publicación, variables y secretos, recursos, disparadores (`jobs`), publicación de versiones, deploys (`stage` y `prod`) y observabilidad (progreso de rolling, logs en vivo y crash logs).

### Decisiones

Las ocho de «Decisiones resueltas», tal cual.

### Restricciones y no-objetivos

- **Fuera del Corte 1**: gestión de infraestructura/hosts (crear tokens de registro de host, aprobar/rechazar hosts, reintentar provisión de k3s o dar de baja hosts) y configuración inicial del registry de la organización sobre un host.
- **Sin sistema de PATs ni cambios en `web/` en el Corte 1**: la autenticación usa las sesiones existentes de `platform-api` habilitando `Authorization: Bearer <token>`.
- **Sin acoplamiento a `chichex/skills` en runtime**: `omi-code` empaqueta sus propios skills, extensiones y tools embebidos.

### Dependencias y consecuencias importantes

- **Cambio mínimo en `platform` (`cmd/api` / `internal/api/http.go`)**: aceptar `Authorization: Bearer <token>` en `principalFromRequest(r)` y exponer el token de sesión en `POST /api/v1/sessions` para clientes CLI/Bearer.
- **Coordinación con el rebranding de `platform`**: el módulo de constantes de protocolo de `omi-code` debe empatar con los nombres finales `OMI_*` que deje la sesión de rebranding de `platform`.
- **Dos repositorios involucrados**: un ajuste acotado en `chichex/omi` (`platform-api` Bearer auth) y la creación/bootstrap del nuevo repositorio `chichex/omi-code`.

### Supuestos explícitos (`[ASSUMED]`)

1. **`[ASSUMED]` Sucesor único de `chiche`**: `omi-code` absorbe y evoluciona el flujo SDD (`init`, `grill`, `spec`, `run`, `land`, `ship`, `code-review`, `coding-policies`, `tdd`, `subagent`), pasando a ser el único harness mantenido a futuro. Evidencia: confirmado por el usuario en conversación previa. Impacto si fuera incorrecto: extraer paquete compartido entre `skills` y `omi-code`.
2. **`[ASSUMED]` Licencia Open Source MIT**: `chichex/omi-code` se publica bajo MIT, con la URL de la API (`https://api.ohmyinfra.com` por defecto) configurable vía `OMI_API_URL` / `--api`. Evidencia: acordado en conversación previa; compatible con `@earendil-works/pi-coding-agent` y `chichex/skills` (ambos MIT). Impacto si fuera incorrecto: cambiar `LICENSE` antes de publicar.
3. **`[ASSUMED]` Alcance del Corte 1 limitado al ciclo de proyecto (sin hosts/infra)**: alta/aprobación/baja de hosts queda para otro corte; el Corte 1 asume que la organización ya tiene al menos un host con control plane y registry activo. Evidencia: pedido explícito del usuario. Impacto si fuera incorrecto: sumar endpoints de hosts al cliente y catálogo de tools.
4. **`[ASSUMED]` Tres caras en el mismo ejecutable (`omi`)**: (a) TUI agéntica interactiva sin argumentos, (b) CLI determinístico por subcomandos (`omi login`, `omi init`, `omi status`, `omi env`, `omi resources`, `omi publish`, `omi deploy`, `omi logs`, `omi upgrade`) y (c) servidor MCP stdio (`omi mcp`) compartiendo el mismo cliente y catálogo de tools. Evidencia: acordado en conversación previa. Impacto si fuera incorrecto: bajo; son tres adaptadores delgados sobre el mismo core.
5. **`[ASSUMED]` Directorio global `~/.omi` con migración asistida desde `~/.pi/agent`**: en el primer arranque, si existe `~/.pi/agent`, ofrece importar `auth.json`, `models.json` y preferencias. Evidencia: acordado en conversación previa. Impacto si fuera incorrecto: bajo; paso opcional de onboarding local.
6. **`[ASSUMED]` Actualización automática de Pi en CI + `omi upgrade`**: workflow programado en GitHub Actions que actualiza `@earendil-works/pi-coding-agent` si pasan los tests y publica el release en GitHub Releases para `omi upgrade`. Evidencia: acordado en conversación previa. Impacto si fuera incorrecto: bajo; afecta solo la automatización de mantenimiento en CI.

### Riesgos y diferidos

- **Empaquetado de assets dinámicos de Pi con `bun build --compile`**: si el ejecutable single-file tiene fricción con carga dinámica de themes/skills, `install.sh` desempaqueta el bundle autocontenido en `~/.omi/runtime/` y expone `~/.omi/bin/omi` manteniendo la misma experiencia para el usuario.
- **Expiración de sesiones de 7 días**: al reutilizar `POST /api/v1/sessions` en el Corte 1, la credencial en `~/.omi/credentials.json` vence a los 7 días y pide `omi login` nuevamente; los PATs quedan diferidos.
- **Corte 2 (Infra / Hosts)**: generación de token de registro de host, listado de hechos/capacidad/latencia, aprobación de hosts y provisión del registry desde `omi`.

### Contexto recomendado para la spec

- En `platform` (`/Users/ayrtonmarini/workspace/platform`): `internal/api/http.go`, `internal/api/api.go`, `internal/api/projects.go`, `internal/api/services.go`, `internal/api/kit.go`, `internal/api/variables.go`, `internal/api/deployments.go`, `trigger/trigger.go` y `docs/norte/index.html`.
- En `skills` (`/Users/ayrtonmarini/workspace/skills`): `pi/` y `pi-extensions/` como base del flujo SDD y de las extensiones a integrar en `chichex/omi-code`.
- Documentación del SDK de Pi: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`.
