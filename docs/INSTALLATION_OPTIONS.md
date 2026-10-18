# Opciones de instalación y actualización sin HACS

Contexto: Home Assistant Container 2026.9.2. La integración y la tarjeta se desarrollan juntas en este repositorio. Este documento compara alternativas de distribución; no instala ni modifica la instancia HA.

## Qué está preparado hoy

`npm run package` genera un ZIP conjunto con las rutas que HA espera, el JS por separado, un manifest de versiones y `SHA256SUMS`. Los workflows de build/release generan los mismos artefactos. No se publicó una release ni se implementó todavía un instalador o actualizador remoto.

El archivo Python se debe instalar en `custom_components/liectroux_zk901/` y el frontend debe estar servido y registrado como recurso. La configuración mediante **Añadir integración** no descarga por sí sola el código de este repositorio. En nuestra versión objetivo, un enlace GitHub no sustituye esos pasos.

Referencias: [ubicación de custom integrations](https://contributors.home-assistant.io/core/integrations/file-structure/) y [registro de recursos](https://contributors.home-assistant.io/frontend/custom-ui/resources/).

## Comparación

| Alternativa | Instalación inicial | Actualizaciones | Trabajo adicional |
|---|---|---|---|
| ZIP conjunto | Descargar, comprobar y colocar las dos carpetas en la configuración de HA. | Repetir con otra versión y conservar copia anterior. | El empaquetado ya está implementado; la copia sigue siendo manual. |
| Instalador desde releases en el host de HA | Ejecutar un comando con versión y ruta real de la configuración. | El mismo comando descarga e instala otra versión. | Desarrollar el instalador, backup y rollback. Es la recomendación inicial. |
| Despliegue desde la Mac por SSH | Un comando local envía el paquete al host y lo instala en su configuración. | Repetir el comando con una versión elegida. | Acceso SSH y ruta del volumen; implementar el script de despliegue. |
| Actualizador propio dentro de HA | Primera instalación mediante ZIP o script. | Una entidad de actualización muestra releases y permite instalar desde la UI. | Más implementación y mantenimiento; HA aporta la interfaz, no el actualizador de este fork. |
| Checkout/montajes Docker | Preparar un checkout versionado y montar los directorios de código/bundle en HA. | Cambiar de revisión, preparar el JS compilado y reiniciar. | Adecuado para desarrollo; requiere manejar Git, permisos y Docker. |

## Recomendación para uso personal

Preparar un **instalador versionado que consuma las releases de GitHub**. Su comportamiento debería ser:

1. Recibir una versión explícita y la ruta del directorio de configuración del host, sin suponer que la ruta del host sea `/config`.
2. Descargar el ZIP y sus hashes de esa release. Inspeccionar/descomprimir primero en un directorio temporal y comprobar su estructura.
3. Conservar una copia de la integración y del JS que vaya a reemplazar.
4. Reemplazar únicamente `custom_components/liectroux_zk901/` y el bundle de este proyecto; no borrar el resto de `custom_components`, `www` ni la configuración de HA. Reemplazar la carpeta propia permite retirar módulos obsoletos que una extracción por encima dejaría atrás.
5. Proporcionar una operación de vuelta a la versión anterior. Un fallo de instalación debe restaurar también una pareja compatible de backend/frontend.
6. Indicar que debe reiniciarse HA si cambió Python y recargarse el navegador si cambió JS. Un reinicio automático sería una opción explícita, no un efecto oculto.

El registro module se hace una vez por la UI de recursos. La actualización debe tener una estrategia explícita de caché/versionado; copiar el archivo no garantiza que todos los navegadores lo recarguen inmediatamente. No hace falta un token de HA para descargar e instalar archivos en el host; gestionar el recurso automáticamente por API sí requeriría una sesión autorizada.

Así GitHub es el origen de los paquetes, pero la aspiradora sigue controlándose por LAN y la UI se sirve desde HA. No se necesita Node.js en el host de HA ni descargar GitHub en cada apertura de la tarjeta.

Un script vía SSH desde la Mac ofrece prácticamente la misma experiencia si no se quiere dejar un instalador en el servidor. Primero hay que conocer el acceso disponible y la ubicación del volumen de configuración; todavía no se verificó ese acceso.

## Actualizaciones desde la UI de HA

Es posible añadir una plataforma `update` a nuestra integración para consultar releases y ofrecer un botón de instalación. [Home Assistant documenta las entidades de actualización y su método de instalación](https://contributors.home-assistant.io/core/entities/update/).

Eso no funciona automáticamente por añadir el repositorio: tendríamos que implementar descarga, comprobación, backup, reemplazo, errores y compatibilidad entre ambos componentes. La instalación inicial sigue necesitando un mecanismo que coloque el código en HA. Las escrituras necesitan un volumen de configuración con permisos adecuados, y el código Python actualizado necesita reiniciar HA.

Es una alternativa cómoda si el propietario quiere usar exclusivamente la UI para las siguientes versiones. Se evalúa como una ampliación explícita del alcance; hoy no está implementada. Conviene resolver primero la tarjeta/integración funcional y el formato del paquete, que son la base común de cualquier instalador.

## Simplificar también la distribución del JavaScript

Podemos hacer que la integración sirva el bundle compilado desde su propia carpeta, mediante las [rutas estáticas HTTP de HA](https://contributors.home-assistant.io/blog/2024/06/18/async_register_static_paths/). Eso permitiría instalar físicamente una sola carpeta de integración.

Seguiría haciendo falta registrar/cargar el recurso en el frontend y resolver caché/versionado. No elimina la necesidad de instalar/actualizar Python. Es una mejora de empaquetado que requiere desarrollo; el paquete actual conserva `custom_components/` y `www/`.

## Límites

- No se instala nada en HA como parte de esta reorganización de fuentes.
- No hay autoactualización desde `master` ni ejecución de scripts remotos al cargar la tarjeta.
- Un `git clone` o `git pull` por sí solo no compila ni instala el JS ni registra el recurso.
- No modificar `.storage` para automatizar recursos; usar la UI o la API autorizada.
- El material OEM, pruebas físicas, `.env` y credenciales permanecen fuera del paquete.
