# Liectroux ZK901 Map Card

Integración local y tarjeta personalizada de Home Assistant para la Liectroux ZK901, en desarrollo. Es un fork de [Lovelace Xiaomi Vacuum Map Card](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card), de Piotr Machowski, adaptado para trabajar con nuestra integración local `liectroux_zk901`.

## Qué funciona hoy

- Identidad propia: `custom:liectroux-zk901-map-card`.
- Visualización de una imagen calibrada, zoom y desplazamiento.
- Editor básico de configuración y registros internos separados para convivir con otras tarjetas.
- Compilación reproducible con Node.js 22 y generación de un único archivo JavaScript instalable.
- Configuración sintética de prueba, sin acciones de limpieza ni escrituras al robot.

**Todavía no consulta ni edita las zonas de la ZK901.** Necesita `map_source` y `calibration_source`; una configuración con solo `entity` aún no es suficiente. El funcionamiento con datos simulados fue comprobado en Chromium; la instalación de este fork en HA sigue pendiente.

El alcance del fork es la ZK901. Se retiraron los presets y plantillas de comandos para otras marcas; la base genérica `default` no incluye modos de limpieza preconfigurados. No se deben trasladar configuraciones de Xiaomi, Roborock u otros modelos a este robot.

## Relación con la integración actual

```text
Tarjeta del dashboard → servicios/API autenticada de HA → integración Python → ZK901 por LAN
```

Este repositorio contiene ambos componentes. `custom_components/liectroux_zk901/` es la fuente canónica de la integración y su controlador local (`client.py`); `src/` contiene la tarjeta. La integración sigue creando la entidad `vacuum`, batería, selector y botón, y es la única responsable de conectarse al robot y validar los comandos. No hay que ejecutar un script ni un listener externo para usar HA.

Las pruebas sin hardware están en `tests/`. La investigación, el material OEM y el provisioner Android permanecen en el workspace padre y no se distribuyen en este repositorio. La migración de las fuentes al fork no cambia comandos ni configuración en la instancia HA.

La tarjeta nueva se probará junto a `custom:liectroux-zk901-zone-editor`. Instalarla no requiere borrar la integración, sus entidades ni las zonas persistidas. El editor anterior se retirará del dashboard cuando el reemplazo esté validado.

## Compilar

Requisitos: Node.js 22 (`.nvmrc`) y npm.

```sh
npm ci
npm run build
```

Archivo generado:

```text
dist/liectroux-zk901-map-card.js
```

El build ejecuta ESLint, Rollup/TypeScript e inserta la versión de `package.json`. El archivo compilado y `node_modules/` no se incluyen en Git. Home Assistant no necesita Node.js para cargar la tarjeta.

## Pruebas y paquete conjunto

Las pruebas del cliente y del empaquetado no contactan al robot:

```sh
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q
npm run package
```

El último comando compila la tarjeta y genera en `dist/`:

- `liectroux-zk901-map-card.js`: la tarjeta compilada.
- `liectroux-zk901-ha.zip`: integración y tarjeta con rutas relativas a la configuración de HA.
- `release-manifest.json`: versiones, commit y hashes de los archivos incluidos.
- `SHA256SUMS`: comprobación de los artefactos.

El ZIP incluye `custom_components/liectroux_zk901/` y `www/liectroux-zk901/`. Usa una lista de tipos/rutas de producción permitidos y excluye `.env`, cachés, pruebas y el JS fuente del editor anterior. El archivo legado sigue en las fuentes para la transición, pero no forma parte del nuevo paquete.

El paquete corresponde al estado actual: **no convierte la tarjeta base en la implementación completa prevista**. Las versiones de integración y tarjeta se registran por separado hasta fijar el contrato de la próxima entrega.

## Instalar y actualizar

La instalación se hace copiando el JavaScript compilado a `www/liectroux-zk901/` de HA y registrándolo como recurso de tipo **JavaScript module**. Durante las pruebas se conservan la tarjeta y el recurso actuales.

- [Guía de instalación, actualización y vuelta atrás](docs/INSTALLATION.md).
- [Configuración de prueba sin acciones](docs/smoke_config.yaml).
- [Desarrollo, arquitectura y verificación](docs/DEVELOPMENT.md).
- [Opciones de instalación sin HACS](docs/INSTALLATION_OPTIONS.md).
- [Variables CSS heredadas disponibles](docs/css_variables.md).

Cuando se publique una release del fork, sus assets incluirán el ZIP conjunto, el JS separado, el manifest y los hashes. El workflow está preparado para generarlos; todavía no se publicó una release propia. Descargar el ZIP del código fuente o crear el fork no instala la tarjeta. Las actualizaciones son explícitas y el funcionamiento diario usa el archivo servido por HA, sin depender de GitHub.

## Próxima iteración

El [plan de implementación completo](docs/IMPLEMENTATION_PLAN.md) fija una entrega instalable de tarjeta e integración compatible: zonas y posición en vivo, controles diarios, limpieza de una o varias zonas y CRUD completo. Incluye criterios de aceptación, pruebas, empaquetado y migración conservando la instalación actual.

El plan describe trabajo por realizar; las capacidades disponibles hoy siguen siendo las indicadas arriba. La siguiente iteración no incluye recorrido ni adquisición LiDAR/cloud.

## Licencia y autoría

Se conserva la [licencia MIT](LICENSE) y el copyright original de Piotr Machowski. La referencia completa del proyecto de origen permanece en [upstream](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card) y en la historia Git del fork; las demos, documentación por marca y configuraciones de mantenimiento del proyecto original se retiraron de esta copia.
