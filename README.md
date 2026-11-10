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

### Instalación limpia

Una instalación nueva viene vacía: sin skills, sin extensiones ajenas y sin modelo. Sólo trae las tools y las integraciones propias de OMI.
Para usar un modelo, entrá con `/login` o importá credenciales.

omi sólo lee configuración de `~/.omi/agent` y del proyecto, del directorio actual hasta la raíz del repo.
Por ejemplo, no carga `~/.pi/agent`, `~/.agents/skills` ni `~/AGENTS.md`. Para instrucciones globales usá `~/.omi/agent/AGENTS.md`.
La configuración del repo (`.pi/`, `.agents/skills`) sigue valiendo, con la confirmación de confianza.

Las API keys del shell no le dan un modelo a omi. Por ejemplo, con `GEMINI_API_KEY` exportada, omi arranca igual sin modelo. Los comandos que corre el agente sí la ven, como cualquier comando de tu shell.

### Workspace de terminal

`omi` arranca con un layout fullscreen propio: cabecera con **1 Chat / 2 Issues / 3 PRs / 4 Cambios / 5 OMI**, conversación y editor,
lateral plegable con contexto encima de recursos y pie con actividad y una fila propia para el modelo. El fondo por defecto es negro; una selección de tema
explícita sigue controlando los colores del runtime. La conversación, las tools, sus confirmaciones, el streaming,
el historial y la edición siguen usando el renderer de Pi; no hay un segundo proceso de chat ni una UI web.

- **1 · Chat:** conversación y editor. Tus mensajes llevan un encabezado **▌ Vos** y, con la paleta por defecto, un fondo verde oscuro y texto claro.
  Las respuestas y herramientas conservan su presentación. La etiqueta es sólo visual: no modifica lo enviado al modelo ni lo guardado en el historial.
- **2 · Issues:** hasta 100 issues abiertos de todo el repo de GitHub, no sólo de la branch actual.
- **3 · PRs:** hasta 100 PRs abiertos de todo el repo, incluidos los borradores.
  Ambas listas requieren `gh` instalado y autenticado; flechas seleccionan, **Enter** carga la descripción del elemento elegido y **r** actualiza.
  Los errores se muestran por separado y conservan la última lista como desactualizada, no como una lista vacía exitosa.
  Estas vistas son de sólo lectura; no crean issues ni cierran o fusionan PRs.
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
  Es el punto de consulta de infraestructura, separado de GitHub. Las operaciones de variables, recursos, jobs, versiones, logs y deploys
  siguen disponibles mediante las herramientas en Chat, con sus confirmaciones habituales; el panel no las ejecuta automáticamente.
- **Ubicación del repo:** la lateral y `/omi-workspace` muestran branch, cambios locales, divergencia cuando existe upstream, tipo de checkout y ruta activa.
  Distingue `Repo principal`, `Worktree · nombre`, HEAD separado y carpetas sin Git. Un worktree no es un sandbox.
  `↑N ↓N` son **commits** por subir/traer, no archivos ni líneas sin commit. Se comparan con la referencia local del último fetch;
  la lateral muestra `Al día (local)` si ambos son cero, `sin upstream` si no está configurado y `↑— ↓—` si el conteo no está disponible.
  No hace fetch automático ni convierte errores en ceros. `/omi-workspace` muestra el upstream y explica cómo actualizarlo con `git fetch`.
  Las secciones Proyecto, GitHub Actions, OMI, Contexto y Equipo tienen encabezados de distintos colores, fondo tenue y separadores de caracteres, respetando el tema claro/oscuro.
  Se agrupan sin dejar un hueco creciente antes de Contexto; el espacio libre queda al final. Los recortes y los márgenes conservan el fondo del panel.
- **GitHub Actions en la lateral:** agrupa **Claude reviews** (`claude-review.yml`) y **Releases** (`release.yml`) con el mismo encabezado que las demás secciones, sin un marco adicional que reste ancho. Muestra hasta tres ejecuciones recientes por workflow de todo el repo, con estado, nombre y antigüedad alineada a la derecha y separada por al menos dos espacios. Se adapta al espacio disponible; en terminales bajas muestra un resumen por workflow sin ocultar OMI. Los nombres corresponden a las ejecuciones reales, no a tags inferidos. Un check indica ejecución exitosa, no aprobación del PR. Clic en la sección o `/omi-actions` abre el detalle con las URLs. Sólo consulta: no dispara reviews ni releases.
- **Contexto:** encima de Equipo, con tokens estimados / límite real del modelo, porcentaje y barra sólida `█`.
  Si el runtime no conoce el uso se muestra `—`, no cero. Con la lateral oculta, el dato queda en el pie.
  No se inventa un desglose de tokens. `/omi-context` explica el dato y `/compact` sigue siendo explícito.
