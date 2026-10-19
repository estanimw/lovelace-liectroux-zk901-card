# Plan de implementación — tarjeta ZK901 completa

Siguiente iteración propuesta: [recuperación del frontend comunitario](UI_REBASE_PLAN.md). Ese plan sustituye las decisiones de composición visual de este documento y conserva el backend de 0.4.0.

Fecha: 2026-10-18. Base del fork: `5b3dc1b`, rama `master`.

Ampliación 0.4.0 (2026-10-19): se añade captura autónoma e historial de trayectoria, fuera del alcance original sin recorrido. Implementación y límites en [DEVELOPMENT.md](DEVELOPMENT.md#captura-autónoma-de-trayectoria-040). La aceptación física de esta ampliación sigue pendiente.

Revisión posterior: paquete local 0.2.0 con recuperación tras recargar la integración y conservación de actualizaciones de catálogo durante el guardado. Pendiente de instalar y aceptar con el robot según la guía.

## Objetivo y alcance acordado

Esta iteración entrega una tarjeta funcional completa, su backend compatible y los archivos listos para instalar en el Home Assistant del propietario. No termina con una demo, botones sin conexión, edición sin guardado, configuración manual de coordenadas ni tareas de implementación trasladadas a otra entrega.

Decisiones confirmadas por el propietario:

- Mapa vectorial de **zonas y posición del robot**, sin recorrido.
- Controles: iniciar/continuar, pausar, detener, volver a la base, intensidad de limpieza y limpieza alrededor de la posición actual.
- Selección de **una o varias zonas persistidas para una única limpieza**.
- CRUD completo de zonas: crear, renombrar, cambiar tipo, editar geometría y eliminar.
- Uso diario y edición dentro de la misma tarjeta, con una experiencia adaptada a escritorio y móvil.
- Instalación manual desde archivos locales o assets propios de GitHub. Sin HACS.
- Desarrollo sobre `master`; conservar las entidades, configuración y credenciales de la integración actual.

La entrega no incluye adquisición LiDAR/cloud, trayectoria, reconstrucción de paredes, imágenes de referencia/calibración manual, limpieza por punto elegido arbitrariamente, rectángulos temporales de limpieza, control remoto, LED, sonido, horarios ni historial de sesiones. Son límites explícitos del producto de esta iteración, no funciones prometidas que puedan quedar incompletas. La limpieza localizada aquí significa `21020/3001` en la posición actual, no point/fixed-point ni Homepage Spot.

## Estado comprobado y dependencias

### Entorno objetivo

Consulta de solo lectura realizada el 2026-10-18:

- Home Assistant Container **2026.9.2**, Python **3.14.6**, arquitectura `aarch64`.
- Configuración de HA en `/config`; dashboards en modo storage.
- Entidad `vacuum.liectroux_zk901`, batería, selector y botón existentes.
- En `panel-general` conviven la tarjeta nativa de comandos y `custom:liectroux-zk901-zone-editor`.
- Comprobación adicional de solo lectura del HA conectado (2026-10-18): la entrada `liectroux_zk901` está cargada, pero el registro de servicios solo ofrece `clean_area` y el único recurso Liectroux es `/local/liectroux-zk901/liectroux-zk901-zone-editor.js?v=3`. El ZIP de esta iteración todavía no está instalado en esa instancia.
- La integración local tiene `manifest.json` con versión `0.1.0`; esto es la versión del código disponible en este workspace, no una afirmación de la versión de todos los archivos desplegados en HA.

Antes de implementar se contrastarán la versión instalada y la API disponible con las fuentes locales. Se preparará al inicio un entorno de pruebas compatible con HA 2026.9.2/Python 3.14. Una incompatibilidad de entorno se resuelve en ese momento con el propietario; no se deja para la entrega.

### Código reutilizable

El backend vive en este mismo repositorio, en `custom_components/liectroux_zk901/`, tras la migración acordada el 2026-10-18:

- `client.py`: conexión única, cola, codificación LAN, comandos y CRUD con revisión/verificación.
- `coordinator.py`: estado recibido, catálogo y disponibilidad compartidos.
- `vacuum.py`: servicios nativos y limpieza individual persistida.
- `zone_editor.py`: WebSocket `zone_editor/get` y `zone_editor/apply`, actualmente de administrador.
- `tests/test_zk901_client.py`: dispositivo simulado y pruebas sin hardware.

El fork aporta Lit, elementos con identidad propia, navegación del mapa y proceso de compilación. El editor vectorial existente aporta lógica y comportamiento de borrador/transformación a comparar y adaptar, sin copiar una segunda implementación de protocolo al navegador.

### Dos ampliaciones necesarias del backend

1. La API actual entrega la pose al consultar el catálogo; falta una suscripción para actualizarla en vivo sin repetir consultas completas de zonas.
2. El servicio actual acepta una sola zona; falta exponer y validar una lista de IDs que se envíe como un único comando.

Por eso la entrega será un **par compatible tarjeta + integración actualizada**, no únicamente un JS que dependa de cambios Python sin entregar.

## Experiencia final

### Uso diario

- Cabecera compacta con nombre, estado, disponibilidad y batería. No adivinar el entity ID del sensor: resolver la misma fuente de estado a través de la integración o el registro de HA.
- Plano vectorial con zonas etiquetadas y robot orientado. Se indica la antigüedad de la pose; datos antiguos no se presentan como posición actual fiable.
- Tipos diferenciados visualmente: normal, profunda y prohibida. No usar el color como único indicador.
- Selección múltiple por pulsación sobre polígonos y por lista accesible de nombres; lista/resumen de seleccionadas y acción para limpiar la selección.
- Una selección de N zonas genera un solo inicio espacial. No se promete un orden físico de navegación porque el orden de IDs no demuestra cómo planifica el firmware.
- Las zonas prohibidas se pueden inspeccionar y editar, pero no seleccionar para limpiar. IDs de sistema/no positivos y objetos no editables se preservan y no se convierten en destinos normales.
- Acciones de limpieza total y de selección diferenciadas. Cuando está pausada, el control principal indica continuar la sesión; no reutilizar ese botón para iniciar silenciosamente una selección nueva.
- Ajuste de intensidad `quiet/auto/strong`; presentación como aspiración o agua según el `mop` observado. Si el tipo no está disponible, etiqueta neutral de intensidad. El estado seleccionado proviene de `workNoisy`, no de `windPower`.
- Confirmación de envío/ACK y estado observado separados: no anunciar tarea completada al aceptar un servicio.

### Edición de zonas

- Modo explícito **Editar zonas**; fuera de él una pulsación selecciona para limpiar, no mueve geometría.
- Una zona por borrador y por guardado, aunque la selección de limpieza sea múltiple.
- Crear un rectángulo inicial que se puede convertir en polígono; nombre y tipo; mover el polígono o vértices; añadir/quitar vértices; eliminar una zona.
- Guardar, descartar y deshacer; cambios locales claramente indicados. Arrastrar nunca escribe al robot.
- Panel lateral en escritorio y panel inferior/desplegable en móvil; controles accesibles mediante teclado y nombres comprensibles.
- Confirmación explícita de borrado antes de guardarlo. El servidor sigue siendo la autoridad de IDs, geometría y preservación de campos desconocidos.
- Si no hay zonas: la pose puede centrar el plano, pero no define el tamaño de la vivienda. Se ofrece una extensión/origen explícitos para dibujar la primera zona; no se inventa espacio navegable ni paredes.
- No limpiar usando geometría de un borrador: pedir guardar o descartar antes de ejecutar la selección afectada.
- Si cambia el catálogo externamente, no sobrescribir un borrador. Conservarlo para revisión y señalar el conflicto.
- Un resultado incierto bloquea el reenvío del borrador y permite releer. No hay rollback automático.

### Configuración y límites de presentación

Configuración mínima final:

```yaml
type: custom:liectroux-zk901-map-card
entity: vacuum.liectroux_zk901
```

`title` podrá ser opcional. No se exigen cámara, imagen, calibración ni lista manual de zonas. El selector visual de configuración y el catálogo de custom cards deben generar una configuración válida para nuestra integración.

Se conserva el aislamiento de elementos y eventos del fork. Se revisan los tamaños de tarjeta para dashboards Sections y masonry. La pose en vivo no reajusta el encuadre ni cancela un gesto; el ajuste automático sucede al cargar o por una acción explícita.

Las coordenadas permanecen en el sistema original del protocolo, con inversión Y solo al proyectar. La equivalencia exacta a milímetros sigue inferida; no introducir una escala física falsa. La geometría no representa LiDAR, paredes u obstáculos.

## Arquitectura y contrato

### Frontend

Separar responsabilidades en módulos pequeños, ajustando los nombres definitivos durante la implementación:

| Módulo | Responsabilidad |
|---|---|
| `src/data/zk901.ts` | Tipos, lectura/suscripción WebSocket y servicios HA; único acceso a datos desde los componentes. |
| Modelo de borrador | Operación create/update/delete, revisión base, cambios, deshacer y estados de conflicto/incertidumbre. |
| Modelo de geometría | Proyección reversible, selección y operaciones geométricas sin acceso a red. |
| Componente mapa | Capas de zonas/robot, pan/zoom y gestos de edición. |
| Controles y propiedades | Acciones diarias, multiselección y panel del borrador. |
| Tarjeta raíz | Configuración, composición, ciclo de vida y mensajes. |
| `src/editor.ts` | Selector de aspiradora y configuración visual simplificada. |

Reutilizar los componentes útiles del fork. Retirar el camino de presets/plataformas y los generadores heredados que queden sin consumidores; no mantener una segunda UI genérica oculta ni dos caminos de geometría activos.

### Lectura y actualización en vivo

Conservar `liectroux_zk901/zone_editor/get` para una lectura fresca y `zone_editor/apply` para la mutación. Añadir `liectroux_zk901/card/subscribe` autenticado, con entrada `entity_id`.

Contrato propuesto de la suscripción:

- `api_version`: versión del contrato de la tarjeta.
- `generation` y `sequence`: identificar el ciclo de carga y ordenar actualizaciones; no confundirlos con la revisión del catálogo.
- `available`, `observed_at` y antigüedad/origen de cada grupo de datos.
- Estado pequeño: batería, modo/submodo, nivel de limpieza, tipo de intensidad y error observado cuando estén disponibles.
- `pose`: posición, orientación y fecha, o `null`.
- Catálogo: `map_id`, `revision`, `areas`, fecha y condición de frescura de esa lectura.
- Capacidades de esta API, incluida multizona, para detectar una integración antigua antes de ofrecer funciones incompletas.

La suscripción usa el coordinador en memoria, no abre otro socket ni consulta `21004` por cada actualización de pose. Registrar el listener antes de enviar el snapshot inicial para no perder cambios; desuscribir al retirar la tarjeta/cerrar conexión y al descargar la entrada. Evitar mezclar respuestas de una entidad o generación anterior al cambiar la configuración.

La carga inicial obtiene un catálogo fresco; las actualizaciones posteriores comparten el coordinador y el sondeo de catálogo existente. **Recargar** provoca una lectura explícita. Mostrar el instante real de observación del catálogo, no sustituirlo por la hora de cualquier evento de pose. El backend tendrá que conservar esa fecha por separado.

Las actualizaciones recibidas no reemplazan el borrador local. Si cambia el catálogo mientras hay un borrador, presentar el conflicto y su catálogo actualizado por separado. Si cambia una zona seleccionada para limpiar —se elimina, pasa a prohibida o cambia de mapa— informar y exigir revisar la selección; no ejecutar silenciosamente un subconjunto.

La recuperación de conexión es de lectura/suscripción, nunca de reenvío de acciones. No crear intervalos ilimitados ni suscripciones duplicadas al reconectar, cambiar entidad o recargar la integración.

Se mantiene para el mapa/CRUD la política actual de administrador; no ampliar permisos incidentalmente. Si falta autorización, mostrar el motivo y no iniciar una lectura/escritura alternativa. Los servicios nativos siguen sometidos a los permisos de HA.

### Limpieza multizona

Añadir servicio propio `liectroux_zk901.clean_areas`, con target `vacuum` y `area_ids` como lista no vacía de enteros positivos, y método equivalente en el cliente. Conservar `clean_area`, selector y botón para compatibilidad; la operación individual puede delegar en la ruta común validada.

Toda la operación se ejecuta en un trabajo de la cola existente:

1. Consultar `21004` fresco.
2. Validar todos los IDs: no booleanos, duplicados, IDs de sistema, IDs ausentes/ambiguos ni zonas prohibidas/tipos no soportados. Rechazar la solicitud completa ante cualquier elemento inválido.
3. Construir un solo compuesto `30000`, con `21023` seguido de `21005`.
4. `21023`: `mapId` actual, `cleanId=[id1,id2,...,-3]`, `extraAreas=[]`.
5. `21005`: `mode="reAppointClean"`.
6. Comprobar el wrapper y ambos children. Refrescar/publicar el estado según el camino ya existente.

Conservar el orden de selección en el payload. No simular multizona con N servicios individuales ni con un planificador de tareas. Ajustar el presupuesto de timeout para que cubra consulta, ACK compuesto y tiempo en cola; una acción que termina sin respuesta no se reenvía automáticamente desde la UI.

Evidencia: la forma de `cleanId` para varias zonas está **CONFIRMADA POR DEX / SDK** en `../docs/ZK901_LOCAL_PROTOCOL.md`, sección «Selección de 21023». La ejecución física documentada corresponde a una sola zona. El funcionamiento multizona de este firmware debe validarse durante la iteración con el operador; no se promoverá a confirmado por pasar pruebas simuladas.

### Guardado de zonas

Reutilizar `apply_area_edit` y su secuencia `21004 → 21003 → 21023[-3] → 21004` en una sola tarea. Mantener revisión/hash y `map_id` base, campos desconocidos, IDs asignados por backend y comprobación final.

Mapear errores de transporte WebSocket y errores funcionales del resultado. Tratamiento explícito de `not_found`, falta de permisos, `unavailable`, `invalid_catalog`, `invalid`, `rejected`, `conflict`, `uncertain` y fallos inesperados. No presentar todos como desconexión ni asumir éxito por ausencia de excepción.

El frontend no debe agotar su espera antes que la transacción del backend. Una desconexión durante escritura se trata como resultado desconocido aunque el backend continúe; bloquear un segundo envío y recuperar mediante lectura. Si un ACK compuesto indica fallo parcial, mostrar el fallo y el estado real; no arrancar limpieza total como fallback ni ejecutar una compensación automática.

## Etapas de implementación y puertas de salida

| Etapa | Trabajo | Criterio para avanzar |
|---|---|---|
| 0. Preparación | Contrastar instalación/API; preparar entorno HA objetivo, fixtures sin secretos y forma de distribución del backend. | Versiones y contrato de compatibilidad definidos; no depende de instalar solo el JS contra una API incompleta. |
| 1. Backend | Snapshot/suscripción, fechas y disponibilidad; servicio multizona; compatibilidad individual y del editor actual. | Pruebas de API y cliente pasan, sin otro socket ni cambios de encoding; una selección múltiple produce un único compuesto. |
| 2. Tarjeta de uso diario | Configuración por entidad, mapa vectorial en vivo, multiselección, controles y mensajes. | Recorrido completo UI → API/servicio → respuesta observable en HA simulado; sin demos ni datos hardcodeados. |
| 3. Edición completa | Borrador, creación/polígonos, propiedades, eliminación, deshacer y guardado verificado. | Todos los flujos CRUD, conflicto y resultado incierto funcionan de extremo a extremo con el backend simulado. |
| 4. Verificación | Navegador, HA objetivo, carga/móvil/tema, permisos, reconexión y validación multizona coordinada. | No hay defectos conocidos que impidan las funciones acordadas; el resultado físico multizona se resuelve durante esta etapa. |
| 5. Empaquetado | Bundle, integración actualizada, versiones, hashes e instrucciones de instalación/prueba/rollback. | Archivos completos y compatibles listos para copiar; ninguna función del alcance requiere trabajo de programación adicional. |

Las etapas son hitos internos de una sola entrega completa. No se cierra la iteración al terminar la lectura o al tener una vista bonita con botones pendientes.

## Verificación obligatoria

### Cliente y API sin hardware

- Mantener todas las pruebas existentes de comandos y CRUD.
- Una y varias zonas: payload exacto, orden, `-3` final único y ningún envío cuando una selección es inválida.
- Catálogo fresco distinto al mostrado, zona eliminada/prohibida/duplicada, bool como ID, lista vacía y fallo parcial de `30000`.
- Suscripción: snapshot inicial, actualización de pose/zonas, timestamps independientes, disponibilidad, desuscripción, descarga/recarga y permisos.
- Aplicación: cada operación conserva campos ajenos y devuelve catálogo confirmado; conflicto no escribe; timeout después de escritura resulta incierto.
- Testear contra las APIs de HA 2026.9.2, además de pruebas puras. Evitar mocks que oculten una firma o esquema incompatible con la instalación real.

### Navegador y flujos de usuario

Con Playwright u otra herramienta ya disponible y datos simulados del backend:

- Configuración mínima, selector visual y previews; ausencia de imagen/cámara.
- Estado/batería/potencia; acciones correctas y pendientes bloqueadas para evitar doble envío.
- Seleccionar/deseleccionar varias zonas desde mapa y lista; ninguna acción accidental al hacer pan/zoom o abrir edición.
- Crear, mover, modificar vértices, renombrar, cambiar tipo, borrar, deshacer, descartar y guardar.
- Comprobar la secuencia UI → apply → catálogo confirmado → lista/mapa actualizados. No basta con interceptar una llamada y devolver éxito fijo.
- Catálogo vacío, pose ausente/antigua, geometría inválida, nombres repetidos, campos desconocidos y cambio de mapa.
- Conflicto, permisos, backend antiguo, respuesta perdida, desconexión y vuelta a conectar sin perder borradores ni reenviar comandos.
- Dos tarjetas y dos pestañas; eventos aislados; la segunda detecta el cambio persistido por la primera.
- Anchos de 360/390 px y escritorio, táctil, teclado y temas claro/oscuro. Revisar visualmente capturas.
- Convivencia con el editor anterior y la tarjeta nativa; salir/entrar de la vista no acumula listeners, consultas ni tareas.

### Validación con HA y operador

La validación se coordina con el propietario. El agente no elige zonas físicas, no lanza limpiezas, no modifica prohibiciones ni automatiza variantes por su cuenta.

Durante la implementación se consulta al propietario cuando se necesite una acción física concreta, en especial la validación de varias zonas. Se correlaciona la solicitud elegida con el ACK de cada child y el estado/resultado observado. La forma del payload por DEX no prueba por sí sola el comportamiento físico.

Si aparece una limitación real de firmware o un bloqueo que cambia el alcance, se consulta de inmediato y se acuerda una solución; no se sustituye por múltiples limpiezas ni se entrega la función marcada como futura. La lista de comprobación de instalación incluirá todos los controles y operaciones CRUD, para que el propietario pueda verificar la instalación final sin escribir scripts ni coordenadas.

## Entrega e instalación

### Artefactos de una misma entrega

- `liectroux-zk901-map-card.js` autocontenido, con versión visible.
- ZIP conjunto `liectroux-zk901-ha.zip`, con estructura `custom_components/liectroux_zk901/` y `www/liectroux-zk901/`, sin `.env`, identificadores ni credenciales.
- `SHA256SUMS` y manifest de compatibilidad con versiones de frontend, backend, API y HA verificado, más commits/huellas de las fuentes.
- Instrucciones de instalación, actualización, reversión y comprobación funcional completas; README final sin avisos de funciones incluidas todavía pendientes.
- Actualizar `INSTALLATION.md` y sustituir el ejemplo sintético `smoke_config.yaml` por la configuración real mínima; los datos simulados que sigan siendo útiles quedan en fixtures de pruebas, no en los pasos de instalación.

La integración Python y la tarjeta tienen una sola fuente canónica en este repositorio. `npm run package` compila el frontend y `scripts/package-release.py` genera el ZIP conjunto, manifest de compatibilidad y hashes usando únicamente archivos del checkout; no depende de una carpeta hermana. El manifest incluye versiones de frontend/backend, API, Home Assistant probado, commit, estado modificado y hashes de todos los archivos del ZIP.

Los workflows de build y release ejecutan pruebas Python, generan el paquete y ejecutan los flujos Playwright en Chromium. El workflow de build guarda artefactos y el workflow de release adjunta los archivos a una release publicada por el propietario. Crear una release o hacer push sigue siendo una acción separada. El paquete local basta para instalar y probar; no se ha instalado en Home Assistant como parte de esta implementación.

Las [alternativas de instalación](INSTALLATION_OPTIONS.md) describen un futuro instalador desde releases y un posible actualizador propio. Ninguno se implementa implícitamente al reorganizar el repositorio ni reemplaza la comprobación de compatibilidad del producto.

### Secuencia de instalación en HA Container

1. Conservar copia de la carpeta de integración anterior, el JS anterior y la configuración de tarjeta/recurso. No editar `.storage` directamente.
2. Reemplazar los archivos de `custom_components/liectroux_zk901/` por el paquete compatible y reiniciar HA para cargar Python. No borrar la entrada de configuración ni volver a provisionar el robot.
3. Copiar el bundle a `/config/www/liectroux-zk901/liectroux-zk901-map-card.js`.
4. Registrar/actualizar un único recurso module con versión en la URL y recargar el navegador.
5. Añadir la tarjeta por entidad en una vista de prueba; conservar inicialmente el editor anterior y los controles nativos.
6. Ejecutar la lista de verificación acordada con el operador.
7. Cuando se acepte el reemplazo, cambiar la tarjeta en `panel-general`. Retirar el recurso/archivo anteriores solo después de comprobar todas sus referencias. La limpieza no requiere eliminar entidades.

El frontend detectará API incompatible y explicará qué paquete actualizar. No usará datos de prueba ni se limitará silenciosamente a media funcionalidad.

## Estado de implementación — 2026-10-18

| Etapa | Estado en el checkout | Evidencia / límite |
|---|---|---|
| 0. Preparación | Implementada | Entorno de pruebas pinneado a Home Assistant 2026.9.2; integración y tarjeta comparten fuente en este repositorio; el paquete describe compatibilidad. |
| 1. Backend | Implementada y probada con HA real de CI | Coordinador compartido, timestamps separados, snapshot/refresh/suscripción y `clean_areas` con validación y un único compuesto; se conserva el servicio individual. No altera el encoding local. |
| 2. Tarjeta de uso diario | Implementada en la fuente | Configuración mínima por entidad, estado/pose/zonas, selección, controles y acciones cableadas a la integración. Recorrido del navegador verifica servicios y respuestas con backend stateful simulado. |
| 3. Edición completa | Implementada en la fuente | Crear, editar, mover, vértices, renombrar, tipo, eliminar, deshacer, descarte, persistencia, conflicto e incertidumbre cubiertos por los recorridos simulados. |
| 4. Verificación | Automatización implementada; aceptación en HA/robot pendiente | Hay pruebas de cliente, API en Home Assistant 2026.9.2, Chromium, permisos, reconexión, dos tarjetas/pestañas, anchos adaptables y paquete. El propietario aún debe instalar/aceptar en su HA y confirmar la conducta física multizona. |
| 5. Empaquetado | Implementada; artefactos locales generados y checksums verificados | Scripts producen ZIP, JS, manifest y checksums; guías de instalación, actualización, rollback y aceptación están listas. No se publicó ni instaló. |

La funcionalidad de software ya no queda trasladada a otra iteración. La evidencia simulada no confirma el firmware: la limpieza física de varias zonas sigue siendo una puerta de aceptación explícita. La edición guarda en el catálogo real, por lo que la lista de instalación pide conservar la recuperación antes de validar el flujo en HA.

## Definición de terminado

El trabajo de código y empaquetado está listo cuando:

- Todas las funciones de este alcance están implementadas y conectadas al backend; no hay botones decorativos ni TODOs funcionales.
- Configuración mínima por entidad, UI de configuración y actualización en vivo funcionan sin cámara/calibración.
- Multizona usa un solo comando validado; CRUD conserva su transacción y verificación.
- El operador valida en el robot la operación multizona y confirma cualquier incompatibilidad detectada; la evidencia se etiqueta con su nivel real.
- Pruebas apropiadas, build reproducible, revisión visual y compatibilidad HA objetivo están documentados.
- Backend y frontend compatibles están empaquetados, con archivos y pasos exactos de instalación, prueba y rollback.
- No cambian entidades ni credenciales, y la instalación anterior sigue siendo recuperable.

La aceptación física no puede inferirse desde este checkout. Hasta que se registre esa evidencia, el estado del protocolo multizona permanece **pendiente de validación física** aunque la implementación y el paquete estén listos. Esto no promete eliminar toda incertidumbre del firmware ni sustituye la aceptación del propietario en su instalación.

## Referencias

- [Instalación actual del fork](INSTALLATION.md).
- [Desarrollo y base existente](DEVELOPMENT.md).
- [Home Assistant: comandos y suscripciones WebSocket](https://contributors.home-assistant.io/frontend/extending/websocket-api/).
- [Home Assistant: custom cards](https://contributors.home-assistant.io/frontend/custom-ui/card/).
- [Home Assistant: actualización de datos/coordinadores](https://contributors.home-assistant.io/core/integrations/fetching-data/).
- Fuentes de protocolo locales: `../docs/ZK901_LOCAL_PROTOCOL.md` y `../docs/ZK901_RE_STATUS.md`, rutas relativas a la raíz del fork, en el workspace padre. No son archivos distribuidos por este repositorio.
