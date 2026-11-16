# Coding policies — omi-code

Copia de las secciones Clean Code y TypeScript de las coding policies de `chichex/omi` (baseline `clean-code@2026-09-14`, `typescript@2026-09-14`). Se copian porque el origen vive en `.chiche/` de ese repo y esa ruta se va a retirar. Las juzga la review: no tienen gate propio. Los ajustes de este proyecto, al final, mandan sobre el texto general.

## Clean Code y SOLID
<!-- coding-policies:baseline=clean-code; version=2026-09-14 -->

### Responsabilidad única y cohesión

- **MUST** Aplicar SRP haciendo que cada función, componente, clase o módulo tenga una sola razón principal para cambiar y responda a un actor o grupo estrechamente relacionado. Porqué: "hacer una sola cosa" sin nombrar quién pide el cambio confunde pasos de una misma responsabilidad con responsabilidades realmente distintas. Gate: `revisión de diseño` que pueda describir responsabilidad y actor en una oración
- **MUST** Mantener juntas las partes que cambian por la misma razón y separar las que cambian por razones distintas. Porqué: SRP busca alta cohesión y bajo acoplamiento, no la mayor cantidad posible de archivos o funciones. Gate: `revisión del diff` y del historial de cambios relacionados
- **MUST** Separar decisiones de dominio, presentación, persistencia e integración cuando tengan actores, ritmos de cambio o contratos distintos; una función de orquestación puede coordinarlas sin implementar todas sus políticas. Porqué: coordinar colaboradores es una responsabilidad válida, mientras absorber sus detalles crea una unidad con múltiples motivos de cambio. Gate: `tests de contratos` en las fronteras identificadas
- **SHOULD** Usar cambios históricos, vocabulario, setup de tests y dependencias como evidencia de responsabilidades mezcladas antes de extraer. Porqué: una división fundada en señales reales conserva mejor la cohesión que una basada únicamente en la forma actual del código. Gate: `git log -- <archivo>` más revisión de imports y fixtures

### Tamaño como señal, no como objetivo

- **MUST** Tratar líneas, complejidad, anidamiento y cantidad de parámetros como detectores de humo, nunca como prueba suficiente de buen o mal diseño. Porqué: una unidad corta puede mezclar responsabilidades y una unidad larga puede ser una tabla declarativa perfectamente cohesionada. Gate: `revisión de responsabilidad y cohesión` junto con las métricas
- **MUST** Medir líneas lógicas con una convención estable que excluya líneas vacías y comentarios, y distinguir código ejecutable de datos o markup declarativo. Porqué: cambiar la forma de contar vuelve incomparables los umbrales y penaliza documentación o formato sin reducir complejidad. Gate: configuración versionada de `ESLint`, `detekt`, `golangci-lint` o herramienta equivalente ya adoptada
- **SHOULD** Considerar hasta 40 líneas lógicas como zona saludable habitual para una función, método o lógica ejecutable de un componente, sin exigir que toda unidad llegue a ese tamaño. Porqué: coincide con el punto de revisión de guías conservadoras y mantiene visible la intención sin promover microfunciones. Gate: `max-lines-per-function`, `LongMethod` o `funlen` configurado como advertencia
- **SHOULD** Tratar entre 41 y 60 líneas lógicas como señal de revisión, no como infracción automática. Porqué: ese rango coincide con defaults comunes de linters, pero todavía puede representar un algoritmo o flujo cohesivo cuya fragmentación empeore la lectura. Gate: `review del PR` asistido por la métrica del stack

### Funciones y métodos

