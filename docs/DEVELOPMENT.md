# Desarrollo

Este repositorio contiene la fuente única de la custom integration y la tarjeta ZK901. La integración mantiene la conexión LAN y las entidades; la UI consume servicios y WebSocket autenticados de Home Assistant. La tarjeta no implementa un segundo cliente Tuya.

## Entorno y comandos

Usa Node.js 22 (`.nvmrc`), Python 3.14 y npm. El pin de las pruebas contra Home Assistant está en `requirements-dev.txt`.

```sh
npm ci
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q
npm run lint
npm run build
npx playwright install chromium
npm run test:browser
npm run package
```

`npm run build` ejecuta ESLint, TypeScript/Rollup e inserta la versión de `package.json`. Playwright ejecuta Chromium headless y la prueba de flujos necesita que el bundle ya esté compilado. `npm run package` vuelve a construir y produce el bundle, ZIP de instalación, manifest de compatibilidad y checksums en `dist/`.

El build local y los tests no hablan con el robot, no leen credenciales ni instalan/publican nada. No ejecutes los tests físicos de la raíz del workspace desde aquí.

## Componentes

### Backend Home Assistant

- `custom_components/liectroux_zk901/client.py`: única conexión LAN, cola, encoding ya existente y operaciones con el dispositivo. La tarjeta no modifica el transporte.
- `coordinator.py`: estado, catálogo, disponibilidad y timestamps independientes. Entidades y tarjeta consumen el mismo coordinador.
- `zone_editor.py`: API autenticada para snapshots, refresco y cambios de zona. La suscripción conecta al dispatcher del coordinador; no abre otro socket.
- `vacuum.py`: comandos de la entidad y puente a la limpieza de zonas persistidas.
- `update.py` y `updater.py`: una entidad de software compartida, consulta de releases estables y actualización del par backend/frontend con comprobación, backup, rollback y recuperación de interrupciones.
- `__init__.py`: servicios y validación del esquema público.

`liectroux_zk901.clean_area` se conserva. `liectroux_zk901.clean_areas` recibe `area_ids`, exige una lista no vacía de enteros positivos sin booleanos ni duplicados y se valida de nuevo contra un catálogo fresco. Si un destino es inválido, prohibido o ya no existe, se rechaza la solicitud entera. Una lista válida genera un solo compuesto `30000` con `21023` seguido de `21005`; un resultado incierto no se reenvía automáticamente.

### API que usa la tarjeta

- `liectroux_zk901/card/subscribe`: snapshot inicial seguido por eventos con `api_version`, `generation`, `sequence`, estado, pose, catálogo y capacidades.
- `liectroux_zk901/card/refresh`: refresca estado y catálogo desde el cliente existente.
- `liectroux_zk901/zone_editor/get`: lectura fresca del catálogo y pose observada.
- `liectroux_zk901/zone_editor/apply`: create/update/delete con `base_map_id` y `base_revision`; el servidor devuelve catálogo verificado o un error estructurado.
- Servicios nativos `vacuum.start`, `pause`, `stop`, `return_to_base`, `clean_spot` y `set_fan_speed`; el último inicia `liectroux_zk901.clean_areas` para las zonas elegidas.

La edición y lectura del mapa conserva el requisito de administrador. La reconexión solo restablece lecturas/suscripciones; la UI no reenvía acciones. El API tiene versión independiente del número de versión del bundle.

### Frontend

- `src/zk901-card.ts`: componente, ciclo de vida, controles, plano, selector de zonas, borrador y mensajes de error.
- `src/data/zk901.ts`: único adaptador de API del componente.
- `src/model/zone-geometry.ts`: proyección reversible y validación geométrica sin red.
- `src/model/zone-draft.ts`: borrador, operaciones, deshacer, conflicto e incertidumbre.
- `src/editor.ts`: selector visual de la entidad ZK901 y título opcional.

