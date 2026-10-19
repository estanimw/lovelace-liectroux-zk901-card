# Plan de implementación — recuperar el frontend comunitario

Estado: implementación de software completada en 0.5.0. Ver [informe de procedencia y validación](UI_REBASE_REPORT.md). La aceptación visual en la instancia HA y las pruebas físicas las realiza el propietario después de actualizar.

Base de producto: versión 0.4.0, commit `ebdbda2e53bc2a07df8517b6793f2cd18e4718e7`.
Base comunitaria: commit `045c3ac946d4ef0a01201f306e9949643984a155`, anterior a las adaptaciones ZK901 y disponible en el historial del fork.
Versión de entrega: 0.5.0. Trabajo sobre `master`, conservando el historial.

Referencia: [Lovelace Xiaomi Vacuum Map Card](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card/tree/045c3ac946d4ef0a01201f306e9949643984a155).

## Objetivo

Recuperar como implementación real el componente principal, la composición visual y los componentes de interacción del proyecto comunitario. Adaptar su entrada de datos y sus acciones a la integración ZK901 existente. No desarrollar otra interfaz que solo copie sus colores o su apariencia.

El backend de 0.4.0 se conserva: conexión LAN, comandos, entidades, servicios, API WebSocket, catálogo, edición persistente, captura autónoma, almacenamiento, historial y actualizador. La entrega no cambia el protocolo ni intenta resolver el problema físico pendiente de limpieza por zonas.

## Restricciones

- Restaurar archivos concretos desde Git; no revertir globalmente el repositorio ni la integración.
- Mantener `custom:liectroux-zk901-map-card`, la entidad configurada, el recurso y la distribución conjunta existentes. No exigir reconfigurar HA ni crear otra integración.
- Mantener configuración mínima `type` + `entity`, con `title` opcional. La configuración interna del frontend original se genera automáticamente.
- No introducir cámara, calibración manual, nuevas entidades auxiliares ni servicios Python para alimentar el frontend.
- Conservar MIT, atribución y procedencia de los componentes recuperados.
- No habilitar funciones del original sin soporte confirmado: destino arbitrario, limpieza por punto elegido en el mapa, rectángulos temporales, ejecución de rutas dibujadas, repeticiones y otras plataformas.
- No borrar componentes originales para reducir el número de archivos. Recuperar sus dependencias reales; cualquier eliminación posterior debe estar justificada por ausencia de consumidores.
- No incorporar simultáneamente actualizaciones arbitrarias del upstream más reciente. La base fijada permite revisar qué cambios son nuestros; actualizaciones posteriores serán una tarea separada.

## Experiencia final

La vista normal conserva la jerarquía del original: mapa protagonista, navegación y bloqueo del mapa sobre el propio plano, controles compactos mediante iconos y valores de estado en tiles. Las zonas se seleccionan directamente sobre el mapa y se ejecutan con una acción explícita.

La intensidad y las acciones secundarias se presentan en los controles y menús siguiendo los componentes del original. Deben poder identificarse con etiquetas accesibles y ayudas, sin depender solo del color o de interpretar iconos.

La edición de zonas, las capas/historial y la información de diagnóstico se abren mediante acciones específicas. El uso diario no muestra simultáneamente formularios, listas extensas, detalles de API, versiones, timestamps técnicos ni párrafos explicativos. Los errores que requieren una decisión siguen siendo visibles.

El mapa conserva su contenido real disponible: cobertura estimada, recorrido, posición/orientación y zonas. La migración no añade paredes ni el raster LiDAR que aparece en algunas demostraciones comunitarias.

## Qué se recupera y qué se adapta

| Parte | Decisión |
| --- | --- |
| Componente principal y estructura visual | Recuperar el original y adaptar allí identidad, datos y acciones. No conservar como raíz el componente reescrito en 0.2.0. |
| Iconos, menús, tiles, acciones y estilos | Recuperar `src/components/`, estilos y utilidades que requieran. Mantener el comportamiento y la jerarquía visual originales. |
| Navegación del mapa | Recuperar `src/pinch-zoom/`, gestos, bloqueo, ajuste y controles originales; restaurar sus dependencias, incluido `pointer-tracker`. |
| Selección espacial | Recuperar `Room`, objetos base, contexto y transformación necesarios. Convertir nuestras zonas persistidas a sus polígonos seleccionables. |
| Datos y comandos ZK901 | Reutilizar `src/data/zk901.ts`, la API 1 y los servicios ya existentes mediante un adaptador frontend. |
| Edición persistente | Reutilizar `ZoneDraft`, validación e inversión de coordenadas actuales; integrarlas en un modo secundario, usando la navegación y el estilo recuperados. |
| Backend | Sin cambios funcionales. Solo se coordina la versión del manifest si se publica un nuevo paquete conjunto. |

