# Variables CSS

La card 0.5.0 conserva los estilos y variables `--map-card-*` del frontend comunitario. Los colores generales provienen del tema de Home Assistant.

Variables útiles para personalizar el mapa y los controles:

```css
--map-card-primary-color
--map-card-primary-text-color
--map-card-secondary-color
--map-card-secondary-text-color
--map-card-zoomer-background
--map-card-room-outline-line-color
--map-card-room-outline-fill-color
--map-card-room-outline-line-color-selected
--map-card-room-outline-fill-color-selected
--map-card-room-label-color
--map-card-room-label-color-selected
--map-card-room-label-font-size
```

La imagen SVG generada utiliza `--secondary-background-color`, `--primary-color` y los datos de telemetría. Las variables `--zk-zone-normal`, `--zk-zone-depth` y `--zk-zone-forbid` se conservan para los borradores de edición. La card usa un contraste adaptado a la superficie generada, tipos de línea y etiquetas para distinguir zonas y selección.

La referencia completa de variables recuperadas se encuentra en `src/community/xiaomi-vacuum-map-card.ts`. No es necesario configurar CSS para utilizar la tarjeta.
