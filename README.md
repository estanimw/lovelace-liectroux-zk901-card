# Liectroux ZK901 Map Card

Tarjeta personalizada de Home Assistant para la Liectroux ZK901, en desarrollo. Es un fork de [Lovelace Xiaomi Vacuum Map Card](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card), de Piotr Machowski, adaptado para trabajar con nuestra integración local `liectroux_zk901`.

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

Este repositorio contiene el frontend. La integración `liectroux_zk901` sigue creando la entidad `vacuum`, batería, selector y botón, y es la única responsable de conectarse al robot y validar los comandos.

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

## Instalar y actualizar

La instalación se hace copiando el JavaScript compilado a `www/liectroux-zk901/` de HA y registrándolo como recurso de tipo **JavaScript module**. Durante las pruebas se conservan la tarjeta y el recurso actuales.

- [Guía de instalación, actualización y vuelta atrás](docs/INSTALLATION.md).
- [Configuración de prueba sin acciones](docs/smoke_config.yaml).
- [Desarrollo, arquitectura y verificación](docs/DEVELOPMENT.md).
- [Variables CSS heredadas disponibles](docs/css_variables.md).

Cuando se publique una release del fork, su asset `liectroux-zk901-map-card.js` será el archivo instalable. El workflow está preparado para generarlo; todavía no se publicó una release propia. Descargar el ZIP del código fuente o crear el fork no instala la tarjeta. Las actualizaciones son explícitas y el funcionamiento diario usa el archivo servido por HA, sin depender de GitHub.

## Próximas etapas

1. Leer catálogo de zonas y posición desde la API WebSocket de nuestra integración.
2. Dibujar zonas/pose en una capa vectorial y simplificar la configuración a la entidad de la aspiradora.
3. Integrar controles y ejecución de una zona persistida mediante servicios existentes.
4. Incorporar creación, edición y eliminación de zonas con borrador local y guardado verificado por el backend.
5. Validar en HA y reemplazar el editor anterior.

El acceso autónomo a un raster LiDAR y las operaciones espaciales sin protocolo confirmado no forman parte de esta entrega.

## Licencia y autoría

Se conserva la [licencia MIT](LICENSE) y el copyright original de Piotr Machowski. La referencia completa del proyecto de origen permanece en [upstream](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card) y en la historia Git del fork; las demos, documentación por marca y configuraciones de mantenimiento del proyecto original se retiraron de esta copia.
