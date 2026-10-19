# Liectroux ZK901 Map Card

Tarjeta Lovelace y custom integration de Home Assistant para controlar localmente una Liectroux ZK901. El repositorio mantiene juntos el frontend y el backend que necesita; no depende de Laser Robot, de un script externo ni de HACS.

## Funciones

- Captura autónoma del recorrido cada 20 segundos durante actividad, con historial persistente y cobertura estimada; funciona con el panel cerrado.
- Plano vectorial de zonas persistidas y posición/orientación reciente del robot; no necesita cámara, imagen ni calibración.
- Inicio/continuación, pausa, detención, retorno a base, intensidad y limpieza de la posición actual.
- Selección de varias zonas y un único servicio `liectroux_zk901.clean_areas`.
- Edición de zonas desde la tarjeta: crear, renombrar, cambiar tipo, mover y ajustar vértices, deshacer, descartar y eliminar.
- Conflictos de catálogo y guardados de resultado incierto se muestran sin sobrescribir ni reenviar silenciosamente cambios.
- Editor visual de configuración, diseño adaptable y etiquetas en español.
- Entidad de actualización para consultar e instalar releases estables emparejadas de la integración y la tarjeta.

Las áreas prohibidas y objetos del sistema no se ofrecen como destinos de limpieza. La tarjeta usa las coordenadas que expone la integración para dibujar las zonas; no representa LiDAR, paredes ni obstáculos.

## Recorrido y reconstrucción

La integración recoge puntos `21011` de forma incremental mientras el robot limpia, vuelve a base o está en control manual. Hace una consulta inicial, consultas cada 20 segundos y una lectura al cambiar de estado para cerrar el tramo. Pausar conserva la actividad; regresar a la base la cierra. La card no inicia consultas de trayectoria: abrirla, cerrarla o tener varias abiertas no cambia la captura.

Se conservan hasta 30 actividades y un máximo global de 30.000 puntos; se descartan primero los recorridos más antiguos. Si una sola actividad supera el límite se conserva su cola y se marca como incompleta. La cobertura acumulada se guarda aparte del historial, como una cuadrícula aproximada de 10 cm con hasta 30.000 celdas y tres contextos de mapa; al alcanzar el límite se descartan primero contextos antiguos y luego las celdas añadidas más antiguas. El historial y el cursor se guardan después de cada consulta y se recuperan al recargar o reiniciar HA.

La card permite seleccionar una actividad o el historial, ocultar el recorrido y la cobertura, y **reiniciar la reconstrucción** con confirmación. Si se borra durante una limpieza, se conserva el cursor de lectura para evitar una descarga retrospectiva grande. La cobertura es una franja ilustrativa de aproximadamente 30 cm sobre tramos clasificados como limpieza; no es una medición de superficie limpia ni una detección de paredes. Los tramos de regreso son ámbar; las transiciones o intervalos de estado incierto son grises y no aportan cobertura. En control manual no se presume aspiración ni cobertura.

Los timeouts no reinician el cursor. Las interrupciones se señalan y se mantienen segmentos separados. Cambiar de `pathID` inicia otra actividad; cambiar de `mapId` separa el contexto visible. Un mismo `mapId` no garantiza coordenadas estables: si después de mover la base o regenerar el mapa aparecen recorridos desplazados, usá **Reiniciar reconstrucción**. No se obtiene ni se reconstruye el raster LiDAR.

**Limitación conocida:** después de una desconexión prolongada, un backlog grande puede agotar el tiempo de respuesta. No hay recuperación completa garantizada ni se sustituyen los puntos faltantes por líneas. La captura no envía comandos de movimiento o limpieza.

## Compatibilidad

La versión **0.4.0** incorpora captura autónoma, persistencia e historial de recorridos y cobertura estimada. La lectura incremental está validada previamente en LAN; la captura autónoma completa requiere aceptación física con esta versión.

La versión **0.3.2** incorpora registros de diagnóstico para selecciones de zonas, respuestas de comandos y eventos del robot, con identidades y credenciales ocultas. No modifica los comandos de limpieza.

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
