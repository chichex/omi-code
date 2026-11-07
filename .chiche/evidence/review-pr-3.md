# Resolución de feedback — PR #3

Verificación funcional final sobre `a5cbcc40323907a5afb5bd9fe83c477b3055d6cf`, 2026-11-07. Las capas inferiores se incorporaron mediante merges normales; no hubo force-push.

| Comentario | Disposición | Evidencia |
|---|---|---|
| 4503347904 | corregido: bootstrap de rutas ANTES de runtime-setup/config de Pi | `test/packaging-smoke.test.ts`: binario instalado reporta Pi 1.5.0, antes reportaba 0.0.0 |
| 4503347993 | corregido: OMI_HOME unifica configuración, credenciales, runtime y upgrade; binario infiere su raíz sin necesitar conservar el env del instalador | `test/runtime-home.test.ts`, smoke real instalado en raíz personalizada |
| 4503348095 | corregido: ship no se promueve desde menciones/negaciones; el guardrail observa input antes de transforms | `extensions/inline-skill-autocomplete/logic.test.ts`, `test/tui-launch.test.ts` |
| 4503348204 | corregido: ambos swaps están protegidos por rollback con undo de pasos completados; si restaurar falla se conservan backups y se informa su ruta | `test/upgrade.test.ts`: segundo swap fallido y rollback fallido mediante permisos reales |
| 4503348375 | corregido: bump verifica packaging en el mismo workflow, no intenta auto-merge deshabilitado y no pisa ramas ya existentes | gate focalizado de `test/packaging.test.ts`; no se ejecutó el workflow remoto |
| 4503348468 | corregido: entorno hijo sin PI_PACKAGE_DIR/OMI_RUNTIME_DIR en bash, user_bash, Runner y subagentes; conserva marca agéntica/configuración | `test/process-environment.test.ts`, `extensions/subagent/index.test.ts`, bash RPC del binario real |
| 4503348591 | corregido: importación opt-in de snapshots/handoffs de grills, también para quien ya importó proveedores; no pisa sesiones/config existentes ni modifica Pi | `test/pi-import.test.ts`: copias, colisiones, marker inválido y segunda corrida |
| 4503348732 | corregido: examples se incluye junto a los assets de Pi | probe del binario real verifica getExamplesPath existente |
| 4503348850 | corregido: shims de instalador y upgrade citan rutas como datos | `test/packaging.test.ts`, `test/upgrade.test.ts`: HOME con $, comillas, backslash y backticks |
| 4503348941 | corregido: --check no evalúa la plataforma del instalador | `test/upgrade.test.ts`: consulta desde win32 simulado sin descargar assets |
| 4503349034 | corregido: build no borra out; usa temporal propio y rechaza home, checkouts y ancestros del repo | `test/packaging.test.ts`: preserva archivo del usuario y rechaza checkout temporal |
| 4503349139 | corregido: README explica instalación privada con gh y requisito de release publicada; upgrade autentica assets de la API con GH_TOKEN/GITHUB_TOKEN sin persistirlo | `test/packaging.test.ts`: gh simulado, curl bloqueado; `test/upgrade.test.ts`: API privada y ausencia de token en endpoint alternativo |
| 4503349230 | corregido: extensions.ts se importa dinámicamente después de configurar el entorno; entry compilado tiene bootstrap previo a Pi | source revisado, typecheck y smoke real de metadata/rutas |
| 4503349343 | corregido: la ruta de origen se llama sourcePiAgentDir; la activa de las extensiones conserva su significado | typecheck completo, tests de onboarding y rutas |
| 4503349463 | corregido: exists/isDirectory centralizados en src/core/files.ts y reutilizados en runtime, launch, build, upgrade y onboarding | typecheck, regresión y packaging real |

## Comandos ejecutados

- `npm run typecheck`: PASS, raíz y extensiones.
- `OMI_REPO=/Users/ayrtonmarini/workspace/omi npm test`: PASS, 780 pasan / 782 total; los 2 restantes son los smoke de packaging, intencionalmente separados.
- `npm run test:packaging`: PASS, 2/2. Total de pruebas distintas verificadas entre ambos comandos: 782.
- `node scripts/build-release.ts --out <temporal>`: PASS, cuatro plataformas (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`), binario + runtime por plataforma, instalador y checksums; 10 artifacts. Temporales eliminados.
- `sh -n install.sh`, `shellcheck install.sh`, `git diff --check`: PASS.
- Gate contractual `commits`: PASS.
- Diff de tests contra el head original: sin nuevos skip/only/todo ni supresiones. Los cambios de fixtures/códigos de salida corresponden a los bugs corregidos, no a debilitar asserts.

## Política de tamaño — sigue en FALLA, PR continúa Draft

No se cambió ni excluyó ningún archivo del gate. Los 13 archivos portados que ya excedían 500 líneas siguen excediéndolas:

`artifacts/index.ts` 1015; `artifacts/spec-publication.ts` 652; `ask-user-question/index.ts` 900; `github-issue-selector.ts` 560; `github-issues.ts` 505; `github-prs/index.ts` 560; `grill-tools/index.ts` 1860; `grill-tools/inventory.ts` 623; `subagent/jobs.ts` 632; `workflow-orchestrator/controller.ts` 637; `workflow-orchestrator/direct-launch.ts` 511; `workflow-orchestrator/lifecycle.ts` 824; `workflow-resolution/index.ts` 1247. Todos bajo `extensions/`. El import del entorno hijo agrega una línea a jobs.ts respecto de la baseline de 631; no se maquilla esa medición.

## Límites y decisiones

- Sólo se ejecutó el binario real en el host macOS arm64. Las otras tres plataformas compilan, pero no se ejecutaron en sus hosts.
- No se usaron credenciales reales, Docker/registry de producción ni modelos pagos para probar la app. Instalación/upgrade privados se prueban en fronteras simuladas.
- No se publicó release, cambió visibilidad/protección ni mergeó ningún PR. El bump propone un PR verificado; su merge queda humano, conforme al contrato.
- Persisten deliberadamente los dos problemas estructurales de seguridad del PR #2: issues #5/#6, diferidos por el humano; no se cierran sus hilos como corregidos.
