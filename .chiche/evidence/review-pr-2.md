# Resolución de feedback — PR #2

Verificación local sobre `2c08d65`, 2026-11-07. Cambios de la capa 1 propagados mediante merge normal, sin reescribir historia.

| Comentario | Disposición | Evidencia |
|---|---|---|
| 4503345375 | corregido: el diff de secretos y conexiones muestra el nombre de la variable de origen, nunca el valor | `test/tools-env.test.ts`, `test/tools-resources.test.ts` |
| 4503345471 | corregido: mover un job evalúa prod tanto en origen como en destino | `test/tools-jobs.test.ts`: no hay PUT sin humano |
| 4503345550 | corregido: build directo fija linux/amd64 | `test/tools-publish.test.ts`: args del runner Docker |
| 4503345621 | corregido: relectura después de aprobar/ingresar secretos; conserva cambios disjuntos y rechaza targets cuyo diff cambió | `test/tools-env.test.ts`: alta concurrente y cambio a secreto |
| 4503345797 | corregido: MCP propaga --api; un destino incompatible con la sesión falla antes de HTTP | `test/mcp-transport.test.ts`: proceso real, ambos servidores sin requests |
| 4503345848 | corregido: las tres plantillas exigen frescura de 300 segundos además de HMAC | `test/tools-jobs.test.ts`: vectores Go y replay TS; `test/handler-python.test.ts`: Python real; chequeo estático de las tres plantillas |
| 4503345961 | corregido: semver coincide con la regex de omi-api y rechaza prereleases numéricos con cero inicial | `test/tools-publish.test.ts` |
| 4503346045 | corregido: reconciliando no bloquea 15 minutos esperando entrada humana; devuelve diagnóstico de recuperación | `test/tools-resources.test.ts` |
| 4503346139 | corregido: el modo directo rechaza versiones ya detectadas por OMI antes de construir/importar | `test/tools-publish.test.ts`: version_exists, cero docker/regctl |
| 4503346218 | corregido: --wait-only retoma el polling sin tocar tags/build; registry_not_ready es transitorio | `test/tools-publish.test.ts`: timeout seguido de reintento y 409 seguido de detección |
| 4503346304 | corregido: init pasa por enforce/cliGuard; el rechazo agéntico no sugiere repetir --create | `test/init-safety.test.ts`: con/sin TTY, cero POST/prompts |
| 4503346382 | corregido: progreso limitado a las últimas 50 entradas | `test/tui-launch.test.ts`: 500 eventos, cola acotada |
| 4503346744 | corregido: elicitación expira con rechazo y se cancela al desconectar | `test/mcp.test.ts`, `test/mcp-transport.test.ts`: timeout, close y proceso real |

## Diferidos por decisión humana, NO resueltos como seguridad

- `4503345192`: aislamiento de la CLI y credenciales, https://github.com/chichex/omi-code/issues/5.
- `4503345284`: confianza en la aprobación del cliente MCP, https://github.com/chichex/omi-code/issues/6.

El humano pidió abrir issues para retomarlos después. Los hilos permanecen abiertos con esos enlaces. Se mitigó el pseudo-TTY con marca agéntica y MCP anidado con marca agéntica; quitar la marca o usar directamente el Bearer sigue fuera de la garantía local. README lo dice explícitamente.

## Comandos ejecutados

- `npm run typecheck`: PASS.
- `OMI_REPO=/Users/ayrtonmarini/workspace/omi npm test`: PASS, 288/288, sin skips; incluye censo contra Go.
- `git diff --check`: PASS.
- Gates contractuales `commits` y `max-lines` contra la capa 1: PASS.
- Los bugs corregidos tienen regresiones observadas en rojo antes del cambio. No se quitaron pruebas ni se debilitó la política.

## Límites de la evidencia

Sin producción, Docker/registry real ni proveedor LLM pago. El build directo se prueba en la frontera Runner. El cliente rebasea variables después de la confirmación, pero la API no ofrece CAS/ETag para cerrar la carrera posterior a esa última lectura. El rechazo de versiones directas usa el catálogo detectado por OMI, no promete inmutabilidad impuesta por el registry. Go: firma comprobada mediante vectores del trigger real y frescura por chequeo estático; no se ejecutó el handler Go.
