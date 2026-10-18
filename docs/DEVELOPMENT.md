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
- `tests/browser/card-flows.test.mjs`: Chromium con backend stateful simulado. Recorre configuración mínima, comandos, estado, multiselección, catálogo vacío, pose antigua, geometría inválida, nombres repetidos, CRUD, cambio de mapa, campos opacos, conflicto, resultado incierto, interacción táctil/teclado, temas, tamaños móviles, dos tarjetas/pestañas, permisos y compatibilidad con el editor anterior en ambos órdenes de carga.

El CI ejecuta tests Python, compila/empaqueta e inicia Playwright/Chromium. Estas pruebas verifican cableado de software; no confirman que el firmware ejecute físicamente una selección de varias zonas ni cambian el nivel de evidencia del protocolo. Esa aceptación se registra por separado según el plan.

## Empaquetado

`scripts/package-release.py` recibe un bundle compilado y arma el ZIP con una lista permitida de archivos. El manifest contiene versiones frontend/backend, dominio, API de tarjeta, versión HA probada, commit fuente, estado modificado y hashes SHA-256 de los archivos empaquetados. `SHA256SUMS` protege los tres artefactos distribuidos: JS, ZIP y manifest.

Las rutas del archivo son relativas a la configuración de HA. El empaquetador rechaza bundles con placeholder, versión incorrecta, integración incompleta o fuentes sin la versión API y pin HA declarados. No incluye pruebas, cachés, `.env` ni el editor legado.

El workflow de build adjunta los artefactos como artifact de GitHub Actions. El de release prepara los mismos archivos para una release creada por el propietario. No se publican releases ni se hace push durante el trabajo local.

## Referencia del fork

La base es [Lovelace Xiaomi Vacuum Map Card](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card). Se conserva MIT y atribución. Los presets, plantillas de marcas y recursos visuales ajenos se retiraron; revisar upstream antes de portar código evita reintroducir un flujo de control no compatible con ZK901.

## Revisión 0.2.0

La tarjeta y la integración usan la versión 0.2.0. Las suscripciones abiertas resuelven el coordinador vigente cuando la entrada se recarga; una nueva generación reinicia la secuencia y la configuración de la entrada notifica su disponibilidad al finalizar la carga. No se abre otra conexión al robot.

Durante un guardado, la tarjeta valida y ordena los snapshots entrantes, conserva el más reciente y aplica su catálogo al terminar la operación. Esa aplicación no vuelve a rechazar por secuencia el evento ya aceptado. Así se conserva también un cambio externo recibido mientras la respuesta del guardado estaba en tránsito.

Las regresiones cubren una recarga con sustitución de coordinador y la respuesta de un guardado retenida mientras otra vista cambia una zona. Son pruebas sin hardware; la aceptación física se mantiene en la guía de instalación.
