# Contrato de autonomía — omi-code

## Stack

TypeScript ESM sobre Node 22.19 o superior, sin transpilar en desarrollo (type stripping nativo).
Tests con `node --test`. Embebe `@earendil-works/pi-coding-agent`; el binario sale de `bun build --compile`.
Dependencias runtime fijadas a versión exacta. Diseño UI: no aplica (CLI, TUI de Pi y MCP).

## Comandos

| Acción | Comando | cwd | Estado | Duración típica | Notas |
|---|---|---|---|---|---|
| deps | `npm ci` | . | verificado 2026-11-05 | ~5s | un worktree nuevo no trae `node_modules` |
| typecheck | `npm run typecheck` | . | verificado 2026-11-05 | ~2s | dos proyectos: raíz estricta y `extensions/` con su `tsconfig` |
| test | `npm test` | . | verificado 2026-11-05 | ~8s | mock de omi-api en `test/helpers/mock-omi.ts`; `smoke.test.ts` usa Pi y procesos reales; incluye `extensions/**/*.test.ts` |
| empaquetado | `npm run test:packaging` | . | verificado 2026-11-05 | ~12s | requiere bun; compila para el host, instala en un HOME temporal y arranca el binario |
| release local | `node scripts/build-release.ts --out <dir>` | . | verificado 2026-11-05 | ~25s | las cuatro plataformas; `--targets` acota |
| censo de protocolo | `OMI_REPO=<checkout de chichex/omi> npm test` | . | verificado 2026-11-05 | ~6s | activa la comparación de `src/protocol/constants.ts` contra el código Go |
| correr | `npm run omi -- --help` | . | verificado 2026-11-05 | <1s | |

## Ambientes

- **Local:** todo corre contra el mock efímero. No hay credenciales reales en los tests.
- **Real:** `https://app.ohmyinfra.com`, con `chichex/omi#140` desplegado. Hasta entonces `omi login` falla con `session_token_unavailable`.
- **Git:** branch default `main`, remote `origin` en `github.com/chichex/omi-code`.
- **CI:** `ci.yml` corre typecheck, test y empaquetado en cada PR. El check se llama `cierre`.
- **Release:** un humano empuja el tag `vX.Y.Z`, igual a la versión de `package.json`. `release.yml` publica.
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
- Publicar una release es decisión humana.

## Políticas de generación

| Política | Valor | Gate |
|---|---|---|
| commits-convencionales | `tipo(scope)?: resumen`; tipos `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`, `ci`, `build`, `perf`, `revert` y `sdd` | gate `commits` |
| typecheck | TypeScript sin errores | `npm run typecheck` sale con 0 |
| max-lineas-archivo | ratchet 500 en `.ts` no-test | gate `max-lines`. Hoy en FALLA por `extensions/`, portado de `chichex/skills`: decisión humana pendiente en el PR de la capa 3 |
| coding-policies | `.sdd/coding-policies.md` de `chichex/omi`, secciones Clean Code y TypeScript | guia — sin gate: la juzga el reviewer |

```sh
# commits: sin salida = PASS
git log --no-merges --format=%s "$BASE"..HEAD \
  | grep -Ev '^(feat|fix|refactor|test|docs|style|chore|ci|build|perf|revert|sdd)(\([a-z0-9-]+\))?!?: .+'

# max-lines: imprime MAX_LINES=PASS o una línea FALLA por archivo
limit=500; fail=0
for f in $(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD -- '*.ts' | grep -Ev '\.test\.ts$'); do
  [ "$(wc -l < "$f")" -le "$limit" ] || { echo "FALLA $f"; fail=1; }
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

## Gaps

- Depende de `chichex/omi#140` para funcionar contra producción.
- Sin cobertura automática contra una `omi-api` real: los tests usan un doble que copia el contrato.
- `/skill:init --update` migra `.sdd/` a `.omi/`, pero no `.chiche/` a `.omi/`. Este repo sigue con `.chiche/project.md`, que se lee por compatibilidad.
- El contrato de `/version` se verifica estático al publicar (`git grep`): OMI no lo valida.
