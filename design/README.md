# OMI Code — revisión 02: terminal, no dashboard web

`omi-code-preview.html` es la **referencia visual de la TUI**, no una captura del runtime. Ya se trasladaron al código la bienvenida, la lateral compacta, contexto encima de Equipo, la fila dedicada al modelo y las barras sólidas. La versión anterior se conserva en `omi-code-preview-v1.html` sólo como referencia.

La primera maqueta prometía demasiado con recursos de una web: tarjetas, padding en píxeles, tipografías de distinto tamaño, sombras y botones que no tenían equivalente directo en la TUI. Esta revisión trabaja con restricciones de terminal desde el principio.

## Abrir

Abrí `omi-code-preview.html` directamente en el navegador. No requiere dependencias, instalación, servidor, red, fuentes externas ni build.

Opcionalmente, desde la raíz del repo:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory design
```

Entrá a <http://127.0.0.1:4173/omi-code-preview.html>.

## Contrato visual

- **Una sola tipografía, tamaño y alto de línea en toda la TUI**, incluidos los diálogos. El selector de letra está fuera de la TUI: representa la configuración del terminal, no una capacidad de OMI para cambiar la fuente del usuario.
- El ancho de la celda se mide con la fuente monospace del navegador. Cada fila ocupa exactamente un alto de línea. No se escala la ventana con `transform` para hacer que entre.
- Presets **132 × 40**, **160 × 44**, **110 × 32** y **80 × 24**, más tamaño automático. Se limitan al espacio real disponible y se informan las dimensiones efectivas debajo.
- El control **Grilla** permite inspeccionar las celdas. Los controles de revisión de arriba y las notas de abajo no forman parte del producto.
- Cabecera: tres filas. Pie: tres filas. Editor: cuatro filas, dentro de la columna de conversación. El resto es contenido.
- Lateral de **32 columnas más un separador**, sin tarjetas ni barras gráficas CSS. Se oculta por debajo de 110 columnas o 26 filas; los detalles siguen en la paleta. No aparece como un drawer móvil, porque eso no es el comportamiento propuesto para un pane angosto.
- **Secciones de la lateral distinguibles de un vistazo:** Proyecto violeta, GitHub Actions azul, OMI verde, Contexto ámbar y Equipo celeste, con negrita, fondo tenue y un separador `▌ … ─`. En el runtime los tonos salen del tema activo, también en modo claro.
- **Sincronización Git sin ceros ficticios:** `↑N ↓N` cuenta commits respecto al upstream local del último fetch, no cambios sin commit. `Al día (local)` sustituye al 0/0, `sin upstream` indica ausencia de configuración y `↑— ↓—` indica conteos no disponibles. El detalle muestra el upstream y explica `git fetch`; la UI no lo ejecuta automáticamente.
- **Contexto vive en la lateral, justo arriba de Equipo:** tokens usados / límite, porcentaje y barra de caracteres. Al hacer clic abre el detalle. Cuando la lateral está oculta, queda un acceso compacto en el pie para no perder el dato.
- **El modelo tiene una fila propia en el pie:** etiqueta `Modelo:`, nombre resaltado, proveedor, razonamiento y `Ctrl L cambiar` cuando el ancho lo permite. En panes angostos se prioriza el nombre, sin mezclarlo con la ubicación del repo.
- **Barras más gruesas con caracteres `█`**, no líneas finitas: contexto, CPU, RAM y disco. El tramo usado tiene color y el resto un gris oscuro. Ocupan una fila de terminal, sin aumentar la fuente ni dibujar barras con altura CSS. En panes bajos, las de recursos se acortan y comparten fila con su etiqueta y valor.
- Los paneles usan fondos planos. Los bordes, indicadores y barras son caracteres. No hay SVG, avatares, sombras, esquinas redondeadas, blur, chips ni tamaños de fuente particulares por componente.
- La conversación conserva un único flujo vertical. Los mensajes propios tienen encabezado `▌ Vos` en negrita y color de acento, fondo verde oscuro `#182b23` y texto claro `#edf5f0`; las respuestas y herramientas no comparten ese fondo. El encabezado es sólo de presentación, no se agrega al mensaje original. La salida de la herramienta se puede desplegar, sin adornos de interfaz web.
- Los diálogos se dibujan con caracteres y tienen el mismo tamaño de celda que el resto. No dependen de un selector de modelos del navegador para simular la TUI.

## Qué revisar

1. **Inicio:** bienvenida breve, sin lista técnica de extensiones ni avisos de actualizar Pi.
2. **Conversación:** mensaje del usuario, respuesta, actividad, tool plegable, archivos y editor.
3. **Trabajando:** actividad visible, tool desplegada y pie con estado de ejecución.
4. **Contexto alto:** porcentaje y advertencia coherentes; cambiar a una ventana menor requiere resolver el exceso antes de aplicar.
5. **Recursos exigidos:** CPU/RAM/disco con advertencias textuales; el detalle separa host y proceso OMI.
6. **Sin GitHub / OMI:** no se sustituyen errores por checks exitosos ni ambientes saludables.
7. **Repo principal / Worktree:** son escenarios independientes. La ubicación se detalla en el modal, con path activo y repo principal. Un worktree no se presenta como un sandbox.
8. **Datos sin vincular / Proyecto vinculado:** el estado inicial no inventa servicios. Los ejemplos vinculados muestran `running`, sin presentarlo como un health check.
9. **Pane angosto:** verificar el peso del pie, del editor y del texto sin la lateral.

