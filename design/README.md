# OMI Code — revisión 03: terminal, no dashboard web

`omi-code-preview.html` es la **referencia visual del rediseño de la TUI**, no una captura del runtime. Esta revisión acompaña la implementación local: lateral de 41 columnas, negro uniforme, bloques rectangulares, sesión agrupada e indicadores de círculos. No certifica paridad visual con el runtime. `omi-code-preview-v1.html` se conserva sólo como referencia histórica.

La maqueta usa restricciones de terminal: una sola celda monospace, filas enteras y marcos de caracteres. Los controles de revisión del navegador no forman parte de OMI.

## Abrir

Abrí `omi-code-preview.html` directamente en el navegador. No requiere dependencias, instalación, servidor, red, fuentes externas ni build.

## Contrato visual

- **Una sola tipografía, tamaño y alto de línea en toda la TUI**, incluidos los diálogos. El selector de letra exterior representa la configuración del terminal; no es una capacidad de OMI para cambiar la fuente del usuario.
- El ancho de celda se mide con la fuente monospace del navegador. Cada fila ocupa un alto de línea. No se escala la ventana con `transform` para hacerla entrar.
- Presets **132 × 40**, **160 × 44**, **110 × 32**, **110 × 26** y **80 × 24**, más tamaño automático. Se limitan al espacio disponible y se informan las dimensiones efectivas debajo. **Grilla** permite inspeccionar las celdas.
- Cabecera: tres filas. Pie: tres filas. Editor de Chat: cuatro filas, dentro de la columna de conversación. El resto es contenido.
- La lateral ocupa **41 columnas, incluidos sus marcos**. Está disponible desde **110 columnas y 26 filas**; por debajo se oculta sin convertirse en un drawer móvil. F4 la oculta completa independientemente de qué bloques estén habilitados. Los comandos siguen disponibles.
- **Proyecto, Sesión, GitHub Actions, OMI, Subagentes y Recursos** usan rectángulos de caracteres, con título y bordes laterales. Con alto suficiente, cada bloque tiene marco completo; cuando falta alto comparten bordes contiguos y compactan el contenido. No se recortan los bloques inferiores para conservar los superiores. El espacio libre queda al final.
- La lateral usa negro uniforme **`#000000`**, sin tintes, franjas ni colores de fondo por sección. El resto conserva la paleta existente: conversación `#050607`, cabecera/pie `#15191c` y bordes `#292f34`. El color del texto conserva jerarquías, actividad, advertencias y errores. Los mensajes propios mantienen su tratamiento (`▌ Vos`, fondo verde oscuro); no se rediseñan las otras vistas. En el runtime el tema claro conserva una lateral blanca accesible.
- Bordes e indicadores son caracteres, no barras gráficas CSS. No hay SVG, avatares, sombras, esquinas redondeadas, blur, chips ni tamaños de fuente particulares por componente.

### Bloques de la lateral