La configuración mínima es `type` y `entity`. Los nombres de archivo y elementos publicados llevan identidad Liectroux propia. Se retiraron presets, plataformas y camino de configuración heredados que ya no tienen consumidores.

## Pruebas y evidencia

- `tests/test_zk901_client.py`: cliente simulado, contrato compuesto multizona y persistencia/validación del protocolo.
- `tests/test_zk901_ha_api.py`: registra servicios y WebSocket contra Home Assistant real 2026.9.2, valida esquemas, snapshot, dispatcher y permisos.
- `tests/test_release_package.py`: estructura del ZIP, compatibilidad manifest, hashes y exclusión de archivos locales.
- `tests/test_updater.py`: filtro de releases, límites/versión/hash/rutas, instalación, restauración, recuperación tras interrupción, concurrencia y actualización del recurso existente.
- `tests/browser/card-flows.test.mjs`: Chromium con backend stateful simulado. Recorre configuración mínima, comandos, estado, multiselección, catálogo vacío, pose antigua, geometría inválida, nombres repetidos, CRUD, cambio de mapa, campos opacos, conflicto, resultado incierto, interacción táctil/teclado, temas, tamaños móviles, dos tarjetas/pestañas, permisos y compatibilidad con el editor anterior en ambos órdenes de carga.

El CI ejecuta tests Python, compila/empaqueta e inicia Playwright/Chromium. Estas pruebas verifican cableado de software; no confirman que el firmware ejecute físicamente una selección de varias zonas ni cambian el nivel de evidencia del protocolo. Esa aceptación se registra por separado según el plan.

## Empaquetado

`scripts/package-release.py` recibe un bundle compilado y arma el ZIP con una lista permitida de archivos. El manifest contiene versiones frontend/backend, dominio, API de tarjeta, versión HA probada, commit fuente, estado modificado y hashes SHA-256 de los archivos empaquetados. `SHA256SUMS` protege los tres artefactos distribuidos: JS, ZIP y manifest.

Las rutas del archivo son relativas a la configuración de HA. El empaquetador rechaza bundles con placeholder, versión incorrecta, integración incompleta o fuentes sin la versión API y pin HA declarados. No incluye pruebas, cachés, `.env` ni el editor legado.

El workflow de build adjunta los artefactos como artifact de GitHub Actions. El de release prepara los mismos archivos para una release creada por el propietario. No se publican releases ni se hace push durante el trabajo local.

## Referencia del fork

La base es [Lovelace Xiaomi Vacuum Map Card](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card). Se conserva MIT y atribución. Los presets, plantillas de marcas y recursos visuales ajenos se retiraron; revisar upstream antes de portar código evita reintroducir un flujo de control no compatible con ZK901.

## Actualizador 0.3.0

La primera versión con actualizador es un bootstrap manual. A partir de ahí, la entidad `update` consulta la API pública de releases del repositorio fijo `estanimw/lovelace-liectroux-zk901-card`; no sigue `master`, no usa token y excluye releases borrador/preliminares/incompletas. La instalación está detrás de una acción explícita, no se ejecuta con la consulta.

`updater.py` limita tiempo, tamaños, hosts y nombres de artefacto. Verifica `SHA256SUMS`, el manifest, todas las rutas/hash del ZIP, la versión de la tarjeta, la integración y el contrato API antes de escribir. El instalador conserva un respaldo fuera de `custom_components/liectroux_zk901`, usa archivos temporales junto a cada destino, registra pasos y restaura ante error. Un bootstrap de biblioteca estándar al inicio de `__init__.py` recupera un despliegue interrumpido antes de importar los módulos de integración. La restauración también está disponible con el servicio administrador `liectroux_zk901.restore_previous_version`; la recuperación externa está descrita en `INSTALLATION.md`.