Todos los elementos personalizados recuperados deben usar nombres internos propios del fork. Se probará la convivencia con la card comunitaria instalada: no registrar dos veces `pinch-zoom` ni otros nombres genéricos y no invadir estilos globales.

## Arquitectura frontend

### 1. Adaptador de la API existente

Una sola suscripción por instancia de card recibe los snapshots actuales. El adaptador traduce catálogo, estado, selección, pose y trayectoria al modelo que consume el frontend recuperado.

- Estado, batería e intensidad proceden del snapshot; no crear entidades ficticias en HA ni inferir IDs de sensores por sus nombres.
- Las zonas conservan sus IDs reales, etiquetas, geometría y modo. Las prohibidas y los objetos de sistema pueden representarse, pero no convertirse en destinos de limpieza.
- Los tiles y controles originales reciben los valores y acciones adaptados; solo extender sus entradas donde lo requieran los datos del snapshot.
- Mantener orden por generación/secuencia, reconexión, disponibilidad y conservación de snapshots recibidos durante un guardado.
- No añadir polling desde el navegador ni alterar el recolector autónomo de 20 segundos.

### 2. Superficie de mapa compatible con el original

El original combina una imagen con un SVG de selección y deriva el tamaño del mapa de esa imagen. Para conservar ese contenedor y sus gestos, generar una imagen SVG local a partir de nuestros datos y usarla como fuente interna del mapa.

- La imagen contiene cobertura, trayectoria y robot; los polígonos interactivos se dibujan en la capa de selección recuperada. Evitar dibujar dos veces las zonas.
- El SVG se genera en el navegador. No se publica una cámara ni se necesita un endpoint nuevo en HA.
- Definir un único marco de coordenadas y una transformación reversible entre protocolo y píxeles. Generar automáticamente los puntos de transformación que requiera el conversor original; no pedir calibración al propietario.
- Reutilizar esa transformación en selección y edición. Invertir Y una sola vez; probar la ida y vuelta con polígonos y poses conocidos.
- Mantener el marco estable durante actualizaciones de telemetría. Recargar la imagen no debe reiniciar zoom, paneo, selección ni un gesto en curso.
- Ajustar el encuadre al cargar/cambiar contexto o por acción explícita. Si hay datos fuera del encuadre, ofrecer ajustar sin mover inesperadamente el mapa.
- Regenerar contenido cuando cambien sus datos o el tema, no por cada timestamp o evento ajeno al mapa. Liberar recursos de imagen al sustituirlos y desconectar.
- Generar geometría a partir de números validados; los nombres de zonas se presentan mediante plantillas escapadas. No insertar etiquetas de usuario en cadenas SVG sin escapar.

Esta es la adaptación principal a demostrar primero: imagen dinámica, selección y gestos deben permanecer alineados bajo zoom, cambios de tamaño y refrescos.

### 3. Acciones compatibles con nuestro backend

- Los iconos de uso diario llaman a los servicios nativos ya usados: iniciar/continuar, pausa, detener, base, intensidad y limpieza de posición actual.
- El modo de zonas recupera multiselección y representación seleccionada del original; su ejecución llama una sola vez a `liectroux_zk901.clean_areas` con `area_ids`.
- Una pulsación sobre una zona solo selecciona; no inicia limpieza inmediatamente. No recuperar atajos del original que ejecuten acciones o publiquen configuración sin una intención explícita.
- Mantener solicitudes pendientes, errores y resultados inciertos sin reenvíos automáticos. Un ACK no se presenta como limpieza físicamente completada.
- Los modos no soportados no aparecen como opciones desactivadas ni como botones de demostración.

### 4. Edición y vistas secundarias

El CRUD persistente no equivale a dibujar una zona temporal de limpieza del original. Conservar esa distinción.

- Una acción de edición abre un panel secundario adaptable y activa los controles de borrador sobre el mapa original.
- Conservar crear, renombrar, tipo, mover, ajustar/añadir/quitar vértices, deshacer, descartar, guardar y eliminar con confirmación.
- Arrastrar modifica únicamente el borrador. El guardado utiliza la API actual con mapa y revisión base.
- Conservar conflictos externos, geometrías no editables, campos opacos y guardados inciertos. No perder un borrador al cerrar accidentalmente un panel o cambiar de contexto sin una decisión explícita.
- Mientras se edita, separar claramente arrastrar vértices de desplazar/zoom del plano. Probar ratón, pantalla táctil y teclado.
- Un menú de capas/historial ofrece recorrido, cobertura, actividad elegida y reconstrucción acumulada. Reiniciar la reconstrucción conserva la confirmación y llama a la API existente.
- Detalles de captura, antigüedad, huecos y versiones quedan en una vista de información; una desconexión o un error de guardado relevante sigue teniendo aviso directo.