- **Proyecto:** repo, rama, ubicación y cambios. `↑N ↓N` cuenta commits respecto al upstream local del último fetch, no archivos sin commit. `Al día (local)` evita presentar ceros como actividad. En el runtime, ausencia de upstream y errores se informan como tales, nunca como ceros; la maqueta no simula todos esos casos. El detalle explica `git fetch`, sin ejecutarlo, y que un worktree no es un sandbox.
- **Sesión:** modelo y proveedor, esfuerzo de razonamiento, contexto con porcentaje y tokens usados / límite. El nombre del modelo no lleva un puntaje de calidad inventado. Clic en modelo o esfuerzo abre el selector; clic en contexto abre `/omi-context`.
- El razonamiento usa **seis círculos `●○`** y el esfuerzo configurado: **off = 0, minimal = 1, low = 2, medium = 3, high = 4, xhigh = 5, max = 6** llenos. No representa velocidad ni calidad del modelo. El selector sólo ofrece los esfuerzos del catálogo simulado para ese modelo; el indicador refleja la selección, no un rating.
- El contexto usa **diez círculos**, valor porcentual y tokens; cada círculo aproxima un décimo de ocupación. La maqueta conoce el cero del escenario Inicio; el runtime debe mostrar `—` cuando no conoce el uso, no inventar un cero. `/compact` sigue siendo explícito. No hay desglose ficticio por sistema/chat/tools.
- **Sólo fuera de Inicio**, Sesión incluye entrada, salida, caché y costo de ejemplo. En compacto se abrevian como **E** (entrada), **S** (salida), **C** (caché) y **$** (costo). Son datos simulados de consumo, no cuota ni saldo del proveedor, ni una promesa de medición real del HTML.
- **GitHub Actions:** Claude reviews y Releases, con ejecución, antigüedad y hasta dos ejemplos por workflow en la maqueta. Se reduce a un resumen por workflow si falta alto, sin ocultar OMI. Un check indica ejecución exitosa, no aprobación del PR. Clic o `/omi-actions` abre el detalle. No lanza reviews ni releases.
- **OMI:** proyecto vinculado o estado no disponible / sin vincular. Clic abre la vista de sólo lectura con servicios y ambientes de ejemplo. `running` no se presenta como health check; las operaciones siguen en Chat y conservan las confirmaciones del runtime.
- **Subagentes:** activos y en cola, agente, estado, tool y tiempo cuando hay espacio; un resumen contiguo en compacto. Sin tareas dice `Sin subagentes activos`. Trabajando tiene tareas simuladas y otros escenarios no iniciales tienen una tarea terminada. Clic o `/omi-subagents` abre IDs, tareas, estados, tiempos, turnos y la explicación para cancelar un lote, sin almacenar outputs privados.
- **Recursos:** CPU, RAM y disco usan **diez círculos `●○` más valores numéricos**, nunca barras de bloques sólidos. Los datos son del host `chichex-linux` de ejemplo, no del Mac que muestra el HTML. El consumo de OMI aparece por separado con espacio suficiente y siempre en el detalle; no suma herramientas ni subprocesos. Recursos exigidos eleva los valores y marca advertencias, sin inventar éxito ni salud.

### Pie y personalización

- El modelo mantiene una fila propia en el pie: nombre destacado y, según el ancho, proveedor, **el mismo patrón de razonamiento** y `Ctrl L cambiar`. En panes angostos se prioriza el nombre sin mezclarlo con la ubicación del repo.
- **Ocultar Sesión también lleva el contexto al pie**, aunque los otros bloques de la lateral sigan visibles. Lo mismo sucede con F4 y en panes angostos. El acceso conserva porcentaje y tokens, con diez círculos cuando entran, y abre el detalle.
- **`Personalizar lateral >`** queda al pie de la lateral; también se abre desde la paleta o **`/omi-sidebar-settings`**. El modal tiene un checkbox por bloque: **↑↓** navega, **Espacio / Enter** alterna, **Ctrl+S** guarda, **Esc** cancela y **r** restablece todos visibles en el borrador. Restablecer no guarda hasta confirmar con Ctrl+S. Las acciones también tienen alternativa por clic.
- La maqueta guarda preferencias **sólo en el estado local en memoria**, sin `localStorage`: recargar restablece los bloques visibles. Cancelar no cambia lo guardado. Aun ocultando todos, queda el acceso para personalizar. Ocultar un bloque no desactiva su comando ni las verificaciones de seguridad del runtime.

## Qué revisar

1. **Inicio:** bienvenida breve y sin conversación inventada; Sesión no muestra consumo ni costo de ejemplo.
2. **Conversación:** mensaje del usuario, respuesta, tool plegable, archivos y editor, conservando sus interacciones.
3. **Trabajando:** actividad, herramientas resumidas en gris y subagentes simulados. No se permite cambiar modelo durante el turno de ejemplo.
4. **Contexto alto:** círculos, porcentaje y advertencia coherentes; elegir una ventana menor impide aplicar el cambio hasta resolver el exceso.
5. **Recursos exigidos:** CPU/RAM/disco con valores elevados y advertencias; el detalle separa host y proceso OMI.
6. **Sin GitHub / OMI:** no se sustituyen errores por checks exitosos ni ambientes saludables.
7. **Repo principal / Worktree** y **sin proyecto / vinculado:** escenarios independientes con paths, PR y servicios de ejemplo, sin inferir una vinculación inexistente.
8. **110 × 26:** bloques compactos contiguos con todos los títulos, contexto y recursos; **132 × 40 / 160 × 44:** marcos completos cuando hay espacio. El tamaño efectivo depende de la ventana del navegador.
9. **Personalización:** guardar, cancelar, restablecer, ocultar todos, recuperar Sesión y verificar el contexto en el pie sin ella.
10. **80 × 24 / F4:** sin lateral, conservando pie, editor, vistas y comandos.

## Interacciones conservadas