- **MUST** Cuando una función, método o lógica ejecutable de componente tenga más de 60 líneas lógicas, evaluar su responsabilidad, complejidad y posibilidades de extracción; dividirla o documentar por qué mantener cohesión y localidad resulta más claro. Porqué: superar el rango usado por varios linters merece una decisión explícita, no un rechazo mecánico. Gate: `ESLint max-lines-per-function`, `detekt LongMethod` o `golangci-lint funlen` más justificación en el review
- **MUST** Mantener cada función en un nivel de abstracción reconocible y darle un nombre que exprese intención, sin mezclar orquestación de alto nivel con detalles incidentales extensos. Porqué: el lector debe entender primero qué ocurre y profundizar solo donde necesite saber cómo. Gate: `revisión de nombres y flujo` del caller y la función
- **SHOULD** Mantener la complejidad ciclomática en 10 o menos, tratar de 11 a 15 como señal y exigir revisión explícita por encima de 15, eligiendo guard clauses, tablas o extracción solo cuando aclaren el contrato. Porqué: más caminos independientes aumentan combinaciones y costo de prueba, pero reducir el número sin mejorar el modelo solo desplaza la complejidad. Gate: `ESLint complexity`, `detekt CyclomaticComplexMethod` o `golangci-lint cyclop`
- **SHOULD** Mantener el anidamiento en profundidad 3 o menos, tratar profundidad 4 como señal y revisar obligatoriamente cuando supere 4. Porqué: cada nivel agrega contexto simultáneo, aunque extraer bloques triviales puede ocultar el flujo en vez de simplificarlo. Gate: `ESLint max-depth`, `detekt NestedBlockDepth` o equivalente del stack
- **SHOULD** Preferir hasta 3 parámetros, tratar de 4 a 5 como señal y revisar más de 5, sin reemplazarlos mecánicamente por un objeto bolsa con campos no relacionados. Porqué: muchos parámetros suelen revelar responsabilidades o conceptos ausentes, pero agruparlos sin cohesión solo esconde la misma complejidad. Gate: `ESLint max-params`, `detekt LongParameterList` o revisión equivalente

### Componentes y UI

- **MUST** Dar a cada componente una responsabilidad de interfaz identificable y separar regiones que tengan estado, efectos, permisos, ciclos de carga o actores independientes. Porqué: un componente deja de ser cohesivo cuando cambios visuales sin relación pueden romper flujos y dependencias ajenos. Gate: `tests de componente` y revisión del ownership de estado y efectos
- **MUST** Aplicar los umbrales de función a la lógica ejecutable del componente, pero no usar la cantidad de JSX, Compose o markup declarativo como motivo único de extracción. Porqué: el markup puede ser largo y lineal sin agregar caminos ni responsabilidades, mientras pocas líneas con varios efectos pueden ser complejas. Gate: `revisión separada de lógica y markup` más linter del stack
- **SHOULD** Extraer un subcomponente cuando represente una región con nombre de dominio, semántica accesible, contrato de props, comportamiento testeable o reutilización real. Porqué: esas fronteras permiten razonar en aislamiento; cortar fragmentos arbitrarios solo agrega navegación y props. Gate: `tests por comportamiento` y revisión del árbol de componentes
- **MUST** Crear un custom Hook, presenter o componente auxiliar solo cuando encapsule una responsabilidad cohesiva; no mover líneas a un wrapper pasante para cumplir una métrica. Porqué: trasladar código sin reducir conocimiento compartido conserva la complejidad y suma una indirección. Gate: `review del contrato extraído` y de sus dependencias

### Archivos, clases y módulos

- **SHOULD** Considerar hasta 300 líneas lógicas como zona saludable habitual para archivos, clases o módulos escritos a mano. Porqué: coincide con un default extendido de lint y deja espacio para una unidad completa sin convertir cada concepto pequeño en un archivo. Gate: `ESLint max-lines`, `detekt LargeClass` o contador equivalente configurado como advertencia
- **SHOULD** Tratar entre 301 y 600 líneas lógicas como señal para revisar cohesión, superficie pública, dependencias y frecuencia de cambios, no como orden automática de dividir. Porqué: el tamaño intermedio puede indicar responsabilidades acumuladas o simplemente código declarativo que gana claridad al permanecer junto. Gate: `review del PR` con métrica y mapa de exports
- **MUST** Ante más de 600 líneas lógicas escritas a mano, tomar una decisión explícita de descomposición o justificar por qué una unidad cohesionada es más segura; código generado y grandes tablas declarativas se evalúan por su fuente y contrato. Porqué: a esa escala la navegación y el riesgo de mezclar cambios ameritan evidencia, pero una partición artificial también tiene costo. Gate: `revisión de arquitectura` registrada en el PR o excepción versionada del linter
- **MUST** Dividir un archivo o módulo cuando su API pública agrupe conceptos sin relación o cuando cambios de actores distintos lo modifiquen repetidamente, aunque todavía esté debajo del umbral de líneas. Porqué: SRP es una regla de cambio y cohesión, no una recompensa por archivos cortos. Gate: `git log -- <archivo>` más revisión de exports y consumidores