## Etapas y criterios de salida

### Etapa 1 — restaurar la base y comprobar la apariencia

1. Inventariar los componentes y dependencias originales y registrar sus hashes/commit de procedencia.
2. Restaurar el componente raíz y su grafo de componentes, estilos, interacciones y traducciones necesarios. Aplicar identidad ZK901 y prevenir colisiones de elementos.
3. Montar una preview local con datos simulados, sin red hacia el robot, que permita comparar el original y la adaptación usando el mismo contenido de mapa.
4. Producir capturas comparables en escritorio y móvil, temas claro/oscuro y estados normal/selección.

**Salida:** estructura y controles reconocibles como la card comunitaria funcionando realmente con sus componentes. Revisar la comparación visual antes de añadir los paneles secundarios. Un conjunto de tests aprobados no sustituye esta revisión.

### Etapa 2 — conectar mapa y uso diario

1. Conectar snapshots y generación SVG a la raíz recuperada.
2. Integrar pose, cobertura, recorridos, zonas y multiselección.
3. Conectar iconos y tiles al adaptador ZK901.
4. Verificar estabilidad de coordenadas, gestos y encuadre durante actualizaciones, reconexiones y cambios de contexto.

**Salida:** uso diario completo con el backend existente, configuración mínima y sin polling de trayectoria en la card.

### Etapa 3 — recuperar todas las funciones secundarias

1. Integrar el editor persistente en el panel secundario.
2. Integrar selector de actividad, capas, información y reinicio de reconstrucción.
3. Conservar accesibilidad, permisos y manejo de conflictos, borradores y resultados inciertos.

**Salida:** ninguna función soportada de 0.4.0 se pierde; la vista normal permanece compacta.

### Etapa 4 — comprobar regresiones y diferencias frente al original

- Mantener las pruebas de contratos y backend existentes. Añadir pruebas para el adaptador y la transformación reversible.
- Adaptar los flujos de navegador al diseño recuperado, conservando sus verificaciones de comportamiento; no eliminarlas para hacer pasar el nuevo diseño.
- Probar móvil desde 360 px, escritorio, tacto, rueda, pellizco, bloqueo del mapa, ajuste, teclado, etiquetas y temas.
- Probar actualizaciones de trayectoria durante zoom/edición, catálogo vacío, datos antiguos, desconexión, cambio de mapa, dos cards y convivencia con el original.
- Verificar cobertura/historial cerca de los límites que entrega 0.4.0: no regenerar imágenes por eventos irrelevantes ni acumular URLs, listeners o suscripciones.
- Comparar capturas con la referencia comunitaria. Documentar las diferencias visibles que quedan y la función ZK901 que las necesita.
- Revisar el diff respecto de la raíz original: cada modificación debe corresponder a identidad, datos, acciones, mapa generado, edición persistente o corrección de compatibilidad demostrada.
- Comparar Python contra `ebdbda2`: no aceptar cambios funcionales en backend como parte de esta migración.

**Salida:** pruebas automáticas, revisión visual y trazabilidad del código reutilizado completas. El componente reescrito de 0.2.0 deja de ser el camino activo; no se mantienen dos interfaces de producción.

### Etapa 5 — empaquetar y entregar

1. Actualizar documentación y versión conjunta propuesta 0.5.0. La versión Python cambia solo como identificación del paquete emparejado.
2. Generar ZIP y manifest con el empaquetador actual, comprobar compatibilidad con el actualizador instalado y verificar artefactos de release.
3. Mantener el mismo recurso y configuración de card. Actualizar por el mecanismo ya existente, sin reinstalar ni volver a vincular la aspiradora.
4. Tras instalar, comprobar visualización, navegación y selección sin movimiento. Las pruebas que mueven el robot las realiza el propietario cuando lo decida.
5. La limpieza completa y el diagnóstico físico pendiente de las zonas siguen siendo validaciones separadas; la renovación del frontend no se presenta como una solución a ese comportamiento del firmware.

## Definición de terminado

- La composición y los componentes comunitarios son la base del frontend entregado, con procedencia verificable.
- El mapa y los controles cotidianos tienen prioridad visual; edición, historial y diagnóstico son secundarios y accesibles.
- Todas las funciones soportadas de 0.4.0 siguen conectadas al backend existente.
- Se mantienen identidad, configuración, entidades, credenciales, almacenamiento de trayectorias y actualizador.
- El contenido del mapa corresponde a la telemetría disponible, sin promesas de paredes o de mapa LiDAR.
- El paquete está listo para actualizar desde HA y las comprobaciones físicas pendientes quedan identificadas con precisión.

No hace falta otra decisión de producto para iniciar con este alcance. Si una limitación concreta del componente original obliga a desviarse de él, mostrar el problema y justificar la adaptación antes de ampliar la reescritura.
