# Desarrollo del fork

## Entorno y compilación

Se trabaja sobre `master`, por decisión del propietario. Usá Node.js 22 (`.nvmrc`) y `npm ci` para reproducir el lockfile.

```sh
npm ci
npm run build
```

`build` ejecuta ESLint, Rollup/TypeScript y la inserción de versión. El resultado es `dist/liectroux-zk901-map-card.js`; `dist/` y `node_modules/` quedan fuera de Git. El script de versión usa Node directamente y no necesita una caché Babel en el directorio personal.

El entrypoint conserva el nombre interno `src/xiaomi-vacuum-map-card.ts` y las clases TypeScript originales para facilitar comparación con upstream. Son nombres locales al módulo, no registros globales del navegador. Rollup fija explícitamente el nombre del archivo de salida tanto en producción como en desarrollo.

`npm start` conserva el servidor de desarrollo heredado en el puerto 5000; sirve el nuevo nombre de archivo. La versión de desarrollo muestra el placeholder hasta ejecutar la compilación completa. Para instalar en HA usá siempre `npm run build`.

## Referencia y compatibilidad

Punto de partida: commit upstream `045c3ac` (`Add new vacuum templates to README`).

La primera compilación con Node 22 falló porque `rollup-plugin-typescript2@0.30.0` intenta resolver `tslib/package.json` a través de exports no disponibles. Se actualizó únicamente ese plugin a `0.35.0`, conservando TypeScript, Lit y el resto de la base. Con esa corrección se compiló el código original antes de cambiar la identidad.

La base original emite warnings de ESLint sobre decoradores, referencias `this` de tslib y dependencias circulares de `utils`/`map-mode`. No se cambió la configuración para silenciarlos. Modernizar el resto del toolchain queda fuera de esta etapa.

## Fronteras de responsabilidad

- Integración Python: única conexión LAN, protocolo, entidades, servicios y validación/persistencia de zonas.
- Fork: presentación, interacción, borradores y consumo de API autenticada de HA.
- Primera etapa: identidad, compilación y distribución. Sin llamadas nuevas a la integración ni cambios de protocolo.
- Siguiente etapa: adaptador de lectura para `liectroux_zk901/zone_editor/get` y representación vectorial de zonas/pose. Después, controles y edición con `apply`.

Se retiraron las plantillas y presets de otras marcas, sus ejemplos, videos y documentación, el devcontainer y la configuración VS Code originales, las plantillas de issues y los enlaces de financiación del autor original. También se eliminaron las dependencias de desarrollo `cross-var` y `replace-in-file`, reemplazadas por el script de versión nativo de Node. Se conserva la licencia y la referencia al repositorio upstream.

`PlatformGenerator` ofrece únicamente una base genérica `default`, sin comandos ni modos preconfigurados. La configuración de prueba utiliza imagen y calibración explícitas. Hasta conectar la API ZK901, no se ofrece compatibilidad automática con el mapa del robot. Los componentes genéricos de geometría, controles, traducción y estilos se conservan para la adaptación. Para comprobar esta entrega usá `smoke_config.yaml`.

## Convivencia

El fork registra `liectroux-zk901-map-card`, su editor, su action handler y auxiliares `lzmc-*`, incluido `lzmc-pinch-zoom`. Los eventos globales del editor también tienen prefijo propio. La clave de acciones DOM es `liectroux_zk901_map_card`; las futuras acciones personalizadas deberán usar esa clave. El evento estándar `ll-custom` y las variables CSS heredadas se conservan.

Los recursos se cargan a nivel de frontend: ocultar una tarjeta no evita que su módulo registre custom elements. Por eso la separación incluye todos los auxiliares, no solo la tarjeta raíz.

## Comprobaciones antes de instalar

1. `npm ci` y `npm run build` deben terminar correctamente.
2. El bundle debe llevar la versión de `package.json`, sin placeholders pendientes.
3. Cargar la compilación original y el fork en ambos órdenes no debe producir registros duplicados.
4. La configuración sintética de prueba debe renderizar mapa, navegación y editor de configuración sin llamadas a servicios.
5. Repetir la carga junto al editor vectorial actual, sin conexión al robot.

Estas comprobaciones no equivalen a una validación en HA ni a una prueba física de comandos.

## GitHub

`origin` apunta al fork de estanimw y `upstream` al proyecto original. Los cambios futuros de upstream se revisan antes de integrarlos. No se conserva el workflow que fusionaba automáticamente `master` a `dev` bajo la identidad del autor original.

Los workflows de build y release usan Node 22 y Python 3.14. Ejecutan las pruebas Python y `npm run package`; guardan o adjuntan el JS, el ZIP conjunto, el manifest y `SHA256SUMS`. En una release se ajusta la versión frontend al tag antes de compilar. Se eliminaron los metadatos y el workflow de HACS. No se publica ninguna release ni se hace push al ejecutar una compilación local.

## Resultado de esta etapa — 2026-10-18

- Node `22.22.2`, npm `10.9.7`: instalación limpia con `npm ci` desde la caché descargada y compilación completa correctas.
- Bundle final: versión `v0.1.0-dev.0`, sin placeholder de versión pendiente.
- Chromium headless con HA simulado: carga de original → fork → editor actual y fork → editor actual → original sin errores de JavaScript ni registros duplicados.
- La imagen sintética, el contenedor de zoom, el SVG y el editor de configuración renderizan. Zoom y ajuste de vista funcionan.
- El editor del fork ignora el evento de selección original y responde a su evento propio.
- Cero llamadas a servicios en la prueba. No se accedió al robot ni se instaló la tarjeta en HA.
- YAML de workflows, coherencia de versión del lockfile y `git diff --check` verificados. Los workflows de GitHub se prepararon localmente; no se ejecutaron ni publicaron en GitHub.

La limpieza previa al primer commit retiró el soporte específico de otras marcas. Se volvió a comprobar la compilación y la prueba de navegador con la base genérica antes de cerrar ese commit.

## Migración a repositorio único — 2026-10-18

`custom_components/liectroux_zk901/` y `tests/test_zk901_client.py` se trasladaron desde el workspace padre sin modificar sus bytes. Se verificaron por SHA-256 los 16 archivos fuente de la integración y el test. Se excluyeron cachés Python y metadatos Finder. No hay una segunda copia editable de esa integración en el workspace padre.

La integración no importa código del workspace de investigación ni usa `.env`; las credenciales siguen entrando por la configuración de HA. Se conserva el JS del editor anterior en las fuentes durante la transición, pero no se incluye en el paquete nuevo ni se modifica su copia desplegada en HA.

Para probar el cliente y el empaquetado: `python3 -m pip install -r requirements-dev.txt` y `python3 -m pytest -q`. La configuración pytest solo descubre `tests/` de este checkout; no ejecuta experimentos físicos del workspace padre. Estas pruebas no sustituyen las futuras pruebas de la API en HA real.

`npm run package` no instala nada ni habla con HA: genera artefactos en `dist/`. El ZIP contiene los módulos Python, manifest, servicios y traducciones permitidos, y el bundle recién compilado en `www/liectroux-zk901/`. No se incluye el resto del repositorio. El script de empaquetado usa solo la biblioteca estándar de Python y puede ejecutarse sobre una compilación fresca mediante `python3 scripts/package-release.py`.
