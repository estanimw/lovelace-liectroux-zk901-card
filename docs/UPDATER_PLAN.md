# Actualizador desde Home Assistant — próxima entrega

Estado: implementado en el checkout; no publicado ni desplegado. Revisión: 2026-10-18.

## Comprobación de la instalación actual

La integración figura cargada en HA Container 2026.9.2, Python 3.14.6, aarch64. Lovelace usa recursos en modo storage. Hay un único recurso ZK901, `/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.2.0`. En `panel-general/general`, sección Limpieza, conviven la tarjeta nativa y la nueva tarjeta, ambas sobre la misma entidad.

Inspección visual de la aplicación de HA: tarjeta v0.2.0/API 1, batería 100 %, ocho zonas, catálogo y pose visibles. La entidad está `docked`, con `mode=fullcharge`. El propietario confirmó iniciar limpieza total y volver a base. No se ejecutaron comandos ni escrituras al robot durante la revisión. Edición y limpieza multizona no se consideran físicamente validadas por esta comprobación.

Dos defectos de presentación para incluir en la próxima entrega:

- El diseño cambia según el ancho de ventana, no el ancho real de la tarjeta. En una columna estrecha de un panel de escritorio conserva dos columnas, comprime el mapa y parte su encabezado. Usar consultas del contenedor y probar una tarjeta estrecha dentro de una ventana ancha.
- `error_state=[]` provoca una etiqueta vacía «Error», porque un array vacío es verdadero en JavaScript. Mostrar únicamente errores con contenido; probar lista vacía y lista con errores conservando sus valores originales.

En los registros consultados solo aparecen las advertencias habituales de carga de una custom integration; no aparecen errores ZK901 en esa ventana de registros. Esto no garantiza ausencia de fallos fuera de esa ventana.

## Experiencia propuesta

Una entidad de actualización de software «Liectroux ZK901» permite consultar versión instalada/disponible, leer notas y pulsar Instalar. Actualiza integración y tarjeta como una pareja. No actualiza firmware del robot ni abre otra conexión a él. Se consulta GitHub periódicamente y a pedido; solo se instala por acción del propietario. No se sigue `master` automáticamente.

Después de instalar se muestra «pendiente de reinicio». El propietario reinicia HA y recarga el navegador. El recurso Lovelace se actualiza por código, sin editar `.storage` ni pedir al propietario que cambie la URL.

Es necesario instalar una vez el paquete que incorpora el actualizador: 0.2.0 todavía no tiene código para instalar otro paquete. La siguiente entrega propuesta es 0.3.0. Después de esa instalación inicial, las siguientes versiones se instalan desde la UI.

## Publicación

El repositorio público `estanimw/lovelace-liectroux-zk901-card` no tenía releases al revisarlo. No se necesita token GitHub en HA para descargar sus releases públicas.

- Crear releases versionadas con ZIP, manifest y hashes; mantener el formato conjunto actual.
- Validar que tag, versión frontend y versión backend correspondan a la misma entrega. El workflow actual cambia solo la versión npm: debe verificarse también la del manifest Python.
- Ignorar releases borrador, preliminares por defecto y publicaciones cuyos artefactos aún no estén completos. Un fallo de GitHub no debe afectar el control LAN.
- Mantener pruebas antes de adjuntar/publicar artefactos. No publicar ni hacer push como parte de este diseño.

## Implementación