### SOLID sin ceremonia

- **MUST** Aplicar SRP como criterio de cohesión y razón de cambio, no como mandato de que cada unidad ejecute un único paso técnico. Porqué: una operación de negocio puede requerir varios pasos coordinados y seguir respondiendo a un solo actor. Gate: `revisión de responsabilidad` con actor, contrato e invariantes
- **SHOULD** Aplicar OCP creando puntos de extensión solo cuando exista variación observada o exigida por el contrato. Porqué: diseñar para todas las variantes imaginables produce abstracciones especulativas más difíciles de cambiar que el código directo. Gate: `tests de variantes` existentes o requisito que justifique la extensión
- **SHOULD** Aplicar LSP exigiendo que toda implementación sustituible preserve precondiciones, resultados, invariantes, errores y efectos observables del contrato. Porqué: compartir una interfaz o herencia no garantiza que los consumidores puedan reemplazar una implementación sin sorpresas. Gate: `contract tests` ejecutados contra cada implementación
- **SHOULD** Aplicar ISP definiendo interfaces desde las necesidades de sus consumidores y separándolas cuando obliguen a depender de operaciones ajenas. Porqué: contratos amplios aumentan acoplamiento, pero interfaces de un solo método sin consumidores distintos pueden ser ceremonia. Gate: `revisión de consumidores` y fakes de tests
- **SHOULD** Aplicar DIP haciendo que la política de alto nivel dependa de contratos estables e inyectando I/O, tiempo, azar, red y persistencia en sus fronteras volátiles. Porqué: aislar detalles cambiantes mejora pruebas y reemplazo sin invertir cada dependencia interna. Gate: `tests deterministas` con adapters reales cubiertos en integración
- **SHOULD** Evitar una interfaz, factory o capa por cada clase cuando no exista sustitución, frontera volátil ni consumidor que la necesite. Porqué: SOLID reduce acoplamiento útil; aplicado como plantilla multiplica archivos y saltos sin proteger ningún cambio real. Gate: `review de abstracciones` que nombre al menos una variación o frontera concreta

### Extracción sin sobre-split

- **MUST** Nunca extraer una unidad solo para reducir LOC; la extracción debe revelar intención, aislar una responsabilidad, reducir complejidad o establecer un contrato útil. Porqué: satisfacer una cifra sin mejorar comprensión convierte una función larga en una cadena de saltos. Gate: `review del antes y después` con el beneficio nombrado
- **MUST** Dar a toda unidad extraída un nombre específico del dominio o de la intención y entradas, salidas y efectos acotados. Porqué: nombres como `handlePart`, `processData` o `helper` desplazan líneas pero no explican responsabilidades. Gate: `revisión de nombres y firma` más tests del contrato
- **MUST** Preservar localidad cuando varios pasos comparten una invariante, orden o estado y se entienden mejor de forma secuencial. Porqué: dispersar un flujo cohesivo entre muchos archivos obliga al lector a reconstruir contexto sin reducir el conocimiento necesario. Gate: `review de navegación` desde el entry point hasta el resultado
- **SHOULD** Evitar wrappers pasantes, microarchivos y cadenas de funciones de una sola llamada salvo que marquen una frontera estable, mejoren el lenguaje o habiliten sustitución y tests. Porqué: cada indirección tiene costo cognitivo y debe comprar una separación verificable. Gate: `grafo de llamadas` o revisión de callers y contratos