El bundle nuevo se instala con nombre versionado. Hasta que el backend nuevo cargue después del reinicio, el recurso storage permanece apuntando a la URL anterior y su archivo no se borra. Si la colección de recursos de storage cambia o no es única, se conserva el respaldo y se informa. Los recursos YAML no se editan: requieren cambiar manualmente la URL. La versión pendiente se guarda por separado de la versión Python en ejecución; HA no se reinicia automáticamente.

Las regresiones del actualizador usan las notificaciones y el ejecutor reales de HA 2026.9.2 para recorrer instalación, activación al reiniciar, fallo del recurso Lovelace y restauración antes/después de activar. Solo las descargas de GitHub y la colección de recursos se simulan en estos flujos. Las notificaciones se publican como callbacks, y los argumentos con nombre de operaciones en el ejecutor se fijan con `partial`.

Restaurar antes de reiniciar cancela también el registro pendiente de esa instalación. El journal de restauración se completa después de guardar el resultado y retirar ese registro; una restauración no deja una versión descartada bloqueando instalaciones posteriores.

El cliente LAN y el actualizador no comparten transporte ni estado: un primer estado no disponible del robot deja cargar entidades y actualizar la integración, mientras el cliente mantiene su ciclo de reconexión.

## Revisión 0.2.0

La tarjeta y la integración usan la versión 0.2.0. Las suscripciones abiertas resuelven el coordinador vigente cuando la entrada se recarga; una nueva generación reinicia la secuencia y la configuración de la entrada notifica su disponibilidad al finalizar la carga. No se abre otra conexión al robot.

Durante un guardado, la tarjeta valida y ordena los snapshots entrantes, conserva el más reciente y aplica su catálogo al terminar la operación. Esa aplicación no vuelve a rechazar por secuencia el evento ya aceptado. Así se conserva también un cambio externo recibido mientras la respuesta del guardado estaba en tránsito.

Las regresiones cubren una recarga con sustitución de coordinador y la respuesta de un guardado retenida mientras otra vista cambia una zona. Son pruebas sin hardware; la aceptación física se mantiene en la guía de instalación.

## Corrección 0.3.1

La lectura inicial de la versión del manifest se ejecuta en el ejecutor de HA, fuera del bucle principal. El gestor compartido se inicializa asincrónicamente y se reutiliza entre plataformas; dos solicitudes concurrentes conservan una sola instancia. La regresión comprueba el hilo de lectura y que acceder al gestor ya creado no vuelva a leer el archivo.

## Diagnóstico LAN 0.3.2

En nivel INFO, `custom_components.liectroux_zk901.client` registra:

- `ZK901 spatial send`: timestamp de correlación, mapa, IDs seleccionados y estado previo.
- `ZK901 spatial response`: respuesta del wrapper 30000 y de ambos comandos hijos, antes de validar su resultado.
- `ZK901 event 20003`: código, título y contenido recibido, sin inferir que todos los eventos sean errores.
- `ZK901 state`: modo/submodo, posición, orientación, fiabilidad y estadísticas al cambiar modo, submodo o errores. No repite cada lectura de posición.
- `ZK901 control send/response`: pausa, continuar y detener con su ACK; DP3 registra los inicios totales y retornos solicitados.

Los detalles se limitan a 4096 caracteres por entrada, se eliminan campos de identidad/credenciales incluso anidados y se ocultan los valores de credenciales conocidos antes de serializar. No se vuelca el sobre de envío completo ni se agregan consultas, reintentos, comandos o lectores de socket.

Para una sesión de diagnóstico, activar nivel INFO para la integración mediante las herramientas de logging de HA (o activar temporalmente su registro de depuración en la UI). Un reinicio puede restablecer el nivel de logging; comprobarlo después de actualizar y antes de la prueba física. Los INFO se consultan en el registro completo del sistema, no solamente en la lista de errores de la UI. Las pruebas automatizadas simulan eventos y ACKs: la causa de una finalización anticipada de zona sigue requiriendo la evidencia del robot.
