# Liectroux ZK901 Map Card

Tarjeta Lovelace y custom integration de Home Assistant para controlar localmente una Liectroux ZK901. El repositorio mantiene juntos el frontend y el backend que necesita; no depende de Laser Robot, de un script externo ni de HACS.

## Funciones

- Plano vectorial de zonas persistidas y posición/orientación reciente del robot; no necesita cámara, imagen ni calibración.
- Inicio/continuación, pausa, detención, retorno a base, intensidad y limpieza de la posición actual.
- Selección de varias zonas y un único servicio `liectroux_zk901.clean_areas`.
- Edición de zonas desde la tarjeta: crear, renombrar, cambiar tipo, mover y ajustar vértices, deshacer, descartar y eliminar.
- Conflictos de catálogo y guardados de resultado incierto se muestran sin sobrescribir ni reenviar silenciosamente cambios.
- Editor visual de configuración, diseño adaptable y etiquetas en español.
- Entidad de actualización para consultar e instalar releases estables emparejadas de la integración y la tarjeta.

Las áreas prohibidas y objetos del sistema no se ofrecen como destinos de limpieza. La tarjeta usa las coordenadas que expone la integración para dibujar las zonas; no representa LiDAR, paredes ni obstáculos.

## Compatibilidad

La versión **0.3.1** evita que la lectura inicial del manifest del actualizador bloquee el bucle principal de Home Assistant. Puede instalarse desde el actualizador de 0.3.0.

La versión inicial prevista para instalar el actualizador es **0.3.0**, tanto de la tarjeta como de la integración. Después, la entidad `update` consulta releases públicas de este repositorio y permite elegir cuándo instalar. La instalación prepara los archivos; el propietario reinicia Home Assistant y recarga el navegador. No se actualiza el firmware ni se abre una conexión adicional con la aspiradora.

El paquete se genera con versiones coordinadas de tarjeta, integración y API. El manifest dentro de cada ZIP declara las versiones frontend/backend, `card_api_version` y la versión de Home Assistant probada. El entorno de CI prueba Home Assistant 2026.9.2 y Python 3.14; consulta `dist/release-manifest.json` para el paquete concreto. Los releases borrador, preliminares, incompletos o con versiones y hashes inconsistentes no se ofrecen.

La forma del comando multizona está cubierta por pruebas simuladas. La aceptación física multizona en este firmware queda pendiente de ejecutarse en el robot y no se infiere de que el ACK o las pruebas simuladas pasen.

## Instalar

La tarjeta requiere instalar conjuntamente el ZIP que produce `npm run package`: integra los archivos de `custom_components/liectroux_zk901/` y `www/liectroux-zk901/`. No elimines ni vuelvas a crear la entrada de integración; la configuración, entidades y credenciales existentes se conservan.

- [Guía de instalación, actualización, aceptación y rollback](docs/INSTALLATION.md).
- [Configuración mínima de la tarjeta](docs/smoke_config.yaml).
- [Desarrollo, arquitectura y verificación](docs/DEVELOPMENT.md).
- [Opciones de distribución sin HACS](docs/INSTALLATION_OPTIONS.md).
- [Variables CSS](docs/css_variables.md).

## Desarrollo

Requisitos: Node.js 22 y Python 3.14.

```sh
npm ci
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q
npm run build
npm run test:browser
npm run package
```

`npm run package` crea `dist/liectroux-zk901-map-card.js`, `dist/liectroux-zk901-ha.zip`, `dist/release-manifest.json` y `dist/SHA256SUMS`. El ZIP solo incluye archivos de producción de la integración y el bundle. No incluye `.env`, datos locales, pruebas, cachés ni capturas. El build local no instala, publica ni hace push.

El plan y el estado de aceptación están en [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). La investigación del protocolo, el material OEM y el provisioner Android permanecen en el workspace padre y no se distribuyen aquí.

## Licencia y origen

MIT, conservando la licencia y la atribución al proyecto base [Lovelace Xiaomi Vacuum Map Card](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card) de Piotr Machowski. Este fork tiene identidad, bundle y funciones ZK901 propios.
