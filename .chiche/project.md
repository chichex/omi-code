# Contrato de autonomía — omi-code

## Stack

TypeScript ESM sobre Node 22.19 o superior, sin transpilar en desarrollo (type stripping nativo).
Tests con `node --test`; el probe de la plantilla Python usa `python3` (sólo verificación, no dependencia del binario). Embebe `@earendil-works/pi-coding-agent`; el binario sale de `bun build --compile`.
Dependencias runtime fijadas a versión exacta. Diseño UI: no aplica (CLI, TUI de Pi y MCP).

## Comandos

| Acción | Comando | cwd | Estado | Duración típica | Notas |
|---|---|---|---|---|---|
| deps | `npm ci` | . | verificado 2026-11-05 | ~5s | un worktree nuevo no trae `node_modules` |
| typecheck | `npm run typecheck` | . | verificado 2026-11-07 | ~2s | dos proyectos: raíz estricta y `extensions/` con su `tsconfig` |
| test | `npm test` | . | verificado 2026-11-07 | ~8s | mock de omi-api en `test/helpers/mock-omi.ts`; `smoke.test.ts` usa Pi y procesos reales; incluye `extensions/**/*.test.ts`; requiere `python3` para el handler; los 2 smoke de packaging se corren aparte |
| empaquetado | `npm run test:packaging` | . | verificado 2026-11-07 | ~12s | requiere bun; compila para el host, instala en un HOME temporal (también raíz personalizada), verifica versión/assets de Pi y entorno de procesos hijos |
| release local | `node scripts/build-release.ts --out <dir>` | . | verificado 2026-11-07 | ~25s | las cuatro plataformas; `--targets` acota |
| plan de release | `node scripts/next-release.ts` | . | verificado 2026-11-08 | <1s | imprime `version=X.Y.Z`, o `version=` si nada empaquetado cambió desde el último tag |
| dry-run de release | `gh workflow run release.yml --ref <rama> -f dry_run=true` | . | verificado 2026-11-08 | ~3min | corre el pipeline completo, también en macOS, sin publicar |
| censo de protocolo | `OMI_REPO=<checkout de chichex/omi> npm test` | . | verificado 2026-11-07 | ~6s | activa la comparación de `src/protocol/constants.ts` contra el código Go |
| correr | `npm run omi -- --help` | . | verificado 2026-11-05 | <1s | |

## Ambientes

- **Local:** todo corre contra el mock efímero. No hay credenciales reales en los tests.
- **Real:** `https://app.ohmyinfra.com`, con `chichex/omi#140` desplegado. Hasta entonces `omi login` falla con `session_token_unavailable`.
- **Git:** branch default `main`, remote `origin` en `github.com/chichex/omi-code`. `main` está protegida: exige PR y el check `cierre`, también para admins.
- **CI:** `ci.yml` corre typecheck, test y empaquetado en cada PR. El check se llama `cierre`.
- **Release:** cada merge a `main` que cambie lo empaquetado publica. `release.yml` calcula la versión desde el último tag, repite los gates, prueba macOS y crea el tag. El tag es la fuente de verdad: `package.json` se estampa sólo en CI y en `main` puede quedar atrás.
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
| max-lineas-archivo | 500 en `.ts` no-test; baseline nominal para los 13 archivos portados listados abajo | gate `max-lines`: excepción de adopción aprobada por el humano el 2026-11-08; techo por archivo sin crecimiento y ratchet al tamaño del base |
| coding-policies | `.sdd/coding-policies.md` de `chichex/omi`, secciones Clean Code y TypeScript | guia — sin gate: la juzga el reviewer |

La baseline siguiente acepta deuda del port inicial, no afirma que esos módulos cumplan SRP. Sólo cubre los 13 paths y techos explícitos del `case`: ningún directorio queda excluido. Para cada uno rige el menor techo entre la baseline y su tamaño en `$BASE`, con piso 500. Al bajar a 500 líneas o eliminar un archivo, retirar su entrada; no ampliar la lista ni los techos sin otra decisión humana. Conservar `wc -l`, la convención ya adoptada; no cambiar el conteo para ocultar deuda.

