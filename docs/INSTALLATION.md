# Instalación en paralelo en Home Assistant

## Alcance

Esta primera versión verifica carga y renderizado del fork. Todavía no consulta `liectroux_zk901/zone_editor/get` ni guarda zonas. Mantiene los requisitos originales de imagen y calibración. No sustituye todavía al editor que ya usás.

## 1. Obtener el archivo compilado

Durante el desarrollo, ejecutá `npm ci` y `npm run build` en el fork y tomá:

```text
dist/liectroux-zk901-map-card.js
```

Cuando haya una release propia, se podrá descargar ese mismo archivo desde los assets de [Releases](https://github.com/estanimw/lovelace-liectroux-zk901-card/releases). El ZIP automático de fuentes no es el archivo instalable. No es necesario instalar Node.js en HA ni clonar el repositorio dentro de su configuración.

## 2. Copiar y registrar

Copiá el archivo a esta ruta relativa a la configuración de HA:

```text
www/liectroux-zk901/liectroux-zk901-map-card.js
```

En HA OS suele corresponder a `/config/www/liectroux-zk901/liectroux-zk901-map-card.js`. Registrá en **Ajustes → Paneles → Recursos**:

```text
/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.1.0-dev.0
```

Tipo: **JavaScript module**. Recargá el navegador. Si `www` no existía, HA requiere un reinicio para empezar a servirla. La configuración actual ya usa esa carpeta.

Conservá durante las pruebas el recurso anterior `liectroux-zk901-zone-editor.js` y su tarjeta. Los nombres públicos del fork, elementos auxiliares y eventos están separados del original. No registres dos versiones del nuevo archivo a la vez: actualizá la URL del mismo recurso.

## 3. Prueba visual sin acciones

Agregá una tarjeta manual en una vista de prueba con el contenido de [smoke_config.yaml](smoke_config.yaml). Usa `vacuum.liectroux_zk901`, una imagen SVG incluida en la configuración y listas de controles/modos vacías.

El resultado esperado es una tarjeta titulada **Prueba de carga Liectroux**, con un fondo geométrico y controles de navegación del mapa. La figura es sintética: no es tu vivienda ni el mapa del robot. La configuración no ofrece acciones de limpieza ni modifica zonas. No agregues el YAML al `configuration.yaml`.

La configuración reducida a `type` y `entity` **todavía no funciona**: es el objetivo de la siguiente etapa. El editor automático heredado busca cámaras calibradas y puede no ofrecer una configuración inicial para esta instalación; usá la tarjeta manual de prueba.

Esta etapa se comprueba localmente con un navegador simulado; su instalación y validación en tu HA siguen pendientes hasta que se realicen explícitamente.

## 4. Actualizar o volver atrás

Para actualizar, guardá una copia local del archivo anterior, copiá el nuevo a la misma ruta y cambiá el parámetro `v` del recurso existente. Durante el desarrollo usá un identificador nuevo para cada compilación instalada, aunque la versión npm no haya cambiado. Después recargá el navegador; no es necesario reiniciar HA por cambiar solo este JavaScript.

Para volver atrás, restaurá el archivo anterior y cambiá nuevamente `v`, o retirá la tarjeta de prueba y seguí usando el editor previo. No hace falta eliminar la integración, el dispositivo, sus credenciales ni sus entidades.

Cuando el fork implemente y valide todo el editor, se podrá reemplazar la tarjeta anterior en el dashboard. Solo después de comprobar que ninguna vista la usa se retirarán su recurso y archivo JS. Esa migración no forma parte de esta entrega.

Los archivos de `www` son públicos para quien pueda acceder a HA. Guardá allí solo el bundle, sin credenciales ni capturas del robot. La API autenticada seguirá siendo responsable de entregar los datos reales.
