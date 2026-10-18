# Opciones de instalación y actualización sin HACS

Contexto: Home Assistant Container 2026.9.2. La integración y la tarjeta se desarrollan juntas en este repositorio. Este documento compara alternativas de distribución; no instala ni modifica la instancia HA.

## Qué está preparado hoy

`npm run package` genera un ZIP conjunto con las rutas que HA espera, el JS por separado, un manifest de compatibilidad (frontend, backend, API y HA probado) y `SHA256SUMS`. Los workflows de build/release generan los mismos artefactos. La plataforma `update` ya consulta releases estables completas y ofrece instalación manual desde la UI; todavía no se publicó una release para probar el recorrido completo en HA. La primera instalación de la pareja 0.3.0 sigue siendo manual y está descrita en [INSTALLATION.md](INSTALLATION.md).

El archivo Python se debe instalar en `custom_components/liectroux_zk901/` y el frontend debe estar servido y registrado como recurso. La tarjeta completa usa la suscripción y los servicios de la integración incluida en el mismo paquete. La configuración mediante **Añadir integración** no descarga por sí sola el código de este repositorio. En nuestra versión objetivo, un enlace GitHub no sustituye esos pasos.

Referencias: [ubicación de custom integrations](https://contributors.home-assistant.io/core/integrations/file-structure/) y [registro de recursos](https://contributors.home-assistant.io/frontend/custom-ui/resources/).

## Comparación

| Alternativa | Instalación inicial | Actualizaciones | Trabajo adicional |
|---|---|---|---|
| ZIP conjunto | Descargar, comprobar y colocar las dos carpetas en la configuración de HA. | Puede usarse como recuperación o instalación inicial anterior a 0.3.0. | El empaquetado ya está implementado; la copia sigue siendo manual. |
| Instalador desde releases en el host de HA | Ejecutar un comando con versión y ruta real de la configuración. | El mismo comando descarga e instala otra versión. | Desarrollar el instalador, backup y rollback. Puede simplificar futuras actualizaciones. |
| Despliegue desde la Mac por SSH | Un comando local envía el paquete al host y lo instala en su configuración. | Repetir el comando con una versión elegida. | Acceso SSH y ruta del volumen; implementar el script de despliegue. |
| Actualizador propio dentro de HA | Instalar manualmente la pareja 0.3.0 una vez. | Una entidad de actualización muestra releases y prepara la pareja frontend/backend desde la UI. | Implementado; la publicación y validación del recorrido completo siguen pendientes. |
| Checkout/montajes Docker | Preparar un checkout versionado y montar los directorios de código/bundle en HA. | Cambiar de revisión, preparar el JS compilado y reiniciar. | Adecuado para desarrollo; requiere manejar Git, permisos y Docker. |

## Alcance del actualizador implementado

El actualizador consume las releases públicas estables de `estanimw/lovelace-liectroux-zk901-card`; no sigue `master`, no necesita token y solo instala cuando se pulsa **Instalar**. Antes de escribir valida:

- los cuatro artefactos esperados, sus tamaños, hosts y hashes;
- el manifest, tag y versiones iguales de frontend y backend;
- cada ruta del ZIP, sus hashes y la ausencia de duplicados o symlinks;
- espacio y permisos para crear el bundle versionado y el respaldo.

La instalación modifica solo `custom_components/liectroux_zk901/` y los bundles de esta tarjeta. Conserva un respaldo, registra cada paso y restaura ante fallo; un journal permite recuperar una interrupción al arrancar. El bundle nuevo usa una URL versionada. En modo storage, el recurso existente cambia mediante la colección Lovelace de Home Assistant después de que cargue el backend correspondiente. La instalación inicial 0.3.0 versiona el bundle que ya estaba instalado.

La entidad no depende de que la aspiradora esté conectada y no reinicia Home Assistant. Luego de instalar, el propietario reinicia HA y recarga el navegador. Con recursos YAML, el propietario debe cambiar manualmente la URL del bundle después del reinicio. El servicio administrador `liectroux_zk901.restore_previous_version` restaura el backend y la pareja del frontend; si la nueva integración no carga, [INSTALLATION.md](INSTALLATION.md) describe la recuperación externa.

GitHub solo distribuye paquetes: la aspiradora continúa controlándose por LAN y la interfaz se sirve desde HA. No se necesita Node.js en el host ni se consulta GitHub al abrir la tarjeta.

## Actualizaciones desde la UI de HA

La integración ya incluye una plataforma `update` que consulta releases y ofrece notas y el botón de instalación. Usa `UpdateEntity` y `async_install` disponibles en HA 2026.9.2. [Home Assistant documenta las entidades de actualización y su método de instalación](https://contributors.home-assistant.io/core/entities/update/).

El actualizador valida, prepara y respalda ambos componentes; la instalación inicial aún requiere colocar manualmente la versión 0.3.0. La experiencia integral queda pendiente hasta publicar y probar una release posterior desde la instancia HA objetivo.

## Simplificar también la distribución del JavaScript

Podemos hacer que la integración sirva el bundle compilado desde su propia carpeta, mediante las [rutas estáticas HTTP de HA](https://contributors.home-assistant.io/blog/2024/06/18/async_register_static_paths/). Eso permitiría instalar físicamente una sola carpeta de integración.

Seguiría haciendo falta registrar/cargar el recurso en el frontend y resolver caché/versionado. No elimina la necesidad de instalar/actualizar Python. Es una mejora de empaquetado que requiere desarrollo; el paquete actual conserva `custom_components/` y `www/`.

## Límites

- No se instala nada en HA como parte de esta reorganización de fuentes.
- No hay autoactualización desde `master` ni ejecución de scripts remotos al cargar la tarjeta.
- Un `git clone` o `git pull` por sí solo no compila ni instala el JS ni registra el recurso.
- La integración actualiza recursos storage mediante la colección de recursos de HA; no escribe directamente archivos internos de `.storage`. Los recursos YAML requieren un cambio manual.
- El material OEM, pruebas físicas, `.env` y credenciales permanecen fuera del paquete.
