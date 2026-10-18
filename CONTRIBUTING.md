# Desarrollo de este fork

Este proyecto reúne la integración Python y la tarjeta para uso personal con Liectroux ZK901. La fuente de producción es `custom_components/liectroux_zk901/`, y sus pruebas sin hardware viven en `tests/`. Actualmente se trabaja directamente en `master`.

Usá Node.js 22 y ejecutá:

```sh
npm ci
npm run build
```

El bundle instalable se genera en `dist/liectroux-zk901-map-card.js`. Consultá [DEVELOPMENT.md](docs/DEVELOPMENT.md) para arquitectura, límites de esta etapa y comprobaciones, e [INSTALLATION.md](docs/INSTALLATION.md) para probarlo junto al editor actual.

Para comparar cambios del proyecto original se conserva el remoto `upstream` y la [documentación del proyecto de origen](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card). No se fusionan automáticamente sus ramas ni se publican versiones durante el desarrollo local. Conservá los avisos de licencia y autoría al reutilizar código.

Para la verificación Python: `python3 -m pip install -r requirements-dev.txt` y `python3 -m pytest -q`. Para generar todos los artefactos de una misma revisión: `npm run package`. No mantener otra copia del controlador de producción en el workspace padre.