- Clic en **1 Chat / 2 Issues / 3 PRs / 4 Cambios / 5 OMI**, o **Control 1–5**. En panes angostos se conservan los cinco números y el nombre de la vista activa.
- **Control K:** paleta; **Control L:** selector de modelo; **F4:** lateral. **Esc:** cierra el diálogo o vuelve a Chat desde las vistas de sólo lectura.
- Cambios muestra `+líneas` y `−líneas`, acortando la ruta cuando falta ancho; flechas seleccionan, Enter abre un extracto de diff y Backspace vuelve a la lista. Los conteos y el diff son inventados.
- Issues y PRs conservan listas separadas de todo el repo; flechas seleccionan y Enter o clic abre un detalle ilustrativo. El runtime consulta la descripción sólo al abrirla.
- En Worktree, `[ PR #51 ↗ ]` junto a la rama mantiene su ancho y el asterisco de dato desactualizado cuando corresponde. Su clic sólo avisa que es una maqueta; `/omi-pr` muestra la URL. En el runtime abre el navegador, con el comando como alternativa por teclado.
- Las herramientas consecutivas se representan con resúmenes grises `Read 3 files`, `Edited 2 files` y `Ran 3 shell commands` (o `Running` en Trabajando). Clic, **Ctrl+O**, `/omi-output` o la paleta alternan el detalle de ejemplo. El HTML usa un único estado de expansión para todos los grupos; el runtime permite abrir cada grupo por separado. En el runtime, errores/abortos se colapsan en grupos separados con el color de error: `Failed 2 shell commands`, `Failed to read 2 files`, `Failed to edit 1 file`, `Failed to write 1 file`, `Failed 3 searches` o `Failed omi_project_status 2 times`. Cuentan intentos fallidos aunque repitan una ruta, no rutas distintas como las lecturas/ediciones/escrituras exitosas. Expandir revela los detalles originales de Pi, incluidos errores/abortos; las imágenes siguen visibles con su presentación nativa. La maqueta no simula estos grupos fallidos. Clic en Proyecto o Recursos abre ubicación o recursos completos. Ningún clic ejecuta comandos.
- El selector permite buscar modelo/proveedor, favoritos en memoria, Ctrl F para filtrar, Ctrl S para marcar, revisar la elección, ajustar razonamiento con izquierda/derecha y Enter para aplicar. Esc cancela. `#models` lo abre directamente.
- El editor reconoce `/omi`, `/model`, `/omi-model`, `/omi-context`, `/omi-workspace`, `/omi-resources`, `/omi-chat`, `/omi-issues`, `/omi-prs`, `/omi-changes`, `/omi-platform`, `/omi-pr`, `/omi-actions`, `/omi-subagents`, `/omi-sidebar`, `/omi-sidebar-settings` y `/omi-output` **sólo dentro de la maqueta**.

Un navegador o macOS pueden reservar atajos antes de entregarlos al HTML. Las acciones tienen alternativa por clic; el prototipo no modifica las preferencias del navegador, Herdr ni el sistema.

## Qué sigue siendo una aproximación

Esto **no es un emulador VT ni un screenshot del runtime**. La fuente real, el ancho de ciertos caracteres Unicode y los colores finales dependen del terminal. El HTML conserva un editor de una línea y una geometría simplificada; no reproduce toda la edición multilínea, selección, pegado ni autocompletado de Pi. Tampoco prueba streaming real, accesibilidad del terminal ni manejo de sesiones. El runtime sigue usando el renderer de Pi, no este HTML.

Los modales de detalle mantienen el marco simplificado existente, de hasta 76 columnas y desplazamiento con flechas. No se rediseñan las demás vistas ni se reproducen todos los anchos, colores por tema, scroll y componentes nativos del runtime. El HTML sólo representa el tema oscuro; una selección explícita de tema del runtime sigue controlando sus colores. La compactación de la lateral y la prioridad del pie son aproximaciones para revisar el contrato, no un renderer compartido.

Esta revisión **no incorpora capturas nuevas ni afirma una validación visual en Herdr**. Para comprobar paridad hay que comparar el mismo estado y número efectivo de columnas y filas. La grilla y los chequeos de JavaScript no sustituyen esa revisión visual.

Todos los datos de Git, issues, PRs, Actions, subagentes, versiones, modelos, capacidades, razonamiento, contexto, consumo, costo y recursos son **simulados**. Diffs, descripciones y salidas de tools son extractos inventados. Nada envía mensajes, llama a un modelo, ejecuta comandos, modifica el repo, crea worktrees, consulta servicios ni despliega.
