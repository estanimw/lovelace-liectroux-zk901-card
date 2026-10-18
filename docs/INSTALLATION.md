# Instalar en Home Assistant Container

Esta guía instala en pareja la custom integration y la tarjeta, conservando la entrada ZK901, las entidades, zonas y credenciales que ya existen. El objetivo probado es Home Assistant 2026.9.2 con Python 3.14. No instala nada por HACS. El actualizador cambia recursos storage mediante la colección de Home Assistant; no edita directamente archivos internos de `.storage`.

## 1. Preparar el paquete

En el checkout del proyecto:

```sh
npm ci
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q
npm run package
```

El paquete para instalar es `dist/liectroux-zk901-ha.zip`. También genera el bundle separado, `release-manifest.json` y `SHA256SUMS`. Desde el directorio `dist/`, comprueba los artefactos antes de copiarlos:

```sh
# macOS
shasum -a 256 -c SHA256SUMS

# Linux
sha256sum -c SHA256SUMS
```

El ZIP contiene estas rutas relativas al directorio de configuración de Home Assistant:

```text
custom_components/liectroux_zk901/...
www/liectroux-zk901/liectroux-zk901-map-card.js
```

La primera instalación del actualizador requiere instalar manualmente la pareja 0.3.0. En las siguientes instalaciones, usa la entidad de actualización y las releases completas de este mismo repositorio.

## 2. Hacer copia de recuperación

Antes de reemplazar archivos, guarda fuera de la carpeta que actualizarás:

- La carpeta actual `custom_components/liectroux_zk901/` completa.
- El JavaScript de tarjeta/editor actualmente servido desde `www/`.
- La URL y configuración de la tarjeta/recurso que ya usas.

No borres la integración desde la UI, no elimines sus entidades y no vuelvas a provisionar el robot. El paquete no modifica los datos de conexión guardados por la entrada existente. El editor anterior puede quedarse durante la aceptación.

## 3. Instalar el ZIP

Extrae el contenido de `liectroux-zk901-ha.zip` en la raíz de la configuración de Home Assistant. En HA Container normalmente es el volumen montado como `/config`; en HA OS puede editarse mediante un complemento de archivos. El resultado debe quedar directamente en `custom_components/` y `www/`, no dentro de otra carpeta anidada.

La extracción sobrescribe los archivos de producción con la misma ruta. Conserva archivos existentes que el ZIP no trae, incluido el JS del editor anterior bajo `custom_components/liectroux_zk901/www/`. Reinicia Home Assistant para cargar el código Python actualizado. Después revisa los registros y confirma que la entidad `vacuum.liectroux_zk901` y el dispositivo existentes siguen disponibles.

## 4. Registrar o actualizar el recurso

En **Ajustes → Paneles → Recursos**, añade el recurso si no existe o actualiza la URL del recurso de esta tarjeta:

```text
/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.3.0
```

Tipo: **JavaScript module**. Usa como `v` el `card_version` de `release-manifest.json` para evitar caché vieja. Mantén un solo recurso para este archivo. No retires todavía el recurso del editor anterior. En el primer arranque con 0.3.0, si Lovelace está en modo storage y ya existe este recurso, la integración lo cambia automáticamente a una URL versionada.

## 5. Añadir la tarjeta

Usa el editor visual para elegir la entidad vacuum de la integración o agrega esta configuración manual:

```yaml
type: custom:liectroux-zk901-map-card
entity: vacuum.liectroux_zk901
```

No se requieren cámara, imagen, calibración ni listas de zonas. Recarga el navegador después de guardar el recurso; para una actualización de JS puede bastar una recarga forzada del navegador.

## 6. Aceptación funcional

Primero comprueba la instalación visual y luego las operaciones reales con el robot. Las pruebas automatizadas cubren la API real de Home Assistant 2026.9.2 y una sesión de navegador simulada; no sustituyen esta comprobación del dispositivo.

- La tarjeta carga con la configuración mínima, muestra estado, batería, zonas y una pose con su antigüedad cuando existe.
- Iniciar, pausar, continuar, detener, volver a base, intensidad y limpiar la posición actual invocan la acción esperada y muestran la respuesta/estado.
- Seleccionar zonas desde el mapa y la lista respeta el orden; una selección de varias zonas inicia una sola operación. Correlaciona el `30000`, las respuestas de `21023` y `21005`, y el modo/submodo observado. Las pruebas de código no demuestran por sí solas la conducta física multizona.
- En edición, crea una zona, ajusta sus vértices, cambia nombre/tipo, guarda y confirma que reaparece desde el catálogo del robot. Prueba deshacer y descartar.
- Elimina una zona solo después de confirmar que elegiste la correcta; verifica el catálogo resultante.
- Si el catálogo cambió externamente, confirma que la tarjeta conserva el borrador y no lo guarda encima sin revisión. Si se pierde la respuesta de un guardado, recarga el catálogo antes de decidir qué hacer.
- Comprueba la tarjeta en móvil y escritorio y verifica que el editor anterior y otras vistas siguen disponibles durante la transición.

Las zonas se escriben en el mapa real del robot. Haz la aceptación en un momento en que puedas observar el equipo y conservar el borrador anterior de las zonas fuera de la tarjeta si necesitas restaurarlas manualmente.

## 7. Actualizar desde Home Assistant

Instala manualmente una vez el paquete 0.3.0 para añadir el actualizador. Después, `update` muestra la versión estable más reciente completa, las notas y la acción **Instalar**. La consulta de GitHub es opcional y no participa en el control LAN del robot.

Al elegir **Instalar**, Home Assistant descarga únicamente los artefactos esperados de este repositorio, comprueba sus límites, versiones, rutas y hashes, prepara la pareja en disco y conserva una copia anterior. El recurso Lovelace existente no cambia todavía, así que una recarga anticipada del navegador sigue usando el JavaScript que corresponde al backend cargado.

Cuando aparezca el aviso de reinicio pendiente, reinicia Home Assistant. Al cargar correctamente la nueva integración, en modo storage se actualiza la URL del recurso existente sin duplicarlo ni editar directamente `.storage`; después recarga el navegador. La integración no reinicia Home Assistant automáticamente.

Si los recursos Lovelace están en YAML, el actualizador instala el backend y prepara el JavaScript versionado, pero no modifica YAML. Después del reinicio, cambia manualmente la URL del único recurso a la URL versionada indicada en la notificación y recarga el navegador.

Las releases borrador, preliminares o sin ZIP, manifest, bundle y `SHA256SUMS` completos se ignoran. Los hashes detectan errores o cambios entre artefactos, pero no autentican por sí solos la cuenta que publica el repositorio.

## 8. Volver atrás

Mientras el actualizador pueda cargar, ejecuta el servicio administrador `liectroux_zk901.restore_previous_version`. En modo storage restaura la URL anterior existente; luego reinicia Home Assistant para cargar el backend restaurado. En modo YAML, actualiza la URL a la versión anterior según el aviso y reinicia.

Si la integración no llega a importarse y el servicio no está disponible, detén Home Assistant y restaura el backend desde `config/.liectroux_zk901_updater/backups/<respaldo>/backend/`. El frontend anterior se conserva en `frontend/` dentro del mismo respaldo. Restaura la URL del recurso anterior y vuelve a iniciar Home Assistant. Si la copia administrada tampoco existe, usa la copia externa preparada en el paso 2.

## Límites de distribución

El empaquetado genera archivos locales y los workflows guardan artefactos de build o los adjuntan a una release estable publicada por el propietario. Ejecutar build/package no publica una release, no hace push y no instala cambios en HA.