- **Recursos:** CPU total, RAM disponible, volumen del proyecto y consumo separado del proceso OMI. Son del **host donde corre OMI**:
  conectado por SSH a Linux, no representan tu Mac. La RAM aproximada se marca `≈` y una métrica no soportada queda como no disponible.
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
| Ctrl 5 o `/omi-platform` | OMI: proyecto, servicios y ambientes |
| Ctrl K o `/omi` | Paleta de comandos (Ctrl K reemplaza borrar hasta fin de línea en el editor) |
| F4 o `/omi-sidebar` | Mostrar / ocultar lateral |
| `/omi-actions` | Detalle de Claude reviews y releases de GitHub Actions |
| `/omi-pr` | URL, título y estado del PR de la rama actual |
| `/omi-model` | Selector propio, también si otra extensión personaliza el editor |
| `/omi-workspace` | Ubicación, repo principal y worktree |
| `/omi-resources` | CPU, RAM, disco y host |
| `/omi-context` | Detalle del contexto |

Los atajos son **Control** también en Mac, no Option ni Command. **Esc** vuelve a Chat desde las vistas de consulta.
Las pestañas también funcionan por clic; en panes angostos conservan los cinco números y el nombre de la vista activa.

El pie muestra **`[ PR #123 ↗ ]`** como botón junto a la rama actual, incluso si debe recortar su nombre.
Se resuelve con `gh pr status`, incluyendo el remoto y los forks, sin inferirlo de la lista de PRs del repo.
En fullscreen, un clic normal en cualquier parte del botón (incluidos bordes y espacios internos) abre la URL mediante `gh pr view <URL> --web`; los espacios libres del pie no abren Ubicación.
También conserva el enlace OSC 8 para la interacción nativa del terminal. `/omi-pr` y la paleta permiten ver y copiar la URL por teclado; si falla el navegador, se muestra una advertencia con ese detalle.
Si falla una actualización, se conserva el enlace con `*` como dato desactualizado; al cambiar de rama se descarta el anterior.
Sin PR, con HEAD separado o sin datos no se inventa un enlace. Se respeta `--offline` y la confianza del proyecto.

La lateral ocupa 33 columnas (incluido el separador) y se oculta por debajo de 110 columnas o 26 filas;
los comandos y el pie siguen disponibles. Contexto, CPU, RAM y disco usan barras de bloques `█` de una fila;
en panes bajos, las barras de recursos se acortan para conservar todos los datos.
El inicio vacío muestra una bienvenida breve, sin inventar una conversación. Los componentes internos de OMI
no aparecen en la lista de extensiones ni se ofrece actualizar Pi por separado. Las extensiones del usuario,
sus diagnósticos y sus avisos de actualización se conservan; no se modifica `quietStartup` en los ajustes.
Los datos locales se refrescan aproximadamente cada 3 segundos y los remotos cada 30, sin bloquear el streaming.
Errores de GitHub u OMI se muestran como no disponibles / desactualizados, nunca como checks exitosos ni ambientes saludables inventados.
`--offline` y los proyectos sin confianza no disparan estas consultas remotas. Favoritos y visibilidad de la lateral se guardan
sólo en `~/.omi/agent/workspace-ui.json` (o la raíz elegida con `OMI_HOME`).

Para volver a la presentación anterior:

```sh
OMI_TUI=classic omi
# Desde el repo:
OMI_TUI=classic npm run omi
```

`--tui-mode regular` conserva el modo de scrollback del terminal, sin las vistas fullscreen ni la lateral.
RPC, JSON, print y MCP no abren recursos de la UI. El adaptador del layout está verificado con Pi 1.5.0;
si cambia su contrato, conserva la vista base y avisa. No parchea archivos de `node_modules`.

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

Importar es la única forma de traer algo, y siempre duplica: después podés borrar `~/.pi` y omi sigue igual. La excepción es un paquete con `~/.pi` escrito en su código: sigue usando esa ruta.

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
`omi login` inicia la sesión de OMI, que es distinta de la autenticación de GitHub. Hasta que `chichex/omi#140` esté desplegado, `omi login` no funciona contra producción.

## Guardrails

Son controles locales para las superficies soportadas, no aislamiento de un proceso hostil (ver «Alcance de los guardrails»).

| Operación | Quién decide |
|---|---|
| Lecturas | libre |
| Variables no secretas, jobs y deploy en stage, publicar | autónomo en una sesión autorizada |
| Cualquier cosa en prod, secretos, Postgres, bajas | humano, siempre |

En la TUI, el primer sí a una operación de stage vale para toda la sesión. En `omi mcp`, lo hace el flag `--authorize-stage` y la aprobación humana llega por elicitación del cliente MCP. En la CLI sin terminal, `--yes` aprueba; dentro de una sesión agéntica, no vale.

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
| `docs(review): …` que sólo toca `.chiche/` | sin release |
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

## Licencia

MIT.
