# Contrato de autonomía — omi-code

## Stack

TypeScript ESM sobre Node 22.19 o superior, sin transpilar en desarrollo (type stripping nativo).
Tests con `node --test`; el probe de la plantilla Python usa `python3` (sólo verificación, no dependencia del binario). Embebe `@earendil-works/pi-coding-agent`; el binario sale de `bun build --compile`.
Dependencias runtime fijadas a versión exacta. Diseño UI: no aplica (CLI, TUI de Pi y MCP).

## Comandos

| Acción | Comando | cwd | Estado | Duración típica | Notas |
|---|---|---|---|---|---|
| deps | `npm ci` | . | verificado 2026-11-05 | ~5s | un worktree nuevo no trae `node_modules` |
| typecheck | `npm run typecheck` | . | verificado 2026-11-07 | ~2s | |
| test | `npm test` | . | verificado 2026-11-07 | ~8s | mock de omi-api en `test/helpers/mock-omi.ts`; `smoke.test.ts` usa Pi y procesos reales; requiere `python3` para el handler; los 3 smoke de packaging se corren aparte |
| empaquetado | `npm run test:packaging` | . | verificado 2026-11-07 | ~12s | requiere bun y `python3`; compila para el host, instala en un HOME temporal (también raíz personalizada), verifica versión/assets de Pi, entorno de procesos hijos y cancelar el prompt en un pty |
| release local | `node scripts/build-release.ts --out <dir>` | . | verificado 2026-11-07 | ~25s | las cuatro plataformas; `--targets` acota |
| plan de release | `node scripts/next-release.ts` | . | verificado 2026-11-08 | <1s | imprime `version=X.Y.Z`, o `version=` si nada empaquetado cambió desde el último tag |
| dry-run de release | `gh workflow run release.yml --ref <rama> -f dry_run=true` | . | verificado 2026-11-08 | ~5min | corre el pipeline completo, con el arranque en las cuatro plataformas, sin publicar |
| censo de protocolo | `OMI_REPO=<checkout de chichex/omi> npm test` | . | verificado 2026-11-07 | ~6s | activa la comparación de `src/protocol/constants.ts` contra el código Go |
| correr | `npm run omi -- --help` | . | verificado 2026-11-05 | <1s | |

## Ambientes

- **Local:** todo corre contra el mock efímero. No hay credenciales reales en los tests.
- **Real:** `https://app.ohmyinfra.com`, con `chichex/omi#140` desplegado. Hasta entonces `omi login` falla con `session_token_unavailable`.
- **Git:** branch default `main`, remote `origin` en `github.com/chichex/omi-code`. `main` está protegida: exige PR y el check `cierre`, también para admins.
- **CI:** `ci.yml` corre typecheck, test y empaquetado en cada PR. El check se llama `cierre`.
- **Release:** cada merge a `main` que cambie lo empaquetado publica. `release.yml` calcula la versión desde el último tag, repite los gates, prueba macOS, arranca en las cuatro plataformas los mismos archivos que publica y crea el tag. El tag es la fuente de verdad: `package.json` se estampa sólo en CI y en `main` puede quedar atrás.
- **Linux real:** `chichex-linux` sirve para probar el binario `linux-x64` en un HOME temporal.
- **Review a pedido:** `gh workflow run claude-review.yml --repo chichex/omi-code -f pr=<N>`; requiere el secret `CLAUDE_CODE_OAUTH_TOKEN`.

## Verificación autónoma

1. `npm run typecheck`.
2. `npm test`.
3. `OMI_REPO=<checkout> npm test`, si cambió `src/protocol/` o el contrato con omi-api.
4. Gates de `## Políticas de generación`.

## Límites

- No push directo a `main` ni force-push. Trabajar por PR.
- No commitear credenciales, tokens ni valores de secretos.
- El valor de un secreto no pasa por el contexto del LLM ni por la salida.
- La decisión humana de publicar es el merge a `main`. No empujar tags `vX.Y.Z` ni correr `gh release create` a mano: el pipeline es el único camino.

## Políticas de generación

| Política | Valor | Gate |
|---|---|---|
| commits-convencionales | `tipo(scope)?: resumen`; tipos `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`, `ci`, `build`, `perf`, `revert` y `sdd` | gate `commits` |
| typecheck | TypeScript sin errores | `npm run typecheck` sale con 0 |
| max-lineas-archivo | 500 en `.ts` no-test | gate `max-lines` |
| coding-policies | `.sdd/coding-policies.md` de `chichex/omi`, secciones Clean Code y TypeScript | guia — sin gate: la juzga el reviewer |