## Interacciones

- Clic en **1 Chat / 2 Issues / 3 PRs / 4 Cambios / 5 OMI**, o **Control 1–5**. En panes angostos se conservan los cinco números y el nombre de la vista activa.
- **Control K:** paleta; **Control L:** selector de modelo; **F4:** lateral.
- **Esc:** cierra el diálogo o vuelve a Chat desde las vistas de sólo lectura.
- En Cambios, cada archivo muestra `+líneas` en verde y `−líneas` en rojo a la derecha; sólo se acorta la ruta cuando falta ancho. Los colores de los contadores se conservan al seleccionar la fila. En el runtime son cambios netos respecto a HEAD, incluyendo stage y working tree; los binarios se indican como `binario`, los conteos desconocidos como `—` y los archivos sin seguimiento como `nuevo`, sin leerlos automáticamente. Flechas para seleccionar y Enter para abrir el extracto de diff; Backspace vuelve a la lista.
- Issues y PRs muestran listas abiertas de todo el repo, por separado; flechas seleccionan y Enter o clic abre un detalle ilustrativo. El runtime carga la descripción sólo al abrirla. El runtime además consulta GitHub Actions para la sección de la lateral: Claude reviews y Releases, con estado de ejecución y antigüedad, sin un marco adicional y con el mismo encabezado `▌ … ─` que las demás secciones. En panes bajos se compacta sin ocultar OMI. Las secciones quedan agrupadas arriba, sin un hueco antes de Contexto. Esa sección de Actions todavía no está representada en el HTML.
- El runtime muestra `[ PR #123 ↗ ]` junto a la rama en el pie, resuelto por `gh pr status`. Todo el botón es clickeable y abre el navegador; el espacio libre no abre Ubicación. `/omi-pr` ofrece la URL por teclado, también como fallback si falla el navegador. Se reserva su ancho antes de recortar la rama, se descarta al cambiar de rama y se marca con `*` si el dato queda desactualizado. Este enlace todavía no está representado en el HTML.
- OMI agrupa el proyecto vinculado, servicios y ambientes. El panel es de consulta; las operaciones siguen en Chat mediante las herramientas con sus confirmaciones.
- Clic en la línea de `bash` despliega la salida.
- Clic en el contexto de la lateral (encima de Equipo), o su acceso de respaldo en panes angostos, abre uso, límite y explicación. **No muestra el desglose inventado de sistema/chat/tools** de la versión anterior.
- Clic en Proyecto o Equipo abre ubicación o recursos completos.
- El selector de modelos permite buscar por nombre/proveedor, favoritos en memoria, Ctrl F para filtrar, Ctrl S para marcar, revisar la elección, ajustar razonamiento con izquierda/derecha y Enter para aplicar. Esc cancela. `#models` lo abre directamente.
- El editor reconoce `/omi`, `/model`, `/omi-model`, `/omi-context`, `/omi-workspace`, `/omi-resources`, `/omi-chat`, `/omi-issues`, `/omi-prs`, `/omi-changes` y `/omi-platform` **sólo dentro de la maqueta**.

Un navegador o macOS pueden reservar atajos antes de entregarlos al HTML. Todas las acciones tienen una alternativa por clic; el prototipo no modifica las preferencias del navegador, Herdr ni el sistema.

## Qué sigue siendo una aproximación

Esto **no es un emulador VT ni un screenshot del runtime**. La fuente real, la representación de ciertos caracteres Unicode y los colores finales dependen del terminal. El input del HTML no pretende reproducir toda la edición multilínea, selección, pegado ni autocompletado de Pi. Tampoco prueba streaming real, accesibilidad del terminal ni el manejo de sesiones.

La TUI ya incorpora bienvenida, ocultación de la lista de componentes internos de OMI y del aviso de actualizar Pi por separado, lateral de 33 columnas, contexto encima de Equipo, modelo en fila propia y medidores `█`. Se conservaron el chat, las herramientas, los diagnósticos y las extensiones externas. El editor continúa siendo el de Pi: crece con texto multilínea y autocompletado; los diálogos también conservan sus componentes nativos, no el HTML.

Se comprobaron capturas de Inicio en un PTY real a 132 × 40, 110 × 26 y 80 × 24, además de tests de geometría con el renderer real. Esto no sustituye la revisión visual en Herdr en el Mac: hay que comparar el mismo estado y número de columnas y filas. La grilla hace que las proporciones sean reproducibles; los tests funcionales no garantizan paridad visual.

Todos los datos de Git, issues, PRs, versiones, modelos, capacidades, contexto y recursos son **simulados**. Los diffs y descripciones son extractos inventados. Nada envía mensajes, llama a un modelo, ejecuta comandos, modifica el repo, crea worktrees, consulta servicios ni despliega.