```sh
# commits: sin salida = PASS
git log --no-merges --format=%s "$BASE"..HEAD \
  | grep -Ev '^(feat|fix|refactor|test|docs|style|chore|ci|build|perf|revert|sdd)(\([a-z0-9-]+\))?!?: .+'

# max-lines: BASE debe ser el commit/branch contra el que se revisa el cambio
# baseline nominal aprobada; todo otro path sigue con techo 500
fail=0
git cat-file -e "$BASE^{commit}" 2>/dev/null || { echo "BASE inválido: $BASE"; exit 1; }
for f in $(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD -- '*.ts' | grep -Ev '\.test\.ts$'); do
  limit=500
  case "$f" in
    extensions/artifacts/index.ts) limit=1015 ;;
    extensions/artifacts/spec-publication.ts) limit=652 ;;
    extensions/ask-user-question/index.ts) limit=900 ;;
    extensions/github-issue-selector.ts) limit=560 ;;
    extensions/github-issues.ts) limit=505 ;;
    extensions/github-prs/index.ts) limit=560 ;;
    extensions/grill-tools/index.ts) limit=1860 ;;
    extensions/grill-tools/inventory.ts) limit=623 ;;
    extensions/subagent/jobs.ts) limit=632 ;;
    extensions/workflow-orchestrator/controller.ts) limit=637 ;;
    extensions/workflow-orchestrator/direct-launch.ts) limit=511 ;;
    extensions/workflow-orchestrator/lifecycle.ts) limit=824 ;;
    extensions/workflow-resolution/index.ts) limit=1247 ;;
  esac
  if [ "$limit" -gt 500 ] && git cat-file -e "$BASE:$f" 2>/dev/null; then
    previous=$(git show "$BASE:$f" | wc -l)
    [ "$previous" -ge 500 ] || previous=500
    [ "$previous" -ge "$limit" ] || limit=$previous
  fi
  actual=$(wc -l < "$f")
  [ "$actual" -le "$limit" ] || { echo "FALLA $f ($actual > $limit)"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "MAX_LINES=PASS"
```

## Decisiones

- `skipLibCheck: true`: `@google/genai`, transitiva de Pi, declara tipos contra un peer opcional de MCP y contra globals del DOM. Sin esto `tsc` falla en `node_modules`. Lo documenta `tsconfig.json`.
- `moduleResolution: Bundler`: bun empaqueta el binario, y los `.d.ts` de Pi importan JSON sin atributo.
- `OMI_POLL_INTERVAL_MS`, `OMI_RELEASES_URL`, `OMI_INSTALL_BASE` y `OMI_PACKAGING_SMOKE`: overrides de harness para los tests.
- `#extensions/*`, `extensions/embedded.d.ts` y `resolvePackageJsonImports: false`: cortan el typecheck estricto en el código portado. No usar `paths`: bun los respeta, empaqueta la declaración y las factories quedan `undefined`.
- En macOS un binario de bun muere con exit 137 hasta refirmarlo ad hoc: lo hacen `install.sh` y `omi upgrade`, y decide el probe de arranque.
- Los skills y extensiones vienen de `chichex/skills` en `553cf06`. El marcador `Chiche-Tracking` no se renombró: es formato de archivos existentes.
- 2026-11-07, feedback: `OMI_HOME` es una raíz absoluta; un binario instalado infiere la raíz por su ubicación. `PI_PACKAGE_DIR` y `OMI_RUNTIME_DIR` pertenecen sólo al host y se quitan de bash, Runner y subagentes.
- 2026-11-07, feedback: el bump de Pi verifica packaging en su propio workflow y deja el merge al humano; no depende de eventos de PR creados con `GITHUB_TOKEN`.
- 2026-11-07, feedback: instalación privada con `gh` autenticado; upgrade con `GH_TOKEN`/`GITHUB_TOKEN` enviado sólo a la API de releases de este repo, nunca persistido.
- 2026-11-08, preparación del land: el humano autorizó explícitamente la baseline nominal de 13 archivos sin crecimiento y resolver los dos hilos de seguridad como riesgos aceptados/diferidos a #5/#6, no como bugs corregidos. Autoriza sacar la capa 3 de Draft; el merge requiere la confirmación final del plan.
- 2026-11-08, feedback: despliegue continuo. El humano reemplazó «publicar es decisión humana» por «la decisión humana es el merge». Sólo publica lo que cambia el binario (`isPackaged` en `scripts/next-release.ts`): primero se miran las rutas y después el tipo de commit. Antes de 1.0 lo incompatible sube el minor. Volver atrás es mergear un `revert:`: `omi upgrade` sólo sube de versión.
- 2026-11-08, `cierre` obligatorio: `GITHUB_TOKEN` no dispara `pull_request`, y un `cierre` de `workflow_dispatch` no cuenta para la protección aunque esté en el commit (probado en un PR descartable). `bump-pi.yml` publica el check por la API, sobre un commit distinto al de su corrida, después de correr los mismos gates sobre ese árbol. Probado el check; falta verlo en un bump real.

## Gaps

- Depende de `chichex/omi#140` para funcionar contra producción.
- Sin cobertura automática contra una `omi-api` real: los tests usan un doble que copia el contrato.
- Los guardrails locales no aíslan a un agente con bash y acceso al Bearer. Riesgos aceptados para este land y diferidos por decisión humana: aislamiento CLI en #5 y confianza de aprobación MCP en #6. Sus issues siguen abiertos; resolver los hilos originales no constituye una corrección de seguridad.
- `/skill:init --update` migra `.sdd/` a `.omi/`, pero no `.chiche/` a `.omi/`. Este repo sigue con `.chiche/project.md`, que se lee por compatibilidad.
- El contrato de `/version` se verifica estático al publicar (`git grep`): OMI no lo valida.
- `release.yml` arranca los binarios de Linux x64 y macOS arm64. Los de Linux arm64 y macOS x64 se compilan y publican sin arrancarse.