```sh
# commits: sin salida = PASS
git log --no-merges --format=%s "$BASE"..HEAD \
  | grep -Ev '^(feat|fix|refactor|test|docs|style|chore|ci|build|perf|revert|sdd)(\([a-z0-9-]+\))?!?: .+'

# max-lines: BASE debe ser el commit/branch contra el que se revisa el cambio
fail=0
git cat-file -e "$BASE^{commit}" 2>/dev/null || { echo "BASE inválido: $BASE"; exit 1; }
for f in $(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD -- '*.ts' | grep -Ev '\.test\.ts$'); do
  actual=$(wc -l < "$f")
  [ "$actual" -le 500 ] || { echo "FALLA $f ($actual > 500)"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "MAX_LINES=PASS"
```

## Decisiones

- `skipLibCheck: true`: `@google/genai`, transitiva de Pi, declara tipos contra un peer opcional de MCP y contra globals del DOM. Sin esto `tsc` falla en `node_modules`. Lo documenta `tsconfig.json`.
- `moduleResolution: Bundler`: bun empaqueta el binario, y los `.d.ts` de Pi importan JSON sin atributo.
- `OMI_POLL_INTERVAL_MS`, `OMI_RELEASES_URL`, `OMI_INSTALL_BASE` y `OMI_PACKAGING_SMOKE`: overrides de harness para los tests.
- En macOS un binario de bun muere con exit 137 hasta refirmarlo ad hoc: lo hacen `install.sh` y `omi upgrade`, y decide el probe de arranque.
- 2026-11-07, feedback: `OMI_HOME` es una raíz absoluta; un binario instalado infiere la raíz por su ubicación. `PI_PACKAGE_DIR` pertenece sólo al host y se quita de bash y Runner.
- 2026-11-07, feedback: el bump de Pi verifica packaging en su propio workflow y deja el merge al humano; no depende de eventos de PR creados con `GITHUB_TOKEN`.
- 2026-11-07, feedback: instalación privada con `gh` autenticado; upgrade con `GH_TOKEN`/`GITHUB_TOKEN` enviado sólo a la API de releases de este repo, nunca persistido.
- 2026-11-08, preparación del land: el humano autorizó explícitamente la baseline nominal de 13 archivos sin crecimiento y resolver los dos hilos de seguridad como riesgos aceptados/diferidos a #5/#6, no como bugs corregidos. Autoriza sacar la capa 3 de Draft; el merge requiere la confirmación final del plan.
- 2026-11-08, feedback: despliegue continuo. El humano reemplazó «publicar es decisión humana» por «la decisión humana es el merge». Sólo publica lo que cambia el binario (`isPackaged` en `scripts/next-release.ts`): primero se miran las rutas y después el tipo de commit. Antes de 1.0 lo incompatible sube el minor. Volver atrás es mergear un `revert:`: `omi upgrade` sólo sube de versión.
- 2026-11-08, `cierre` obligatorio: la CI de un PR abierto con `GITHUB_TOKEN` queda en `action_required` sin correr, y un `cierre` de `workflow_dispatch` no cuenta para la protección aunque esté en el commit (probado en un PR descartable). `bump-pi.yml` publica el check por la API, sobre un commit distinto al de su corrida, después de correr los mismos gates sobre ese árbol. Probado con un bump real sobre un Pi viejo (#12). El PR queda `UNSTABLE` por esa corrida, sin bloquear el merge: `cierre` es el único check requerido. Aprobarla es opcional: corre la CI real y lo deja `CLEAN`.
- 2026-11-08, permiso de Actions: el humano autorizó `can_approve_pull_request_reviews: true` para que el bump abra su PR. El mismo permiso deja aprobar PRs: revisarlo si `main` empieza a exigir aprobaciones.
- 2026-11-09, feedback: la oferta de importar Pi pregunta por grupo y Enter sólo copia lo inofensivo. Las credenciales, los ajustes con código externo y los que reemplazan a los de omi piden un sí explícito, porque Pi instala y carga `packages` al arrancar. `onboarding.json` guarda una decisión por grupo y `piImport` se sigue leyendo. `omi import pi` vuelve a preguntar.
- 2026-11-09, feedback: instalación aislada. omi sólo lee configuración de `~/.omi/agent` y del proyecto (del cwd a la raíz del repo; sin repo, el cwd). Pi no expone flags para eso, así que `src/tui/isolation.ts` agrega `!~/.agents/skills/**` a los ajustes en cada arranque y corre con `--no-context-files` más una extensión que inyecta sólo el contexto permitido en `before_agent_start`. Falla cerrado: sin la extensión no hay contexto, y con ajustes ilegibles se arranca con `--no-skills`. El costo es que la sección Context de la TUI queda vacía: lo cubre un aviso al iniciar la sesión. La caja negra de `test/helpers/foreign-config.ts` mira el request real al proveedor, también con el binario compilado, y cubre los bumps de Pi.
- 2026-11-09, feedback: instalación limpia. Una instalación nueva no trae skills ni extensiones ajenas: se borraron los 11 skills y las 11 extensiones portadas de `chichex/skills`, con el tema `claude-code` y sus docs. omi no depende de ningún paquete ni trae reemplazo. Sólo quedan `omi-tools`, `omi-runtime-shell` y `omi-isolated-context`. `/skill:ship` ya no autoriza stage: el guard de la TUI pregunta y recuerda el sí. Las credenciales del shell se sacan del host con `hideFromHost` y vuelven en `childEnvironment`, porque son del usuario y no de omi; `PROVIDER_CREDENTIALS` lo vigila un test que sondea a cada proveedor de Pi, así que un bump que sume una variable falla ahí. Rompe `GEMINI_API_KEY=… omi -p` a propósito.
- 2026-11-09, feedback: importar duplica. El criterio es importar, borrar `~/.pi` y que omi siga igual. El grupo Recursos copia todo lo de `~/.pi/agent` salvo lista negra, porque los paquetes guardan configuración propia (`claude-bridge.json`). Las rutas hacia `~/.pi` de los ajustes quedan relativas a `~/.omi/agent`, y las de afuera no se tocan. Quien ya pasó por el onboarding no recibe la pregunta nueva al actualizar: la tiene en `omi import pi`.
- 2026-11-09, Bun: `rl.question` queda pendiente al cerrar el readline. Sin `askOrCancel`, Ctrl+D colgaba el binario y Ctrl+C pedía dos pulsaciones. Con Node no se reproduce: lo cubre el smoke de empaquetado con un pty real.

## Gaps

- Depende de `chichex/omi#140` para funcionar contra producción.
- Sin cobertura automática contra una `omi-api` real: los tests usan un doble que copia el contrato.
- Los guardrails locales no aíslan a un agente con bash y acceso al Bearer. Riesgos aceptados para este land y diferidos por decisión humana: aislamiento CLI en #5 y confianza de aprobación MCP en #6. Sus issues siguen abiertos; resolver los hilos originales no constituye una corrección de seguridad.
- El contrato de `/version` se verifica estático al publicar (`git grep`): OMI no lo valida.
- Sin confirmar si el proveedor invalida el refresh token viejo al copiar `auth.json` con OAuth: el código de Pi guarda el nuevo sólo en su archivo, y probarlo exige renovar un token real. Por eso el aviso dice «puede».
- El aislamiento cubre la configuración de agentes, no todo el home. Fuera de alcance: `~/.cache/huggingface/token`, que la extensión `llama` de Pi lee al usar Hugging Face. Sin repo git, Pi sube hasta `/` buscando `.agents/skills`; esas carpetas piden confianza y los ajustes globales no las excluyen.
- `models.json` o `auth.json` con una referencia a una variable oculta, como `$GEMINI_API_KEY`, no la resuelven: el valor tiene que estar en el archivo o venir de un comando.
- Importar no cubre symlinks absolutos hacia `~/.pi`, que siguen apuntando ahí, ni rutas de los ajustes fuera de `~/.pi/agent`, como `../otro`, que no se copian. Tampoco cubre paquetes de terceros con `~/.pi` escrito en su código, como `pi-antigravity-bridge`: siguen leyendo y escribiendo ahí.
- `release.yml` pasa los binarios entre jobs como un artifact de 283 MB, que expira en un día. Sin confirmar el límite de almacenamiento de Actions de la cuenta: si se llena, falla el build y no se publica nada.