1. `update.py`: entidad nativa de software, notas de versión e instalación. Un gestor compartido para todo el dominio evita instalaciones simultáneas incluso si hay varias aspiradoras. No depende de que el robot esté conectado.
2. `updater.py`: consulta de releases, descargas acotadas, timeout y verificación del paquete. Acepta únicamente el repositorio y artefactos esperados; comprueba hashes, versiones, rutas permitidas, symlinks, duplicados y tamaños antes de escribir. Los hashes comprueban integridad; no sustituyen la confianza en la cuenta/repositorio que publica.
3. Preparar todo en un directorio temporal del mismo volumen. Verificar permisos de escritura y espacio antes de cambiar archivos. Respaldar la carpeta propia y el frontend vigente fuera de la carpeta que se reemplaza. No tocar configuración de conexión, entidades, zonas ni otros componentes.
4. Reemplazar la carpeta de integración retirando módulos obsoletos. Como hay varios destinos, no prometer una operación atómica global: usar pasos registrados, restauración ante fallo y recuperación tras interrupción. Si cualquier paso falla antes de terminar, restaurar la pareja anterior.
5. Conservar el frontend que usa la versión Python todavía cargada. Preparar el JS nuevo con nombre versionado y mantener el recurso anterior hasta el reinicio. Al arrancar correctamente el backend nuevo, apuntar el recurso existente al JS de esa versión mediante la colección Lovelace de HA, sin duplicarlo ni escribir archivos internos a mano. Así una recarga anticipada del navegador no mezcla tarjeta nueva con backend antiguo.
6. Guardar versión en ejecución y versión preparada por separado; no declarar activa la versión nueva antes del reinicio. Tras reiniciar, confirmar instalación y actualizar el recurso; si esto falla, mostrar el problema y conservar el respaldo.
7. Incluir restauración explícita mientras HA pueda cargar el actualizador y un procedimiento externo de recuperación si la nueva integración no llega a importar. Un botón dentro del componente no puede resolver por sí solo ese último caso.

## Compatibilidad con el HA instalado

Usar `UpdateEntity` y `async_install` de HA 2026.9.2, no asumir todas las propiedades de la documentación más nueva. La instalación local de pruebas 2026.9.2 no expone `restart_required` en su clase UpdateEntity: implementar el aviso de reinicio con un mecanismo compatible con esa versión. No reiniciar HA automáticamente.

Se verificó que esa versión sí tiene colección de recursos Lovelace con `async_update_item`. La instancia actual usa storage y permite ese camino. Si otro usuario usa recursos YAML, explicitar la limitación en lugar de modificar su configuración silenciosamente.

## Verificación de entrega

La implementación incluye pruebas automatizadas para el filtro de releases, límites y hashes, validación de rutas del ZIP, instalación/rollback, recuperación de journal, concurrencia y actualización del recurso existente. `npm run package`, la suite Python contra HA 2026.9.2 y la prueba de navegador pasan en este checkout. La experiencia completa desde una release de GitHub aún requiere publicar y probar una release posterior en HA, y no se considera validada por simulaciones.

- [x] Pruebas de descubrimiento de releases completas/incompletas, versiones, errores y límites de descarga.
- [x] Paquetes válidos y malformados, hashes incorrectos y fallos de frontend/backend/commit; se verifica que otros componentes y el editor anterior no se modifican.
- [x] Pruebas de concurrencia, interrupción/recuperación, respaldo y restauración de backend y frontend.
- [x] Pruebas contra HA 2026.9.2 de registro de la entidad, versión pendiente, aviso de reinicio, recursos sin duplicados y cambio del JS solo después de cargar la nueva versión.
- [x] Pruebas de navegador para tarjeta estrecha en escritorio y errores vacíos/reales.
- [ ] Instalar la pareja 0.3.0 y una release posterior para demostrar la actualización completa desde HA, incluyendo reinicio, carga de la tarjeta nueva y recuperación. No se considera validada esta experiencia solo porque los tests simulados pasen.

La aceptación física de zonas puede continuar después; no es requisito técnico del actualizador y se mantiene como pendiente independiente.

## Referencias

- Entidades update: https://contributors.home-assistant.io/core/entities/update/
- Recursos Lovelace: https://contributors.home-assistant.io/frontend/custom-ui/resources/
- Código consultado de HA 2026.9.2: `components/update/__init__.py` y `components/lovelace/resources.py` del entorno local de pruebas.
