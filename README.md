# omi-code

Harness agéntico de codificación e infraestructura para [OMI](https://ohmyinfra.com), sobre [Pi](https://github.com/earendil-works/pi).

Un solo comando, `omi`, con tres caras sobre el mismo core:

| Cara | Comando | Para qué |
|---|---|---|
| TUI | `omi` | sesión agéntica con las tools de OMI |
| CLI | `omi <subcomando>` | operaciones determinísticas, con `--json` |
| MCP | `omi mcp` | el mismo catálogo por stdio para otros agentes |

Códigos de salida: `0` ok, `1` error de ejecución o API, `2` error de uso o guardrail bloqueado.

## Instalación

No hace falta Node ni Bun. Tiene que existir una release publicada.
**Mientras el repo sea privado**, usá `gh` previamente autenticado y con acceso:

```sh
tmp="$(mktemp -d)"
gh release download --repo chichex/omi-code --pattern install.sh --dir "$tmp"
sh "$tmp/install.sh"
rm -rf "$tmp"
```

El instalador descarga los assets con `gh` autenticado. Cuando el repo sea público también se podrá usar:

```sh
curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | sh
```

Se instala en `~/.omi`; `OMI_HOME=/ruta/absoluta` permite otra raíz. El binario instalado la infiere de su ubicación.

### PATH

Si `~/.omi/bin` (o `$OMI_HOME/bin`) no está en el `PATH`, el instalador lo agrega al archivo que lee una terminal nueva del shell de `$SHELL`:

| Shell | Archivo |
|---|---|
| zsh | `${ZDOTDIR:-$HOME}/.zshrc` |
| bash en macOS | `~/.bash_profile`, salvo que bash ya use `~/.bash_login` o `~/.profile` |
| bash en Linux | `~/.bashrc` |
| fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/omi.fish` |

Escribe un bloque entre `# >>> omi >>>` y `# <<< omi <<<`. Reinstalar lo reemplaza entero y deja igual el resto del archivo. La salida dice qué archivo tocó.
La terminal desde la que instalaste no cambia: abrí una nueva o corré la línea que muestra el instalador, por ejemplo `export PATH='/Users/ana/.omi/bin':"$PATH"`.
Con otro shell, o si el archivo no se puede escribir, no toca nada y muestra la línea para copiar. `omi upgrade` nunca toca estos archivos.

Para que no toque ningún archivo del shell, usá `OMI_NO_MODIFY_PATH=1`. Vacío, `0`, `false` o `no` (sin importar mayúsculas) sí lo configuran; cualquier otro valor, no. Va del lado de `sh`, no de `curl`:

```sh
OMI_NO_MODIFY_PATH=1 sh "$tmp/install.sh"
curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | OMI_NO_MODIFY_PATH=1 sh
```

### Integraciones por defecto

Una instalación nueva trae estas integraciones **en la distribución de OMI**, sin descargar paquetes ni requerir Pi, Node o npm aparte. También quedan disponibles al actualizar una instalación existente, sin reemplazar sus ajustes.

| Integración | Qué trae | Autenticación |
|---|---|---|
| Subagentes | Tool `subagent` con `scout`, `planner`, `reviewer` y `worker`; background, espera explícita y panel `SUBAGENTES` | El modelo y razonamiento elegidos en la sesión |
| Desarrollo | Harness que arranca ante un pedido de desarrollo, con un sí humano; Directa, Diagnóstico y Con spec, evidencia y progreso hasta PR draft | Modelo de la sesión y `gh` autenticado |
| Preguntas | Tool `omi_ask`: el agente pregunta en tandas de 1 a 4, con una recomendada, alternativas y respuesta libre; también con el harness activo. Una respuesta no autoriza nada | No requiere |
| Codemode | Tool `codemode` de Pi activa junto a `read`, `bash`, `edit` y `write`; el harness de desarrollo y los subagentes la dejan afuera | No requiere |
| Claude Bridge | Catálogo `claude-bridge/...` con `pi-claude-bridge@0.13.0` incluido; requiere ejecutable externo | Claude Code con `claude auth login` o `CLAUDE_CODE_OAUTH_TOKEN` |
| KB de [Harness](https://github.com/chichex/harness/tree/main/kb) | MCP `harness-kb`, por Streamable HTTP en `https://kb-prod-chiche.ohmyinfra.com/mcp` | OAuth desde `/mcp login harness-kb` |
| OMI | El mismo catálogo de `omi mcp`, integrado **nativamente** en el agente, con confirmaciones en la UI | `omi login` |

OMI no levanta un segundo servidor MCP contra sí mismo: duplicaría las tools y perdería el canal de confirmación del padre. `omi mcp` sigue disponible por stdio para clientes externos.
La KB queda registrada, no autenticada: iniciá sesión desde `/mcp`, donde también podés revisar su estado y reconectarla. Sus tools se descubren con `tool_search` para no llenar el contexto al arrancar. El login de la KB es independiente de `omi login` y del proveedor del modelo.

Ejemplos para pedir en Chat:

```text
Usá scout para ubicar la autenticación y reviewer para revisar los guardrails, en paralelo.
Usá una cadena: scout reúne contexto, planner propone el plan con {previous} y worker lo implementa.
```

Cada subagente tiene contexto propio: recibe la tarea explícita y las instrucciones del proyecto, no la conversación del padre. Usa el SDK de Pi dentro de OMI, sin procesos ni instalaciones externas.
`scout`, `planner` y `reviewer` sólo tienen las tools disponibles de lectura (`read`, `grep`, `find`, `ls`); `worker` usa las tools invocables del padre, incluidas las de OMI y los MCP ya conectados, sin delegación recursiva ni orquestadores `codemode`/`tool_search`.
Las llamadas pasan por el pipeline del padre: conservan cwd, hooks, validaciones y confirmaciones. **No es un sandbox:** comparten filesystem, y no hay que asignar los mismos archivos a workers en paralelo.
**En TUI y RPC trabajan en segundo plano por defecto:** la llamada devuelve un ID y libera al principal para que puedas seguir conversando y haciendo otras tareas. Al terminar llega un aviso; el agente incorpora el resultado con `subagent` usando `action: "result"` e `id`. Leer un resultado todavía pendiente no espera, y consultar varias veces uno terminado no duplica su uso/costo. El uso se agrega a los totales de la sesión al recoger el resultado, no al lanzar el trabajo; además queda una entrada local de auditoría del uso al finalizar.

El lateral muestra **`SUBAGENTES`**, con roles, estado, tools, duración, tareas activas/en cola y un resumen si no entran todas. Un clic o `/omi-subagents` abre el detalle; `/omi-subagents cancel <ID de tarea o lote>` solicita cancelar ese lote, con confirmación. La tool también acepta `action: "status"` para consultar y `action: "cancel"` con un ID o `"all"` para cancelar. No hay polling automático continuo.

Si el principal necesita el resultado antes de seguir, puede delegar con **`background: false`**. Ése es el comportamiento por defecto en print/JSON, donde el proceso no queda abierto para alojar trabajos. Esc cancela una delegación que está esperando; no cancela los trabajos ya desacoplados. Salir, recargar, cambiar de sesión o navegar el árbol sí solicita cancelar los trabajos: **no son jobs persistentes ni sobreviven al proceso**.

Hay un máximo de 4 lotes de background, 8 tareas por lote y **4 tareas activas globales**, compartidas con foreground; 32 turnos por tarea, 256 llamadas delegadas por lote background y cancelación solicitada a los 10 minutos de cada tarea activa. Una cadena se corta ante el primer error. La cancelación es cooperativa: no revierte archivos ni operaciones ya enviadas. La salida se limita a 6 KB / 200 líneas por tarea, con un archivo temporal privado para el resultado completo si se trunca. Las llamadas en background adquieren un contexto de tool nuevo por ejecución, con IDs propios, en vez de retener el scope de la llamada original ya finalizada; siguen pasando por validación, hooks y confirmaciones del padre.

#### Claude por Claude Code

El builtin `omi-claude-bridge` distribuye `pi-claude-bridge@0.13.0` con OMI; requiere Pi 1.5.1, incluido en el binario. No descarga ni instala paquetes en el home al arrancar, no agrega paquetes a `settings.json` ni cambia tu modelo predeterminado.

La integración soportada requiere **Claude Code instalado aparte**, con `claude` en `PATH` o una ruta global configurada: OMI no lo instala. Autenticá desde una terminal, fuera de OMI:

```sh
claude auth login
```

También se admite `CLAUDE_CODE_OAUTH_TOKEN`, como variable de entorno propia de Claude Code, sin guardarla en los ajustes de OMI.

Después, en OMI, seleccioná un modelo **`claude-bridge/...` desde `/model`**. No uses `anthropic/...` ni `/login` de Pi para autenticar este bridge: son otro proveedor y otro flujo de autenticación. En la CLI, usá `--model claude-bridge/claude-opus-5-5`; si querés la API de Anthropic, usá `--model anthropic/claude-opus-5-5`. Un ID Claude sin proveedor puede ser ambiguo si ambos están disponibles. El builtin y su catálogo siguen incluidos con `--offline` o `--no-mcp`; eso no permite usar Claude sin conexión.

La configuración avanzada va en `<OMI_HOME>/agent/claude-bridge.json` (por defecto, `~/.omi/agent/claude-bridge.json`). Se respeta `provider.pathToClaudeCodeExecutable` si configuraste otra ruta al ejecutable. En una instalación limpia, sin un ejecutable disponible, OMI no anuncia el bridge como disponible/autenticado ni lo autoselecciona. La detección es **local, sólo del ejecutable**: no consulta la red, no valida el login ni garantiza acceso a un modelo. Sin CLI, el builtin registra un catálogo vacío, también frente a modelos declarados en `models.json`, para impedir que Pi los ofrezca durante un refresh. El bundle sigue distribuido; después de instalar Claude Code, reiniciá OMI o usá `/reload` para registrar sus modelos. No configures una `apiKey` para `claude-bridge` en `models.json` o `auth.json`: su autenticación es externa; declarar una clave en Pi no verifica el ejecutable ni el login.

La sesión y las credenciales de Claude Code viven en `~/.claude`, fuera de la configuración de OMI (o en `CLAUDE_CONFIG_DIR`, si lo configuraste). OMI fuerza `settingSources: []`: **intencionalmente no carga los ajustes ni hooks de usuario o proyecto de Claude Code**. No se soporta autenticación basada en `settings.json`, su sección `env` ni `apiKeyHelper`. El contexto y las herramientas siguen viniendo del agente OMI; usar Claude Code para autenticar no importa la configuración de otro harness.

Las credenciales del shell que el aislamiento oculta al host **no se reinyectan en el bridge**: por ejemplo, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` y `GOOGLE_APPLICATION_CREDENTIALS` (lista no exhaustiva). Esto no significa que todas las variables `AWS_*` estén ocultas. Selectores como `CLAUDE_CODE_USE_BEDROCK` pueden heredarse, pero **Bedrock y Vertex no son flujos soportados por este builtin**. Para el bridge, usá un entorno de suscripción de Claude Code; para autenticación por API o cloud, configurá explícitamente el proveedor nativo correspondiente de Pi. No habilites hooks ni reinyectes secretos para sortear este aislamiento.

#### Desactivar integraciones

Se pueden desactivar en `~/.omi/agent/settings.json` (o `<OMI_HOME>/agent/settings.json`):

```json
{
  "extensions": ["-builtin:omi-subagents", "-builtin:omi-kb", "-builtin:omi-claude-bridge"]
}
```

Codemode se apaga con `"defaultTools": ["-codemode"]` en esos ajustes o con `--tools -codemode` en una corrida. Una lista con nombres simples en `defaultTools` o `--tools` reemplaza la selección: sólo trae codemode si lo nombra.

Una extensión del usuario que ya registre `subagent` reemplaza la incluida, sin duplicar la tool. `--no-extensions` omite las extensiones por defecto en esa corrida; `--no-mcp` omite la KB, no Claude Bridge ni las tools nativas de OMI. Con `--offline` o `PI_OFFLINE=1` no se registra la KB remota por defecto. Un servidor `harness-kb` en `~/.omi/agent/mcp.json` o en `.pi/mcp.json` (proyecto de confianza) prevalece sobre el default, sin ser modificado. Los cambios de exposición/activación hechos desde `/mcp` sobre el registro por defecto duran esa sesión; para persistirlos, usá los ajustes anteriores o una entrada propia en `mcp.json`.

### Configuración y aislamiento

No trae skills ni reemplaza el modelo predeterminado del usuario. Para usar un proveedor nativo de Pi, entrá con `/login` o importá credenciales; para Claude Bridge, usá el flujo de Claude Code indicado arriba. Detectar su ejecutable no equivale a validar la autenticación.

Para los siguientes modelos del proveedor **OpenAI**, omi configura por defecto una ventana de
**1.050.000 tokens**, según el límite publicado en la ficha API de cada modelo:

| Familia | Modelos verificados (fuentes oficiales) |
|---|---|
| GPT-5.4 / 5.5 | [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4), [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) |
| GPT-5.6 | [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) |
| GPT-6 | [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) |
| GPT-6.1 | [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) |

Al arrancar agrega únicamente los `contextWindow` faltantes en `~/.omi/agent/models.json`;
respeta por modelo un límite explícito en `modelOverrides` o en una definición `models` del usuario.
También completa instalaciones que ya tenían el default de GPT-6.1 Sol. No modifica otros modelos,
proveedores ni el catálogo cacheado: los Claude y Gemini recientes ya declaran aproximadamente 1M en Pi.
El contexto largo puede aumentar el costo API; se mantienen las tarifas por tramos del catálogo.
Esto no verifica permisos ni disponibilidad en tu cuenta, ni aplica el límite API al proveedor Codex.

Para la configuración del agente, omi sólo lee `~/.omi/agent` y el proyecto, del directorio actual hasta la raíz del repo.
Por ejemplo, no carga `~/.pi/agent`, `~/.agents/skills` ni `~/AGENTS.md`. Para instrucciones globales usá `~/.omi/agent/AGENTS.md`.
La configuración del repo (`.pi/`, `.agents/skills`) sigue valiendo, con la confirmación de confianza.

Las API keys del shell no le dan un modelo a omi. Por ejemplo, con `GEMINI_API_KEY` exportada, omi arranca igual sin modelo. Los comandos que corre el agente sí la ven, como cualquier comando de tu shell.

omi apaga la telemetría de Pi, aunque el shell diga `PI_TELEMETRY=1` o los ajustes `enableInstallTelemetry: true`. Por ejemplo, la primera sesión no avisa a pi.dev de la instalación. Los comandos que corre el agente ven tu `PI_TELEMETRY`.

omi trae `fd` y `rg` (ripgrep) en `~/.omi/runtime/bin`, con sus licencias en `~/.omi/runtime/licenses`: Pi ya no los descarga de GitHub al arrancar. Si tenés los tuyos en el `PATH`, se usan los tuyos. Por ejemplo, con `brew install ripgrep`, el agente usa ese `rg` y el `fd` de omi.

### Workspace de terminal

`omi` arranca con un layout fullscreen propio: cabecera con **1 Chat / 2 Issues / 3 PRs / 4 Cambios / 5 OMI**, conversación y editor,
lateral personalizable con bloques rectangulares sobre negro, toda la sesión agrupada y pie con actividad y una fila propia para el modelo. El fondo por defecto es negro; una selección de tema
explícita sigue controlando los colores del runtime. La conversación, las tools, sus confirmaciones, el streaming,
el historial y la edición siguen usando el renderer de Pi; no hay un segundo proceso de chat ni una UI web.

- **1 · Chat:** conversación y editor. Tus mensajes llevan un encabezado **▌ Vos** y, con la paleta por defecto, un fondo verde oscuro y texto claro.
  Las respuestas y herramientas conservan su presentación. La etiqueta es sólo visual: no modifica lo enviado al modelo ni lo guardado en el historial.
- **2 · Issues:** hasta 100 issues abiertos de todo el repo de GitHub, no sólo de la branch actual.
- **3 · PRs:** hasta 100 PRs abiertos de todo el repo, incluidos los borradores.
  Ambas listas requieren `gh` instalado y autenticado; flechas seleccionan, **Enter** carga la descripción del elemento elegido y **r** actualiza.
  Los errores se muestran por separado y conservan la última lista como desactualizada, no como una lista vacía exitosa.
  Las listas no crean issues ni cierran o fusionan PRs. El detalle de PR sigue siendo de sólo lectura.
  **Trabajar en un issue:** **Enter en la lista siempre abre el detalle**, también si el issue ya está preparado. **Esc** sólo lo cierra, sin cambiar de workspace.
  Sin preparación guardada, el detalle ofrece **Enter iniciar trabajo**: le pide al [harness de desarrollo](#harness-de-desarrollo-hasta-pr-draft) que empiece. Arranca sin preguntar; con `arranque: ask` en Foundations, antes pide tu confirmación. Al arrancar, usa el modelo seleccionado (sin tools) para clasificarlo como **Nuevo feature**, **Fix**, **Mejora** o **Chore**, con objetivo, alcance inicial, criterios de aceptación sugeridos y dudas.
  Crea una rama `feat/issue-N-título`, `fix/issue-N-título`, `improve/issue-N-título` o `chore/issue-N-título` desde el commit de **`main` local**, no desde HEAD ni `origin/main`.
  El worktree queda en `<repo-principal>-worktrees/issue-N`, fuera del checkout original. No hace fetch, pull, stash, commit ni push; tampoco mueve la rama, índice o cambios del origen.
  Abre una sesión nueva en ese directorio, con el issue y su triage en el contexto, y el harness sigue en **Explorar**. La lateral muestra **PROGRESO · #N** (o **ISSUE ACTIVO** si no hay un trabajo) debajo de **Recursos**; se restaura con `/reload` y `/resume`.
  No se escribe código hasta que apruebes la receta. La conversación anterior queda en su sesión.
  **Idempotente:** la lista muestra badges locales, por ejemplo `#42 [Fix] [issue-42]`, o `[Sin triage]`. No son etiquetas de GitHub ni generan llamadas al modelo al abrir la lista.
  El detalle de uno preparado muestra clasificación, rama y ruta, con **Enter retomar trabajo**: pide tu confirmación y vuelve a la misma sesión, conservando conversación y cambios, sin reclasificar ni crear otra rama, worktree o sesión; el trabajo sigue desde su etapa guardada, y si estaba pausado el sí lo reanuda. Si ya estás trabajando en ese issue, permanece ahí.
  El vínculo se guarda por issue en `<git-common-dir>/omi/issue-workspaces/N.json`, compartido por todos los worktrees del clon. `/resume` y `/fork` explícitos vinculan la sesión elegida si conserva el mismo triage y worktree.
  Las preparaciones anteriores se reconocen por su metadata de sesión y su identidad Git, no sólo por el nombre de la carpeta. Si coinciden varias sesiones antiguas, pide elegir con `/resume`.
  **Empezar o retomar** requiere `gh`, conexión, proyecto de confianza, modelo autenticado y sesión persistente (sin `--offline`, `PI_OFFLINE` ni `--no-session`), con el agente en reposo; sin GitHub el detalle no ofrece Enter. Retomar no reclasifica. Para abrir offline la sesión de un issue preparado, usá `/resume`.
  Se puede cancelar con **Esc** mientras clasifica. Si falta `main`, el modelo falla o una ruta/rama ajena ya existe, no usa otra base ni sobrescribe nada.
  Guarda el progreso de preparación para continuar un intento interrumpido sin repetir el triage. Si falta un worktree o una conversación que ya estaban listos, o no coincide su identidad, indica recuperación pendiente en lugar de reemplazarlos.
  Un lock por issue impide preparaciones simultáneas desde dos ventanas. Tras un cierre abrupto, un lock abandonado no se roba por antigüedad: hay que verificar el PID/host indicado en `N.lock` antes de quitarlo.
  Si se cancela el cambio de sesión, conserva la preparación y volver a pedir el issue permite retomarla. Un worktree no es un sandbox.
- **4 · Cambios:** lista de hasta 100 archivos y diffs de working tree / stage, sin drivers de diff ni textconv externos.
  Cada archivo con seguimiento muestra `+líneas` en verde y `−líneas` en rojo, alineadas a la derecha incluso al acortar una ruta larga.
  Es el cambio neto respecto de HEAD (stage + working tree, sin contar dos veces la misma edición); sin commits se compara con el árbol vacío.
  Los binarios se marcan `binario` y un conteo no disponible como `—`, no cero. Los archivos sin seguimiento muestran `nuevo`: no se lee su contenido durante el refresco para contarlos.
  Los archivos nuevos se enumeran individualmente y **Enter** abre una previsualización local de sólo lectura (hasta 256 KiB o 2000 líneas).
  No se leen durante el refresco ni se envían al modelo. Las rutas que parecen sensibles (`.env`, claves, credenciales) piden confirmación adicional;
  esa detección es orientativa, no una garantía de detectar todos los secretos. No se abren binarios, enlaces simbólicos ni archivos fuera del checkout.
  Esta vista no edita, agrega al stage, comitea ni cambia de branch.
- **5 · OMI:** proyecto vinculado, servicios y ambientes con versión y estado informados por OMI.
  Usa el vínculo local y la sesión de `omi login`; **r** actualiza. Sin vínculo se indica `omi init`, sin inventar servicios.
  Es el punto de consulta de infraestructura, separado de GitHub. Las operaciones de variables, recursos, registry, visibilidad, jobs, versiones, logs y deploys
  siguen disponibles mediante las herramientas en Chat, con sus confirmaciones habituales; el panel no las ejecuta automáticamente.
- **Ubicación del repo:** la lateral y `/omi-workspace` muestran branch, cambios locales, divergencia cuando existe upstream, tipo de checkout y ruta activa.
  Distingue `Repo principal`, `Worktree · nombre`, HEAD separado y carpetas sin Git. Un worktree no es un sandbox.
  **Volver al repo principal:** si estás en un worktree, aparece esa opción en la paleta **Ctrl K** y **Enter volver al repo** en `/omi-workspace` (también al hacer clic en Proyecto). **Esc** cierra sin cambiar de sesión. `/omi-main` ejecuta el regreso directamente.
  Retoma primero la conversación de origen si pertenece al principal; si no está disponible, busca la más reciente de ese checkout. Si no hay ninguna, crea una sesión vacía allí, sin copiar el contexto del issue ni llamar al modelo. Los reintentos reutilizan esa sesión, incluso si se canceló el cambio anterior.
  Vuelve al **directorio del checkout principal**, no fuerza la branch `main`: conserva la rama o HEAD separado, índice y cambios que ya tenía. No hace checkout, reset, stash, fetch ni borra el worktree del issue; podés retomarlo después desde Issues. Si ya estás en el principal, `/omi-main` no cambia nada.
  Funciona sin conexión ni auth del modelo, con proyecto de confianza, sesión persistente y agente en reposo. Verifica la identidad Git del destino y no pisa sesiones inválidas. Un lock compartido (`<git-common-dir>/omi/main-session.lock`) evita crear dos sesiones nuevas en simultáneo; tras un cierre abrupto hay que revisar el PID/host antes de quitar un lock abandonado.
  `↑N ↓N` son **commits** por subir/traer, no archivos ni líneas sin commit. Se comparan con la referencia local del último fetch;
  la lateral muestra `Al día (local)` si ambos son cero, `sin upstream` si no está configurado y `↑— ↓—` si el conteo no está disponible.
  No hace fetch automático ni convierte errores en ceros. `/omi-workspace` muestra el upstream y explica cómo actualizarlo con `git fetch`.
  Proyecto, Sesión, GitHub Actions, OMI, Subagentes y Recursos usan marcos de caracteres con título, sin franjas de fondo coloreado.
  La lateral tiene fondo negro uniforme en oscuro y blanco en claro. Los bloques se compactan cuando falta alto; el espacio libre queda al final.
- **GitHub Actions en la lateral:** agrupa **Claude reviews** (`claude-review.yml`) y **Releases** (`release.yml`) dentro de su propio rectángulo, igual que las demás secciones. Muestra hasta tres ejecuciones recientes por workflow de todo el repo, con estado, nombre y antigüedad alineada a la derecha y separada por al menos dos espacios. Se adapta al espacio disponible; en terminales bajas muestra un resumen por workflow sin ocultar OMI. Los nombres corresponden a las ejecuciones reales, no a tags inferidos. Un check indica ejecución exitosa, no aprobación del PR. Clic en la sección o `/omi-actions` abre el detalle con las URLs. Sólo consulta: no dispara reviews ni releases.
- **Sesión:** reúne el modelo y proveedor, esfuerzo de razonamiento con círculos `●○`, contexto estimado / límite real y porcentaje en un mismo rectángulo.
  Incluye entrada/salida, caché y costo registrado de la rama de conversación activa cuando hay consumo informado; no es saldo ni cuota del proveedor.
  Los círculos representan ocupación o esfuerzo, no un puntaje inventado de calidad del modelo.
  Si el runtime no conoce el uso de contexto se muestra `—`, no cero. Con Sesión oculta o sin lateral, el contexto queda en el pie.
  Clic en el modelo abre el selector; en contexto abre `/omi-context`. `/compact` sigue siendo explícito.
- **Recursos:** CPU total, RAM disponible, volumen del proyecto y consumo separado del proceso OMI. Son del **host donde corre OMI**:
  conectado por SSH a Linux, no representan tu Mac. La RAM aproximada se marca `≈` y una métrica no soportada queda como no disponible.
- **Output compacto:** en el workspace fullscreen, las herramientas consecutivas del mismo tipo se agrupan en una línea gris:
  `Ran 3 shell commands`, `Read 5 files`, `Edited 2 files`, `Wrote 1 file` o `Ran 3 searches`.
  Los comandos cuentan invocaciones de shell, no intentan interpretar cuántas instrucciones hay dentro de un script;
  lectura/edición/escritura exitosas cuentan rutas distintas dentro del grupo. Otras herramientas muestran su nombre y cantidad de llamadas.
  Durante la ejecución indica `Preparing`, `Running`, `Reading`, etc., sin anunciar éxito antes de terminar.
  Los errores/abortos se colapsan en grupos separados de éxitos y ejecuciones activas, con el color de error del tema:
  `Failed 2 shell commands`, `Failed to read 2 files`, `Failed to edit 1 file`, `Failed to write 1 file`, `Failed 3 searches` o `Failed omi_project_status 2 times`.
  En estos grupos se cuentan intentos fallidos, incluso si repiten la misma ruta; no se distingue cancelación de error ni se anticipa el motivo.
  **Clic en el resumen** abre/cierra el grupo; **Ctrl+O** (o el atajo configurado), `/omi-output` y la paleta alternan el detalle global.
  Al expandir, el detalle usa los componentes originales de Pi, con argumentos, salida, diffs y errores/abortos intactos. Las imágenes mantienen su presentación nativa visible;
  los resultados truncados conservan una advertencia. Texto del usuario/asistente, diagnósticos y confirmaciones no se agrupan ni reordenan.
  Es sólo presentación: no reduce lo enviado al modelo ni altera herramientas, historial o datos. También agrupa sesiones restauradas.
  El modo classic/regular y el volcado de transcript al salir siguen usando la presentación nativa de Pi.
- **Modelo:** fila dedicada en el pie con nombre destacado, proveedor, razonamiento y atajo según el ancho disponible.
  `/model`, su atajo configurado (por defecto Ctrl L) o esa fila abren el selector propio de OMI.
  Abre en el proveedor actual; **Tab / Shift+Tab** recorren los proveedores configurados y la vista de todos.
  Por defecto reduce versiones repetidas por familia conocida (Claude, GPT, Gemini, Grok y Kimi), conservando el modelo actual, los favoritos y los modelos custom.
  En OpenAI prioriza una lista corta: la última versión disponible de **Sol, Terra, Luna y Astra**, cuando existen en el scope; si no, las ramas GPT estándar disponibles.
  Daybreak, aliases `latest` y ramas anteriores quedan en el catálogo completo o se recuperan buscando; también aparecen si son el modelo actual o un favorito.
  **Ctrl+A** alterna recomendados/catálogo completo; buscar también incluye versiones anteriores dentro del proveedor elegido.
  **Ctrl+F** filtra favoritos y **Ctrl+S** marca/desmarca. Respeta `--models` y permite revisar el razonamiento antes de aplicar.
  La lista muestra nombre, contexto y una etiqueta corta de capacidad: **Máxima**, **Muy alta**, **Alta** o **Especializado**.
  Son categorías orientativas basadas en fichas del fabricante, no un benchmark propio ni un puntaje deducido del precio o del contexto.
  Se asignan sólo a versiones verificadas; las demás muestran **Sin referencia**. La fuente y fecha de revisión quedan en **Enter**, sin consultas de red al abrir el selector.
  Debajo hay dos líneas del modelo seleccionado: una explicación corta y el precio API base de entrada/salida.
  **Enter** abre la configuración y la ficha técnica (entrada, salida máxima, caché y tarifas por tramos). El análisis se ajusta con izquierda/derecha y niveles en castellano; otro Enter aplica.
  Que un modelo no permita apagar el análisis significa que analiza antes de cada respuesta, no que trabaje en segundo plano.
  Los precios son referencias del catálogo en USD por millón de tokens, no saldo ni cuotas de una suscripción. Los ceros no se anuncian como gratuidad.
  Los límites y ajustes salen del runtime; las descripciones de uso verificadas tienen fuente oficial. Las pistas por nombre se indican como tales.
  Sin una descripción verificada (por ejemplo Cyber), se muestra **uso no documentado**. Daybreak Blue tiene una ficha oficial: es un alias de seguridad defensiva marcado como obsoleto.
  La selección parte del catálogo disponible del runtime: no prueba llamadas pagas ni garantiza permisos, saldo o disponibilidad de cada modelo en tu cuenta.
  Usa el catálogo, capacidades y autenticación reales. No cambia de modelo durante un turno ni si el contexto conocido supera su límite.
  Se aplica a la sesión, no a los defaults globales. Si otra extensión reemplaza el editor, `/omi-model` sigue disponible.

| Atajo / comando | Acción |
|---|---|
| Ctrl 1 o `/omi-chat` | Chat |
| Ctrl 2 o `/omi-issues` | Issues abiertos de GitHub |
| Ctrl 3 o `/omi-prs` | PRs abiertos de GitHub |
| Ctrl 4 o `/omi-changes` | Cambios locales |
| Ctrl 5 o `/omi-platform` | OMI: proyecto, servicios, ambientes y Foundations vigente con su origen |
| **f** en OMI o `/omi-foundations` | Editar Foundations en el panel vertical: patrones que requieren confirmación y políticas `ask`/`auto`; Guardar vale ya en la sesión ([detalle](docs/development-harness.md#foundations-comandos-y-permisos-por-repo)) |
| Ctrl 6 o `/omi-workflow` | Progreso: recorrido completo del harness y modo previsto/real por etapa |
| Ctrl K o `/omi` | Paleta de comandos (Ctrl K reemplaza borrar hasta fin de línea en el editor) |
| F4 o `/omi-sidebar` | Mostrar / ocultar lateral |
| `/omi-sidebar-settings` | Elegir qué bloques mostrar en la lateral |
| Ctrl O o `/omi-output` | Alternar detalle de herramientas; clic en un resumen abre sólo ese grupo |
| `/omi-actions` | Detalle de Claude reviews y releases de GitHub Actions |
| `/omi-pr` | URL, título y estado del PR de la rama actual |
| `/omi-model` | Selector propio, también si otra extensión personaliza el editor |
| `/omi-workspace` | Ubicación y, desde un worktree, opción para volver al repo principal |
| `/omi-main` | Retomar la sesión del repo principal sin cambiar ramas ni tocar el worktree |
| `/omi-resources` | CPU, RAM, disco y host |
| `/omi-context` | Detalle del contexto |

Los atajos son **Control** también en Mac, no Option ni Command. **Esc** vuelve a Chat desde las vistas de consulta.
Las pestañas también funcionan por clic; en panes angostos conservan los seis números y el nombre de la vista activa.

El pie muestra **`[ PR #123 ↗ ]`** como botón junto a la rama actual, incluso si debe recortar su nombre.
Se resuelve con `gh pr status`, incluyendo el remoto y los forks, sin inferirlo de la lista de PRs del repo.
En fullscreen, un clic normal en cualquier parte del botón (incluidos bordes y espacios internos) abre la URL mediante `gh pr view <URL> --web`; los espacios libres del pie no abren Ubicación.
También conserva el enlace OSC 8 para la interacción nativa del terminal. `/omi-pr` y la paleta permiten ver y copiar la URL por teclado; si falla el navegador, se muestra una advertencia con ese detalle.
Si falla una actualización, se conserva el enlace con `*` como dato desactualizado; al cambiar de rama se descarta el anterior.
Sin PR, con HEAD separado o sin datos no se inventa un enlace. Se respeta `--offline` y la confianza del proyecto.

La lateral ocupa 41 columnas y se oculta por debajo de 110 columnas o 26 filas;
los comandos y el pie siguen disponibles. Contexto, CPU, RAM y disco usan círculos llenos/vacíos `●○` junto al valor numérico.
**Personalizar lateral**, al final del panel, en la paleta o con `/omi-sidebar-settings`, permite ocultar cada bloque:
**↑↓** elige, **Espacio / Enter** alterna, **Ctrl+S** guarda, **Esc** cancela y **r** restablece todos visibles.
Ocultar un bloque no desactiva sus comandos ni las verificaciones de seguridad.
El inicio vacío muestra una bienvenida breve, sin inventar una conversación. Los componentes internos de OMI
no aparecen en la lista de extensiones ni se ofrece actualizar Pi por separado. Las extensiones del usuario,
sus diagnósticos y sus avisos de actualización se conservan; no se modifica `quietStartup` en los ajustes.
Los datos locales se refrescan aproximadamente cada 3 segundos y los remotos cada 30, sin bloquear el streaming.
Errores de GitHub u OMI se muestran como no disponibles / desactualizados, nunca como checks exitosos ni ambientes saludables inventados.
`--offline` y los proyectos sin confianza no disparan estas consultas remotas. Favoritos, visibilidad de la lateral y bloques ocultos se guardan
sólo en `~/.omi/agent/workspace-ui.json` (o la raíz elegida con `OMI_HOME`).

Para volver a la presentación anterior:

```sh
OMI_TUI=classic omi
# Desde el repo:
OMI_TUI=classic npm run omi
```

`--tui-mode regular` conserva el modo de scrollback del terminal, sin las vistas fullscreen ni la lateral.
RPC, JSON, print y MCP no abren recursos de la UI. El adaptador del layout está verificado con Pi 1.5.1;
si cambia su contrato, conserva la vista base y avisa. No parchea archivos de `node_modules`.

### Harness de desarrollo hasta PR draft

**Clasifica antes de crear.** Ante un pedido de código que vale la pena seguir, el agente llama a `omi_work_begin` con el pedido completo. Sin issue, OMI clasifica **antes de crear issue, rama, worktree o sesión**. Si es un cambio simple, continúa en el chat original sin activar harness; si falta información, vuelve con preguntas para aclararla antes de seguir. Siguen vigentes las reglas y permisos del proyecto: clasificar no autoriza comandos ni cambios sensibles. Error, resultado inválido o cancelación no crean recursos ni se interpretan como simpleza. Si amerita harness, crea el issue sin preguntar (avisa qué creó) y reutiliza el triage para preparar worktree desde `main` local, cambiar a su sesión y seguir en **Explorar**. Con `arranque: ask` en Foundations, antes muestra qué va a crear y pide **un solo sí**; rechazar no crea nada. Con un issue existente (`#N`), siempre usa harness y ese mismo número; retoma sin reclasificar ni duplicar recursos. **Enter iniciar trabajo** en Issues conserva ese camino. Preguntas, explicaciones y operaciones de OMI siguen en el chat normal.

Los criterios son configurables por repo en un bloque **`omi-development-triage` de las perillas del producto en la KB**: salida chat habilitada, alcance máximo e impactos permitidos. La evaluación estima alcance, impacto, reversibilidad, verificación y riesgo desde el pedido; no mide líneas del diff ni inspecciona código. El default exige un cambio localizado, reversible, verificable y sin riesgo sensible. La ruta **Directa** sigue siendo trabajo dentro del harness, no sinónimo de simpleza. [Formato, fallback y límites](docs/development-harness.md#criterios-de-clasificación-previa).

Explora código, resuelve inferencias y deja una receta persistente. Tiene tres rutas: **Directa**, **Diagnóstico** para bugs sin causa confirmada y **Con spec** para trabajo grande. Antes de escribir aprueba la receta completa: sola por defecto, o con tu revisión si Foundations dice `receta: ask`. Registra rojo/verde reales, commits por paso, verificación por caso y lentes; sólo entonces sube la rama y abre un **PR draft** (con `push_pr: ask`, antes pide permiso). No mergea, dispara workflows ni despliega.

Después del PR draft, `/omi-work adopt | review | fix | land | ship` sigue el mismo trabajo por Review, correcciones, Land y Ship, cada efecto con su permiso (`ask` por defecto); se configura con `omi init --development` ([detalle](docs/development-harness.md#review-land-y-ship)).

La lateral muestra **PROGRESO · #N** con ruta, etapa, actividad, pasos, checks y bloqueos, y el recorrido completo cuando hay altura. En compacto conserva los demás bloques y anuncia **Ctrl 6**: **6 · Progreso** (`/omi-workflow`) muestra todas las etapas, también pendientes, con estado textual y ejecución prevista separada de la real. Se desplaza con flechas, PgUp/PgDn o rueda; Esc vuelve a Chat. `?`/«sin observar» no atribuye una delegación: la receta sólo informa lo previsto; los lentes se identifican como llamadas aisladas, y los trabajos antiguos conservan modo desconocido. Clic o **`/omi-progress`** abre el detalle, también con la lateral oculta. El avance sale del estado y de resultados observados, no de frases del modelo. `/omi-work status`, `pause`, `resume`, `refresh`, `approve`, `pr` y `stop` permiten controlarlo; no hay un comando para empezar. Cargar una sesión no reejecuta efectos automáticamente.

**Foundations v2** configura por repo, en las perillas del producto en la KB de Harness, **patrones glob que requieren confirmación**, no una allowlist, y si el arranque, la receta y el push + PR draft piden un sí (`ask`) o no (`auto`). **Sin Foundations v2 aceptada, nada pregunta:** los tres puntos van en `auto` y los comandos corren sin preguntar; un bloque v1 o inválido cuenta como ausente. Con v2, sólo los comandos simples que no coinciden con un patrón corren sin preguntar; la sintaxis compuesta o no soportada pide sí, y la receta aprobada no dispensa esa confirmación. Ejemplo: con `git push *`, `npm test` corre solo y `git push origin main` o `npm test && npm run build` piden sí. Cada revisión nueva de la KB se aplica sola, con un aviso de qué cambió, y queda fija en la sesión; sin KB vale la última aceptada o, si no hay, el default. El [panel vertical dedicado](docs/development-harness.md#foundations-comandos-y-permisos-por-repo) se abre con **f** en la vista OMI (`/omi-foundations`), `/omi-work foundations` o **Editar reglas**: precarga lo vigente, conserva borradores y sólo persiste/acepta con Guardar explícito. Abrir, cancelar o guardar no ejecuta un comando pendiente ni concede grants: se debe reintentar. El sí humano recuerda únicamente el comando exacto para ese trabajo/pedido, también al retomar; cambiar pedido/refresh lo invalida. Es sólo del harness, no del shell general, y no es un sandbox.

La descripción humana del issue se conserva: receta, evidencia y acuerdos van en una **sección administrada al final del cuerpo**, entre `<!-- omi:harness:start -->` y `<!-- omi:harness:end -->`, que el harness reescribe sin tocar el pedido. No crea comentarios. Lo que la persona dice en el chat vale como autorización de alcance: el agente lo registra con su cita textual, sin editar el issue. El estado local vive bajo el Git common-dir, independiente del vínculo de infraestructura OMI. Este corte es para repos existentes; quedan afuera la etapa Fundación, prototipos y perfiles avanzados de modelos.

[Contrato, permisos, recuperación y límites del harness](docs/development-harness.md).

### Herdr

Dentro de un pane de [Herdr](https://herdr.dev), omi se registra automáticamente como **`omi`**.
No hace falta instalar la integración de Pi ni copiar extensiones. Reporta `working` mientras trabaja,
`blocked` cuando una UI de extensión espera una decisión e `idle` cuando termina, incluso si se interrumpe el turno.
Los reintentos y las continuaciones no se anuncian como trabajo terminado.

Con **Herdr 0.9.2 o posterior**, también registra `omi --session …` para restaurar la conversación después de reiniciar
el servidor de Herdr. Actualiza esa referencia al cambiar de sesión, modelo o nivel de razonamiento.
Conserva las opciones conocidas de tools y recursos del arranque, pero no reenvía el prompt inicial, adjuntos ni API keys.
Los flags particulares de extensiones no se restauran: usá configuración persistente si la sesión depende de ellos.
La restauración requiere `omi` en el `PATH` y una sesión persistente; `--no-session` sólo reporta estados.
Si el comando supera los límites de Herdr (64 argumentos, 8 KiB, sin apóstrofes ni caracteres de control),
se omite la restauración, no los estados. Herdr también permite desactivarla con `[session] resume_agents_on_restore = false`.

La integración sólo se activa en modo interactivo (`tui`) con `HERDR_ENV=1`, `HERDR_PANE_ID` y `HERDR_SOCKET_PATH`.
Fuera de Herdr, en CLI/MCP o en modos RPC/JSON/print, no reporta nada ni reclama el pane del proceso padre.
La comunicación usa el socket local, en background y con timeout corto; un error de Herdr no interrumpe omi.
Al salir libera el pane; `/reload`, `/new`, `/resume` y `/fork` mantienen la integración sin liberar la autoridad.

### Importar de Pi

Importar es la única forma de traer recursos de otra instalación de Pi, y siempre duplica: después podés borrar `~/.pi` y omi sigue igual. La excepción es un paquete con `~/.pi` escrito en su código: sigue usando esa ruta.

Si ya usabas Pi, el primer arranque ofrece copiar a `~/.omi/agent` con una pregunta por grupo. Pi no se modifica.

| Grupo | Qué copia | Enter |
|---|---|---|
| Credenciales | `auth.json`, `models.json`, `mcp-auth.json` | no copia |
| Ajustes | `settings.json`, con las rutas relativas a omi | copia sólo si no instala paquetes ni reemplaza los de omi |
| Recursos | el resto: skills, extensiones, paquetes instalados (`git/`, `npm/`), `AGENTS.md`, `mcp.json` | no copia |
| Grills | sesiones que omi no tiene | copia |

No se copian las sesiones, los backups, `trust.json` ni las cachés. Los recursos nunca pisan lo que omi ya tiene.

`omi import pi` vuelve a preguntar. Copiar credenciales OAuth hace que Pi y omi compartan la sesión: si uno renueva el token, el otro puede pedir login.

Para sumar un skill de `~/.agents/skills`, agregá `+~/.agents/skills/foo/SKILL.md` a `skills` en `~/.omi/agent/settings.json`. omi mantiene ahí `!~/.agents/skills/**`.

`omi upgrade` actualiza a la última release y `omi upgrade --check` sólo informa.
Para releases privadas necesita `GH_TOKEN` o `GITHUB_TOKEN` con acceso. Por ejemplo, desde una terminal del humano:

```sh
GH_TOKEN="$(gh auth token)" omi upgrade --check
```

El token sólo se envía a la API de releases de este repo; no se imprime ni se guarda.
`omi login` inicia la sesión de OMI, que es distinta de la autenticación de GitHub. Pide el token de la sesión con el header `X-Omi-Session-Token: body`. Si la API abre la sesión pero no entrega el token, `omi login` falla con `session_token_unavailable` e intenta cerrar esa sesión. Con este `omi` las causas son dos: una `omi-api` anterior a `chichex/omi#140`, que no conoce el header, o un intermediario que lo quita en el camino; se revisa la URL con `--api` u `OMI_API_URL`. Un `omi` anterior, que no manda el header, falla con el mismo código contra una `omi-api` que lo exige, y eso se arregla con `omi upgrade`. Tras varios intentos fallidos la API responde `429` y `omi login` muestra cuánto esperar.

## Guardrails

Son controles locales para las superficies soportadas, no aislamiento de un proceso hostil (ver «Alcance de los guardrails»).

| Operación | Quién decide |
|---|---|
| Lecturas, incluida una consulta SQL de sólo lectura en stage o prod | libre |
| Variables no secretas, jobs y deploy en stage, publicar | autónomo en una sesión autorizada |
| Cualquier cosa en prod, secretos, Postgres (gestionarlo o ejecutar SQL que escribe), registry, visibilidad, bajas, crear un proyecto o un service | humano, siempre, con una confirmación interactiva |

«Humano, siempre» sólo se aprueba respondiendo una pregunta en el momento: en una terminal (la CLI), en el diálogo de la TUI o por elicitación del cliente MCP.
Ningún flag la reemplaza. Si no hay cómo preguntar, la operación sale con `2` y `guardrail_confirmation_required` sin mandar nada a OMI.

| Aprobación previa | Lo autónomo de stage | Lo que exige un humano |
|---|---|---|
| `--yes` en la CLI | pasa sin preguntar | no aprueba: con terminal pregunta igual, sin terminal rechaza |
| `omi init --create` | no aplica | pide crear lo que falte, no lo aprueba: con terminal pregunta, sin terminal rechaza |
| El primer sí de la sesión en la TUI | vale para toda la sesión | no aprueba: cada operación vuelve a preguntar |
| `omi mcp --authorize-stage` | pasa sin preguntar | no aprueba: pregunta por elicitación, y sin ella rechaza |

En la CLI, fuera de una sesión agéntica, lo autónomo de stage corre sin preguntar con o sin `--yes`: el flag se sigue aceptando para no romper scripts.
Dentro de una sesión agéntica `--yes` no vale para nada y la terminal no cuenta como humano.

**Cambio incompatible.** Hasta ahora `--yes` aprobaba cualquier operación en la CLI sin terminal, y `omi init --create` creaba el proyecto y los services sin preguntar.
Un script o un CI que hacía `omi deploy --env prod --yes`, `omi promote --yes`, `omi env set --secret … --yes`, `omi resources postgres … --yes`,
`omi registry create --yes`, `omi visibility set … --yes` u `omi init --create` ahora sale con `2` y `guardrail_confirmation_required`.
No hay un reemplazo desatendido: esas operaciones se corren desde una terminal y se confirman a mano. Publicar y operar stage siguen funcionando igual.

El bump semanal de Pi abre un PR sólo tras typecheck, tests y empaquetado en el mismo workflow. La revisión y el merge son humanos, y mergearlo publica una release. Ese PR muestra una CI esperando aprobación: se puede mergear sin aprobarla, porque el workflow ya publicó `cierre`.

## Desarrollo

Requiere Node 22.19 o superior y `python3` para verificar la plantilla del handler Python en los tests. TypeScript corre sin transpilar desde el checkout.
No se distribuye por npm: Node no ejecuta TypeScript dentro de `node_modules`.
El paquete es privado para impedir publicaciones accidentales; la distribución para usuarios es el binario de release.

```sh
npm ci
npm run typecheck
npm test
npm run test:packaging   # compila e instala de verdad; requiere bun
npm run omi -- --help
```

## Releases de omi

Cada merge a `main` que cambie lo empaquetado publica una release: el merge es la decisión humana.
No hay que empujar tags. Primero se miran las rutas y después el tipo de commit:

| Merge a `main` | Resultado |
|---|---|
| `docs: …` que sólo toca documentación, tests o CI | sin release |
| `fix(cli): …` o cualquier otro tipo sobre lo empaquetado | patch: `0.1.0` → `0.1.1` |
| `feat(tools): …` | minor: `0.1.1` → `0.2.0` |
| `feat!: …` o `BREAKING CHANGE:` | minor antes de 1.0; major después |

Antes de publicar, el pipeline instala y arranca en las cuatro plataformas los mismos archivos que va a publicar.
El tag es la fuente de verdad: `package.json` se estampa sólo en CI, así que en `main` puede quedar atrás.
Para volver atrás, mergeá un `revert:`: `omi upgrade` sólo sube de versión.

```sh
gh workflow run release.yml --ref <rama> -f dry_run=true    # corre todo sin publicar
gh workflow run release.yml --ref main -f dry_run=false     # reintenta una publicación
```

## Registry y visibilidad

Lo que hace falta para llegar a un service público sin pasar por el panel de OMI.
Son las tools `omi_registry_manage` y `omi_visibility_set`, con los mismos subcomandos en la CLI:

| Subcomando | Qué hace | Quién decide |
|---|---|---|
| `omi registry status` | estado del registry de la organización, host y ruta pública | libre |
| `omi registry hosts` | hosts de la organización y cuáles pueden alojar el registry | libre |
| `omi registry create [--host <id>]` | aloja el registry en un host; sin `--host` usa el único que puede alojarlo | humano, siempre |
| `omi registry retry-route` | reintenta publicar el hostname del registry en Cloudflare | humano, siempre |
| `omi visibility set <privado\|organizacion\|publico> --env <stage\|prod>` | cambia quién alcanza un ambiente y espera a que se aplique y a que el acceso quede listo | humano, siempre, también en stage |

`--org <slug>` elige la organización del registry; por defecto es la del repo vinculado o la de la sesión. Crear el registry exige el rol de dueño.

OMI entrega la credencial de push del registry una sola vez, al crearlo. omi no la imprime ni la devuelve por MCP:
la guarda en `~/.omi/registry/<organización>.push-password` con permisos `0600`. Por ejemplo, para cargarla en el CI:

```sh
gh secret set OMI_REGISTRY_PASSWORD < ~/.omi/registry/acme.push-password
```

Si ese archivo se pierde hay que rotar la credencial desde el panel: omi todavía no rota ni da de baja el registry.

El alta puede tardar hasta 2 minutos: OMI publica la ruta en Cloudflare antes de responder. Si la respuesta se pierde
(timeout, red caída, error 5xx), omi consulta el estado y lo dice con un código propio:

| Código | Qué pasó | Qué hacer |
|---|---|---|
| `registry_created_without_credential` | el registry quedó creado, pero la credencial no llegó | rotarla desde el panel |
| `registry_create_unconfirmed` | no se pudo saber si quedó creado | `omi registry status`; si existe, rotar la credencial desde el panel |
| `registry_password_not_saved` | la credencial llegó pero no se pudo dejar en su ruta | el error dice en qué archivo temporal `0600` quedó: moverlo a mano |

Si el registry ya existe o tu rol no es dueño, `omi registry create` falla antes de pedir confirmación.

`publico` deja el hostname del ambiente en internet; `organizacion` lo limita a los services de la organización en el mismo ambiente.
Repetir `omi visibility set` con el mismo valor reintenta un cambio que quedó fallido; si ya está aplicado, no pide confirmación ni cambia nada.
Si hay un cambio en curso, espera a que termine y decide sobre el estado real.

El comando termina bien cuando el acceso del ambiente quedó `listo`. Sale con 1, y `access_ready: false` en `--json`, si el acceso
falló (OMI lo reintenta solo, y el mensaje dice cuándo) o si no quedó listo en 5 minutos. Un ambiente sin versión desplegada
no publica nada hasta su primer deploy: el comando sale con 0 y lo avisa. `omi status` muestra la visibilidad, su aplicación y el acceso.

## SQL en un Postgres del proyecto

Para mirar y corregir los datos de un Postgres que OMI administra, `local` o `externa`, sin pasar por el panel ni tener la URI.
Son las tools `omi_postgres_query` y `omi_postgres_exec`, con los mismos subcomandos en la CLI:

| Subcomando | Qué hace | Quién decide |
|---|---|---|
| `omi resources postgres query --env <stage\|prod> "<sql>"` | corre una consulta de sólo lectura y muestra una tabla | libre, también en prod |
| `omi resources postgres exec --env <stage\|prod> "<sql>"` | ejecuta una sentencia que puede escribir; devuelve las filas afectadas y las de `RETURNING` | humano, siempre, también en stage |

```sh
omi resources postgres query --env prod --slug ventas "SELECT id, email FROM usuarios ORDER BY id DESC LIMIT 20"
omi resources postgres query --env stage --file consulta.sql --json
omi resources postgres exec --env prod --slug ventas "DELETE FROM usuarios WHERE email = 'prueba@omi.test'"
```

- **Qué recurso.** `--slug` elige el Postgres del ambiente y se puede omitir sólo si el ambiente tiene uno; `--resource-id <res_…>` lo nombra sin ambiente. Con más de uno, en cualquier estado, hay que nombrar cuál: el comando los lista con su estado y no elige. Si `--resource-id` no coincide con el `--env` o el `--slug` pedidos da `resource_mismatch` y no envía nada. Uno que todavía no tiene base activa (recién creado, `provisionando`, alta fallida) da `resource_not_active` antes de pedir confirmación. La salida, también en `--json`, dice siempre la base y el ambiente reales contra los que corrió.
- **El SQL.** Una sola sentencia: como argumento entre comillas, o con `--file <archivo>` (`--file -` lee stdin). Si empieza con un guion, va después de `--`: `omi resources postgres query --env stage -- "-- nota\nSELECT 1"`.
- **Por qué `query` es libre, también en prod.** Es una decisión: mirar los datos no pide confirmación. Depende de dos cosas. Una, que la API de OMI garantice la sólo-lectura: transacción `READ ONLY` y, en una base `local`, un rol sin permisos de escritura. En una base `externa` depende del rol de la URI con que se dio de alta: si ese rol es superusuario, una función con efectos puede correr desde un `SELECT`. Dos, que **los datos devueltos llegan al modelo** que llamó a la tool, y a su proveedor: una consulta sobre datos personales o secretos los saca de la base.
- **Sólo lectura de verdad.** `query` no depende de que el SQL "parezca" un `SELECT`: OMI lo corre dentro de una transacción de sólo lectura, como consulta de un cursor, y Postgres rechaza cualquier otra cosa. `INSERT`, `UPDATE`, `DELETE`, DDL, `COPY`, `SET`, `EXPLAIN` o dos sentencias juntas dan `sql_error`. Para eso está `exec`.
- **Quién puede.** `query` pide ser miembro de la organización; `exec` pide ser dueño (un miembro recibe `forbidden`).
- **Confirmación de `exec`.** Muestra el ambiente, la base y el SQL completo, con los caracteres de control a la vista, y pregunta: en la terminal, en el diálogo de la TUI o por elicitación del cliente MCP. `--yes` no la aprueba. Sin cómo preguntar sale con `2` y `guardrail_confirmation_required` sin mandar nada a OMI.
- **Topes.** Por defecto OMI devuelve hasta 500 filas y 1 MiB, y corta la sentencia a los 10 segundos. `--max-rows <n>` y `--timeout <s>` son enteros desde 1 y sólo pueden pedir menos: pedir más da `invalid_sql_limits`. Si el resultado se corta, la tabla termina con `truncado: sí` y `--json` trae `truncated: true` con `truncated_by` (`rows` o `bytes`).
- **`--json`.** `{ resource, columns, rows, row_count, truncated, truncated_by?, rows_affected?, command?, duration_ms, limits }`. `columns` trae nombre y tipo de Postgres. Cada celda es JSON: `null`, booleanos, números para `smallint` e `integer`, el valor embebido para `json` y `jsonb`, y un string con el texto de Postgres para todo lo demás (`bigint` y `numeric` incluidos, para no perder precisión; `bytea` en hex; `timestamptz` en UTC). La tabla de la terminal recorta las celdas de más de 80 caracteres; `--json` no.

| Código | Qué pasó | Qué hacer |
|---|---|---|
| `sql_error` | Postgres rechazó la sentencia; el mensaje trae el SQLSTATE y la posición, y `--json` los suma como `sqlstate` y `position` | corregir el SQL |
| `sql_timeout` | la sentencia superó el timeout y se canceló sin aplicar cambios | acotar la consulta |
| `sql_connection_failed` | OMI no pudo conectar a la base | revisar el recurso con `omi resources list` |
| `sql_agent_unavailable` | el agente del control plane no tomó el pedido: desconectado, ocupado o sin actualizar; no se ejecutó nada | reintentar; si sigue, revisar el host |
| `sql_outcome_unknown` | sólo en `exec`: no se sabe si la sentencia se aplicó. También sale si, después de enviar el pedido, no vuelve una respuesta de OMI que garantice que no se aplicó: timeout del cliente, corte de red, señal abortada, o un 4xx o 5xx de un intermediario. omi nunca la reintenta | verificar con `query` antes de repetirla |
| `sql_result_unreadable` | sólo en `exec`: la sentencia se ejecutó, pero la respuesta no se pudo leer | no repetirla; mirar el estado con `query` |
| `resource_not_active` | el Postgres todavía no tiene una base activa | esperar o revisar su estado con `omi resources list` |
| `resource_operation_in_progress`, `resource_not_ready`, `resource_unhealthy` | el Postgres tiene una operación en curso, no está `lista` o su base local está caída; no se ejecutó nada | esperar a que termine o revisar su estado con `omi resources list` |
| `sql_busy` | hay 8 pedidos en curso contra el control plane, o 3 tuyos; no se ejecutó nada | esperar a que termine alguno |

OMI registra cada consulta y ejecución (quién, cuándo, recurso, ambiente, el SQL, filas y resultado), nunca los valores devueltos.

## Publicación y reintentos

El modo directo construye para `linux/amd64`, igual que el workflow del kit en su runner predeterminado.
No sobrescribe una versión que OMI ya detectó. Si la espera del registry vence después del push,
`omi publish --version X.Y.Z --service api --wait-only` retoma sólo el polling, sin construir ni tocar tags.

## Alcance de los guardrails

Las confirmaciones protegen las operaciones realizadas por las superficies soportadas; **no son un sandbox**.
Un agente con bash y acceso al mismo filesystem puede quitar variables de entorno, fabricar un TTY,
leer el token local o actuar como su propio cliente MCP. Ni un TTY ni una respuesta MCP `accept` prueban identidad humana.
No confíes en estos checks como barrera frente a código hostil con acceso a credenciales de producción.

El aislamiento y la autorización fuera del control del agente quedan pendientes en [CLI #5](https://github.com/chichex/omi-code/issues/5)
y [MCP #6](https://github.com/chichex/omi-code/issues/6). Las sesiones identificadas como agénticas no aceptan `--yes`,
`--create`, pseudo-terminales ni `--authorize-stage` como aprobación; ocultar esa identidad sigue fuera de la garantía actual.

Que `--yes` y `--create` ya no aprueben lo que exige un humano cierra el camino directo: un agente externo o un script sin terminal no puede crear,
promover ni tocar prod. No cierra el indirecto: la CLI toma como humano a quien responde en un TTY, y un agente con bash puede fabricar uno y contestar «s».

## Licencia

MIT.