### Adopción y excepciones

- **MUST** Respetar los límites y herramientas que el repositorio ya adoptó y no reconfigurarlos incidentalmente para cerrar una tarea. Porqué: los umbrales son una decisión de equipo y cambiarlos mezcla política global con comportamiento funcional. Gate: `git diff` de configuración de lint y CI
- **SHOULD** En proyectos sin métricas, introducir estos umbrales primero como warnings o revisión sobre código nuevo y endurecerlos solo con una baseline y acuerdo explícitos. Porqué: activar errores globales de una vez genera churn y refactors masivos sin relación con el cambio. Gate: `CI` con baseline o ratchet de archivos modificados
- **MUST** Acotar excepciones de tamaño a código generado, migraciones, fixtures o snapshots extensos, tablas declarativas y adapters mecánicos cuando dividirlos empeore trazabilidad; los tests no quedan exentos por categoría. Porqué: una excepción basada en naturaleza del contenido es revisable, mientras excluir carpetas enteras oculta lógica compleja. Gate: ignore específico en `ESLint`, `detekt`, `golangci-lint` o herramienta equivalente con motivo
- **MUST** Documentar toda supresión con alcance mínimo y razón concreta, y volver a evaluarla cuando cambie la responsabilidad de la unidad. Porqué: una excepción silenciosa se convierte en permiso permanente para acumular complejidad. Gate: `review de suppressions` y configuración versionada

### Lectura ampliada

