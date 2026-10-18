# Instalar en Home Assistant Container

Esta guía instala en pareja la custom integration y la tarjeta, conservando la entrada ZK901, las entidades, zonas y credenciales que ya existen. El objetivo probado es Home Assistant 2026.9.2 con Python 3.14. No instala nada por HACS y no modifica `.storage`.

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

No se ha publicado una release de GitHub desde este cambio. Para obtener un paquete de otra fuente, debe ser una release que incluya conjuntamente el ZIP, su manifest y `SHA256SUMS`.

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
/local/liectroux-zk901/liectroux-zk901-map-card.js?v=0.2.0
```

Tipo: **JavaScript module**. Usa como `v` el `card_version` de `release-manifest.json` para evitar caché vieja. Mantén un solo recurso para este archivo. No retires todavía el recurso del editor anterior.

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

## 7. Actualizar

Genera y verifica el nuevo ZIP; conserva la versión instalada y repite los pasos 2–4. Extrae en la misma raíz de configuración, reinicia Home Assistant si cambió integración Python y actualiza `v` al frontend nuevo. No borres la entrada de configuración, el dispositivo ni las entidades. Una pareja frontend/backend debe proceder del mismo ZIP y compatibilidad manifest.

## 8. Volver atrás

Restaura la carpeta de integración y el JavaScript guardados en el paso 2. Restaura la URL anterior del recurso o su versión de caché y reinicia Home Assistant para volver a cargar Python. Si añadiste una tarjeta nueva a prueba, quítala de esa vista; puedes seguir usando la tarjeta/editor anterior. No elimines la integración ni sus credenciales.

## Límites de distribución

El empaquetado genera archivos locales y los workflows guardan artefactos de build o los adjuntan a una release creada por el propietario. Ejecutar build/package no publica una release, no hace push y no instala cambios en HA.