- [Google C++ Style Guide: Write Short Functions](https://google.github.io/styleguide/cppguide.html#Write_Short_Functions) — recomienda funciones pequeñas y enfocadas, pero rechaza un límite duro y pide no dañar la estructura al dividir.
- [ESLint: max-lines-per-function](https://eslint.org/docs/latest/rules/max-lines-per-function) — regla configurable con default de 50 líneas por función.
- [ESLint: max-lines](https://eslint.org/docs/latest/rules/max-lines) — regla configurable con default de 300 líneas por archivo.
- [ESLint: complexity](https://eslint.org/docs/latest/rules/complexity) — medición configurable de complejidad ciclomática.
- [ESLint: max-depth](https://eslint.org/docs/latest/rules/max-depth) — profundidad máxima configurable, con default 4.
- [ESLint: max-params](https://eslint.org/docs/latest/rules/max-params) — cantidad máxima configurable, con default 3.
- [Detekt: Complexity Rule Set](https://detekt.dev/docs/rules/complexity/) — defaults para métodos largos, clases grandes, parámetros y complejidad en Kotlin.
- [golangci-lint: configuración de linters](https://golangci-lint.run/docs/linters/configuration/#funlen) — defaults de `funlen` y `cyclop` para Go.
- [React: Thinking in React](https://react.dev/learn/thinking-in-react) — separación de componentes por responsabilidad y crecimiento.
- [Martin Fowler: Function Length](https://martinfowler.com/bliki/FunctionLength.html) — extracción guiada por intención frente a implementación, no por una cifra aislada.
- [Refactoring: Extract Function](https://refactoring.com/catalog/extractFunction.html) — mecánica y motivación de una extracción con nombre significativo.
- [Robert C. Martin: The Single Responsibility Principle](https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html) — razón de cambio, actores, cohesión y separación de responsabilidades.
- [Robert C. Martin: SOLID Relevance](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) — alcance de los cinco principios y su aplicación a diseño y arquitectura.

## TypeScript
<!-- coding-policies:stack=typescript; version=2026-09-14 -->

### Alcance y configuración

- **MUST** Antes de editar, identificar la versión de TypeScript, el gestor y lockfile, los `tsconfig` efectivos, la configuración de lint, los scripts de CI, el runtime de producción y el pipeline de compilación. Porqué: la sintaxis válida y el significado de módulos, paths y emisión dependen del entorno real, no de la versión más nueva de la documentación. Gate: —
- **MUST** Respetar los scripts y convenciones existentes; una corrección acotada no migra módulos, dependencias, formatter, linter ni arquitectura como efecto incidental. Porqué: mezclar una migración con un cambio funcional amplía el riesgo y vuelve ambiguo cualquier fallo. Gate: `git diff -- package.json '*lock*' 'tsconfig*.json'`
- **MUST** Consultar documentación compatible con las versiones instaladas antes de adoptar una API, opción de compilador o preset de lint. Porqué: las páginas vivas pueden documentar capacidades o defaults que el proyecto todavía no tiene. Gate: —
- **MUST** Conservar las comprobaciones existentes y corregir sus errores; no desactivar `strict`, una regla type-aware ni una opción adicional para cerrar la tarea. Porqué: bajar el nivel de verificación convierte el error visible en riesgo silencioso para todo el proyecto. Gate: `tsc --showConfig -p <tsconfig>`
- **SHOULD** En proyectos nuevos, declarar `strict: true` aunque la versión instalada ya lo active por defecto. Porqué: explicita la intención y evita que el contrato dependa de un default histórico del compilador. Gate: `tsc --showConfig -p <tsconfig>`
- **SHOULD** En proyectos nuevos, evaluar y decidir explícitamente `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` y `noFallthroughCasesInSwitch`; en proyectos existentes, incorporarlos solo mediante un cambio acotado. Porqué: cubren ausencias y contratos que `strict` no modela por completo, pero habilitarlos incidentalmente puede exigir una migración amplia. Gate: `tsc --showConfig -p <tsconfig>`
- **MUST** Ejecutar el typecheck con el proyecto correcto; no pasar archivos sueltos a `tsc` cuando hay un `tsconfig`, y respetar el flujo de project references si existe. Porqué: invocar el compilador fuera del proyecto puede ignorar opciones y producir una señal falsa. Gate: `tsc --noEmit -p <tsconfig>` o el script de typecheck del repo

### Tipos e inferencia

- **SHOULD** Usar inferencia para valores locales obvios y explicitar contratos exportados o fronteras cuando mejore la revisión. Porqué: repetir tipos locales agrega ruido, mientras una API explícita comunica qué estabilidad promete. Gate: `tsc --noEmit -p <tsconfig>`
- **MUST** No usar `as T`, `!` ni una anotación para inventar garantías sobre JSON, red o valores posiblemente ausentes; demostrar el narrowing o validar en runtime. Porqué: las assertions desaparecen al ejecutar y pueden ocultar exactamente el caso que el tipo advertía. Gate: `typescript-eslint` (`no-non-null-assertion` y reglas `no-unsafe-*`)
- **MUST** Representar valores desconocidos con `unknown` y reducirlos antes de operar; no abrir el contrato con `any`. Porqué: `unknown` conserva la obligación de comprobar el valor, mientras `any` propaga operaciones sin verificar. Gate: `typescript-eslint` (`no-explicit-any`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return`)
- **MUST** Si una integración obliga a usar `any`, aislarlo en la frontera mínima y explicar por qué es inevitable; nunca encubrirlo con `as unknown as T`. Porqué: un escape localizado limita la pérdida de seguridad y deja visible la deuda. Gate: `typescript-eslint` (`no-explicit-any`) y revisión de `as unknown as`
- **SHOULD** Elegir `type` o `interface` por sus necesidades de composición y declaration merging, sin conversiones masivas de estilo. Porqué: ambas construcciones son válidas y una preferencia cosmética no justifica churn ni riesgo. Gate: —

### Modelado y narrowing

- **MUST** Modelar estados con datos distintos como uniones discriminadas en vez de grupos de propiedades opcionales independientes. Porqué: el tipo debe permitir solo combinaciones válidas y llevar los datos propios de cada variante. Gate: `tsc --noEmit -p <tsconfig>`
- **MUST** Reducir tipos mediante comprobaciones reales; todo type predicate manual debe implementar y testear la validación que declara. Porqué: la firma de un predicate puede mentirle al compilador aunque su cuerpo acepte valores inválidos. Gate: `tsc --noEmit -p <tsconfig>` y tests del predicate
- **MUST** Tratar las variantes cerradas de forma exhaustiva con `never` o lint; no esconder casos nuevos detrás de un `default` genérico salvo fallback defensivo exigido por datos de runtime. Porqué: agregar una variante debe señalar cada lugar que necesita una decisión. Gate: `typescript-eslint` (`switch-exhaustiveness-check`)
- **SHOULD** Usar `satisfies` para comprobar mapas de configuración y registros conservando sus literales específicos cuando esa inferencia sea útil. Porqué: valida el contrato sin ensanchar innecesariamente el valor como puede hacerlo una anotación. Gate: `tsc --noEmit -p <tsconfig>`

### Genéricos y APIs

- **MUST** Agregar un genérico solo cuando exprese una relación útil entre dos o más posiciones del contrato; evitar parámetros que aparecen una sola vez o no restringen nada. Porqué: un genérico sin relación agrega abstracción sin aportar información al caller. Gate: `typescript-eslint` (`no-unnecessary-type-parameters`)
- **SHOULD** Preferir una unión a overloads cuando ambas expresen el mismo contrato, y evitar restricciones genéricas más fuertes de lo necesario. Porqué: la firma más simple tiene menos casos divergentes entre declaración e implementación. Gate: `typescript-eslint` (`unified-signatures`)
- **MUST** Conservar en el tipo la relación real entre entrada y salida cuando el API la promete; no devolver un union amplio que obligue al caller a reconstruir una correlación conocida. Porqué: perder esa relación desplaza assertions y branches inseguros a todos los consumidores. Gate: `tsc --noEmit -p <tsconfig>`

### Límites y validación

- **MUST** Validar entradas externas relevantes al cruzar el límite del sistema y usar desde allí el valor validado. Porqué: una interfaz TypeScript no comprueba JSON, variables de entorno, storage ni respuestas de red en runtime. Gate: `runner de tests del repo` con entradas válidas e inválidas
- **MUST** Reutilizar el validador ya adoptado por el proyecto; la necesidad de validar no autoriza instalar Zod u otra dependencia por sí sola. Porqué: duplicar mecanismos aumenta bundle, mantenimiento y semánticas de error. Gate: `git diff -- package.json '*lock*'`
- **SHOULD** Derivar tipos desde el esquema cuando la librería lo soporte y distinguir input de output si hay coerciones o transformaciones. Porqué: un contrato duplicado puede driftear y una transformación hace que el tipo recibido no sea el tipo producido. Gate: `tsc --noEmit -p <tsconfig>`
- **MUST** Elegir deliberadamente qué hacer con campos desconocidos y revisar la semántica de toda coerción; no asumir que strings como `"false"` se convierten según intención humana. Porqué: strip, rechazo, passthrough y coerción cambian el contrato y pueden aceptar datos inesperados. Gate: `runner de tests del repo` con campos extra y coerciones

### Promesas y concurrencia

- **MUST** Toda promesa se espera, se retorna al caller o maneja explícitamente su rechazo. Porqué: una promesa flotante pierde errores y puede dejar efectos incompletos fuera del flujo observable. Gate: `typescript-eslint` (`no-floating-promises`)
- **MUST** No considerar `void tarea()` como manejo de errores; si se desprende trabajo, definir dónde se observa y trata el rechazo. Porqué: `void` puede silenciar al linter pero no cambia la semántica de la promesa. Gate: `typescript-eslint` (`no-floating-promises`) con `ignoreVoid: false`, o revisión equivalente
- **MUST** No pasar callbacks `async` a APIs que ignoran su promesa, como `forEach`; usar un loop secuencial o una agregación de promesas según la semántica. Porqué: el caller no espera esos callbacks y sus fallos quedan desacoplados. Gate: `typescript-eslint` (`no-misused-promises`)
- **MUST** Elegir conscientemente entre ejecución secuencial y concurrente, preservar el orden cuando importe y limitar fan-out contra servicios externos. Porqué: `Promise.all` sin criterio puede romper dependencias, saturar recursos o cambiar el comportamiento observable. Gate: `runner de tests del repo` con orden, fallo parcial y límite de concurrencia

### Módulos y runtime

- **MUST** Alinear `module`, `moduleResolution`, `package.json`, extensiones e imports con quien ejecuta o bundlea el JavaScript final. Porqué: que el dev server resuelva un import no demuestra que Node, el bundler o los consumidores de una librería puedan hacerlo. Gate: `tsc` más build o ejecución del artefacto de producción
- **SHOULD** Usar `import type` para dependencias que solo existen en el sistema de tipos, respetando el pipeline y `verbatimModuleSyntax` del proyecto. Porqué: hace explícita la frontera de runtime y evita emisiones o imports ambiguos. Gate: `typescript-eslint` (`consistent-type-imports`) o `tsc --noEmit -p <tsconfig>`
- **SHOULD** Separar `tsconfig` cuando servidor, navegador, workers y tests necesiten globals o emisión distintos. Porqué: una configuración única demasiado amplia permite APIs que no existen en alguno de los runtimes. Gate: `tsc -b` o scripts de typecheck por entorno
- **MUST** Si Node ejecuta TypeScript nativo, mantener un typecheck independiente y no asumir que el type stripping aplica aliases de `paths` ni transformaciones. Porqué: la ejecución nativa borra tipos pero no usa el `tsconfig` para comprobarlos o resolverlos. Gate: `tsc --noEmit -p <tsconfig>` y ejecución con la versión real de Node

### Linting y supresiones

- **SHOULD** Si el repo usa ESLint, partir de `recommendedTypeChecked` y configurar obtención de tipos con `projectService: true` cuando las versiones instaladas lo soporten. Porqué: las reglas type-aware detectan propagación insegura que el lint sintáctico no ve. Gate: `eslint .`
- **MUST** Adoptar `strictTypeChecked` solo deliberadamente y no habilitar el preset `all` automáticamente. Porqué: los presets opinados pueden cambiar fuera de una major y `all` introduce reglas sin una decisión de equipo. Gate: revisión de la configuración de `typescript-eslint` y `eslint .`
- **MUST** Corregir el problema antes de suprimirlo; una excepción usa `@ts-expect-error` con motivo concreto y alcance mínimo, nunca desactiva chequeos globales para cerrar la tarea. Porqué: `@ts-expect-error` falla cuando la excepción deja de ser necesaria y la explicación conserva el contexto. Gate: `typescript-eslint` (`ban-ts-comment`)
- **MUST** Verificar la matriz soportada de TypeScript, ESLint, parser y Node antes de actualizar cualquiera de ellos. Porqué: que el gestor resuelva versiones no significa que la combinación tenga soporte oficial. Gate: lockfile más documentación de compatibilidad de `typescript-eslint`

### Testing y verificación

- **MUST** Ejecutar los scripts pertinentes del repo para typecheck, lint, tests y build; si no hay typecheck y aplica, usar el compilador local con `--noEmit` y el `tsconfig` correcto. Porqué: cada gate cubre defectos distintos y una herramienta global puede no coincidir con el proyecto. Gate: scripts de CI del repo y `tsc --noEmit -p <tsconfig>`
- **MUST** Probar comportamiento observable y casos de error relevantes, especialmente validación, narrowing manual, cancelación y concurrencia cuando cambien. Porqué: que el código compile no demuestra que el contrato de runtime se cumpla. Gate: `runner de tests del repo`
- **MUST** Informar qué verificaciones se ejecutaron y cuáles no; no presentar un build sin typecheck ni una ejecución con type stripping como evidencia de tipos. Porqué: una señal mal etiquetada crea una confianza que la herramienta no produjo. Gate: `reporte final` con comando y resultado

### Rendimiento del tipado

- **SHOULD** Nombrar cálculos de tipos complejos reutilizados y preferir composición legible; evaluar `interface extends` frente a grandes intersecciones de objetos. Porqué: tipos anónimos e intersecciones profundas pueden repetir trabajo y empeorar diagnósticos. Gate: `tsc --noEmit -p <tsconfig>`
- **MUST** Medir antes de refactorizar por rendimiento del sistema de tipos. Porqué: sin diagnóstico se puede añadir complejidad sin atacar el cuello de botella real. Gate: `tsc --extendedDiagnostics -p <tsconfig>` o trace del compilador
- **MUST** No activar `skipLibCheck` automáticamente para ocultar conflictos entre dependencias; investigar el origen y documentar el compromiso si se adopta. Porqué: acelera el chequeo omitiendo errores en declaraciones y reduce la cobertura del compilador. Gate: `tsc --showConfig -p <tsconfig>` y typecheck con la decisión documentada

### Lectura ampliada

- [TypeScript: strict](https://www.typescriptlang.org/tsconfig/strict.html) — familia base de comprobaciones estrictas.
- [TypeScript: noUncheckedIndexedAccess](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html) — ausencia posible en accesos indexados.
- [TypeScript: exactOptionalPropertyTypes](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html) — diferencia entre propiedad ausente y `undefined` explícito.
- [TypeScript Handbook: Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html) — inferencia, annotations, unions y assertions.
- [TypeScript Handbook: Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html) — guards, predicates, uniones discriminadas y exhaustividad.
- [TypeScript Handbook: More on Functions](https://www.typescriptlang.org/docs/handbook/2/functions.html) — genéricos y overloads simples.
- [TypeScript: `satisfies`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator) — comprobación sin perder inferencia específica.
- [typescript-eslint: typed linting](https://typescript-eslint.io/getting-started/typed-linting/) — configuración de reglas con información de tipos.
- [typescript-eslint: shared configs](https://typescript-eslint.io/users/configs/) — alcance y estabilidad de los presets.
- [typescript-eslint: avoiding `any`](https://typescript-eslint.io/blog/avoiding-anys/) — reglas que limitan `any` explícito y propagado.
- [typescript-eslint: no-floating-promises](https://typescript-eslint.io/rules/no-floating-promises/) — promesas cuyo resultado no se observa.
- [typescript-eslint: no-misused-promises](https://typescript-eslint.io/rules/no-misused-promises/) — promesas en posiciones que esperan valores síncronos.
- [typescript-eslint: switch-exhaustiveness-check](https://typescript-eslint.io/rules/switch-exhaustiveness-check/) — exhaustividad type-aware.
- [TypeScript: choosing compiler options for modules](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html) — configuración según Node, bundler o librería.
- [TypeScript: verbatimModuleSyntax](https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html) — relación explícita entre imports y emisión.
- [Node.js: Modules TypeScript](https://nodejs.org/api/typescript.html) — capacidades y límites de ejecutar TypeScript nativo.
- [TypeScript: erasableSyntaxOnly](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html) — sintaxis compatible con borrado de tipos.
- [Zod: Basic usage](https://zod.dev/basics) — validación de entradas y derivación de tipos cuando el repo usa Zod.
- [TypeScript Performance](https://github.com/microsoft/TypeScript/wiki/Performance) — diagnóstico y diseño de tipos con mejor desempeño.
- [TypeScript: skipLibCheck](https://www.typescriptlang.org/tsconfig/skipLibCheck.html) — alcance y pérdida de cobertura de la opción.
- [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html) — cambios de defaults y deprecaciones que requieren revisar versiones.

## Ajustes de este proyecto

- Tamaño de archivo: el límite es 500 líneas por `.ts` que no sea de test (gate en `AGENTS.md`), no los 300 de `max-lines` que cita la sección general.
- `skipLibCheck: true` está documentado como decisión en `tsconfig.json` y en `AGENTS.md`.
- Los scripts de `package.json` son los comandos de verificación: no se agrega linter ni formatter como efecto de un cambio funcional.
