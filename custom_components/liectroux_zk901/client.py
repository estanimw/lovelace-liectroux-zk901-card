"""Cliente local de la Liectroux ZK901.

Una instancia es dueña exclusiva del socket TinyTuya. Un solo hilo envía y
recibe. Las respuestas se correlacionan por ``infoType`` y, cuando el robot
lo incluye, por ``dInfo.ts``. ``21011`` se correlaciona por cursor y
``pathID``.

Codificación LAN confirmada: JSON → UTF-8 → Base64 → DP102.
Las credenciales llegan por el constructor. Este módulo no lee ``.env`` ni
importa Home Assistant.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import logging
import queue
import threading
import time
from collections.abc import Callable

FAN_SPEEDS = ("quiet", "auto", "strong")
_DP_PROPRIETARY = {"102", "107"}
_CONNECTION_ERRORS = {"901", "902", "905", "914"}
_IGNORED_PAYLOAD_ERROR = "904"
_LOGGER = logging.getLogger(__name__)
_AREA_TYPES = {"normal", "depth", "forbid"}
_MAX_AREA_TAG_LENGTH = 80
_MAX_AREA_VERTICES = 128
_MAX_SAFE_INTEGER = (1 << 53) - 1

_REDACTOR_LOCK = threading.Lock()
_SECRET_COUNTS: dict[str, int] = {}
_REDACTOR_SECRETS: tuple[str, ...] = ()
_REDACTOR_INSTALLED = False
_PREVIOUS_LOG_FACTORY: Callable[..., logging.LogRecord] | None = None


class ZK901Error(Exception):
    """Error de protocolo o de sesión con la ZK901."""


class ZK901Timeout(ZK901Error):
    """La operación no obtuvo la respuesta esperada a tiempo."""


class ZK901ConnectionError(ZK901Error):
    """El enlace local Tuya falló o el cliente está cerrado."""

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class ZK901ProtocolError(ZK901Error):
    """El robot respondió, pero el resultado no es aceptable."""


class ZK901AreaConflict(ZK901Error):
    """El catálogo cambió desde que el usuario abrió el editor."""

    def __init__(self, current: dict) -> None:
        super().__init__("El catálogo de zonas cambió; vuelve a cargarlo")
        self.current = current


class ZK901AreaUncertain(ZK901Error):
    """Se intentó guardar, pero no se pudo confirmar el resultado."""

    def __init__(self, phase: str) -> None:
        super().__init__("No se pudo confirmar el guardado; vuelve a leer el catálogo")
        self.phase = phase


class ZK901CleanUncertain(ZK901Error):
    """The spatial-clean command was sent but its compound ACK was lost."""

    def __init__(self, phase: str) -> None:
        super().__init__("No se pudo confirmar el inicio de limpieza; resultado incierto")
        self.phase = phase


def area_catalog_revision(catalog: dict) -> str:
    """Hash estable del mapId y la colección completa devuelta por 21004."""
    try:
        canonical = json.dumps(
            {"map_id": catalog["map_id"], "areas": catalog["areas"]},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (KeyError, TypeError, ValueError) as err:
        raise ZK901ProtocolError("El catálogo de zonas no se puede revisar") from err
    return hashlib.sha256(canonical).hexdigest()


def validate_area_tag(tag: object) -> str:
    if not isinstance(tag, str):
        raise ValueError("El nombre de la zona debe ser texto")
    tag = tag.strip()
    if not tag:
        raise ValueError("El nombre de la zona no puede estar vacío")
    if len(tag) > _MAX_AREA_TAG_LENGTH:
        raise ValueError(f"El nombre no puede superar {_MAX_AREA_TAG_LENGTH} caracteres")
    return tag


def validate_area_vertices(vertexs: object) -> list[list[int]]:
    """Valida un polígono simple y devuelve pares de coordenadas enteras."""
    if not isinstance(vertexs, list) or not 3 <= len(vertexs) <= _MAX_AREA_VERTICES:
        raise ValueError(f"La zona debe tener entre 3 y {_MAX_AREA_VERTICES} vértices")
    points: list[tuple[int, int]] = []
    for point in vertexs:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("Cada vértice debe contener x e y")
        x, y = point
        if (
            not isinstance(x, int)
            or isinstance(x, bool)
            or not isinstance(y, int)
            or isinstance(y, bool)
            or abs(x) > _MAX_SAFE_INTEGER
            or abs(y) > _MAX_SAFE_INTEGER
        ):
            raise ValueError("Las coordenadas deben ser enteros dentro del rango seguro")
        points.append((x, y))

    if len(set(points)) < 3:
        raise ValueError("La zona necesita tres vértices distintos")
    count = len(points)
    if any(points[i] == points[(i + 1) % count] for i in range(count)):
        raise ValueError("La zona no puede tener aristas de longitud cero")

    twice_area = sum(
        points[i][0] * points[(i + 1) % count][1]
        - points[(i + 1) % count][0] * points[i][1]
        for i in range(count)
    )
    if twice_area == 0:
        raise ValueError("La zona no puede tener área cero")

    def orientation(a: tuple[int, int], b: tuple[int, int], c: tuple[int, int]) -> int:
        cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return (cross > 0) - (cross < 0)

    def on_segment(
        a: tuple[int, int], b: tuple[int, int], point: tuple[int, int]
    ) -> bool:
        return (
            min(a[0], b[0]) <= point[0] <= max(a[0], b[0])
            and min(a[1], b[1]) <= point[1] <= max(a[1], b[1])
        )

    def intersects(
        a: tuple[int, int], b: tuple[int, int], c: tuple[int, int], d: tuple[int, int]
    ) -> bool:
        o1, o2 = orientation(a, b, c), orientation(a, b, d)
        o3, o4 = orientation(c, d, a), orientation(c, d, b)
        if o1 * o2 < 0 and o3 * o4 < 0:
            return True
        return (
            (o1 == 0 and on_segment(a, b, c))
            or (o2 == 0 and on_segment(a, b, d))
            or (o3 == 0 and on_segment(c, d, a))
            or (o4 == 0 and on_segment(c, d, b))
        )

    for i in range(count):
        a, b = points[i], points[(i + 1) % count]
        for j in range(i + 1, count):
            # Aristas consecutivas comparten el vértice de cierre por diseño.
            if j == i or j == i + 1 or (i == 0 and j == count - 1):
                continue
            c, d = points[j], points[(j + 1) % count]
            if intersects(a, b, c, d):
                raise ValueError("La zona no puede cruzarse ni tocarse a sí misma")
    return [[x, y] for x, y in points]


def _required_text(name: str, value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Falta {name}")
    return value.strip()


def decode_dp_payload(value: object) -> dict | None:
    """Decodifica un DP102/DP107 Base64 a un objeto JSON."""
    if not isinstance(value, str) or not value:
        return None
    try:
        text = base64.b64decode(value).decode("utf-8")
        obj = json.loads(text)
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def cleanable_areas(areas: object) -> list[dict]:
    """Zonas persistidas que se pueden elegir para limpiar.

    Se excluyen las prohibidas, los identificadores no positivos y los
    duplicados. ``forbid`` no se ofrece como zona limpiable.
    """
    if not isinstance(areas, list):
        return []
    chosen: list[dict] = []
    seen: set[int] = set()
    for area in areas:
        if not isinstance(area, dict) or area.get("active") == "forbid":
            continue
        area_id = area.get("id")
        if isinstance(area_id, bool) or not isinstance(area_id, int) or area_id <= 0:
            continue
        if area_id in seen:
            continue
        seen.add(area_id)
        chosen.append(area)
    return chosen


def validate_clean_area_ids(area_ids: object) -> list[int]:
    """Validate an ordered, non-empty list of persisted area identifiers."""
    if not isinstance(area_ids, list) or not area_ids:
        raise ValueError("area_ids debe ser una lista no vacía")
    normalized: list[int] = []
    seen: set[int] = set()
    for area_id in area_ids:
        if (
            not isinstance(area_id, int)
            or isinstance(area_id, bool)
            or area_id <= 0
        ):
            raise ValueError("cada area_id debe ser un entero positivo")
        if area_id in seen:
            raise ValueError(f"el area_id {area_id} está duplicado")
        seen.add(area_id)
        normalized.append(area_id)
    return normalized


def area_option(area: dict) -> str:
    """Etiqueta visible de una zona. El id final la hace única."""
    area_id = area.get("id")
    label = str(area.get("tag") or "").strip() or str(area.get("name") or "").strip()
    if label:
        return f"{label} [{area_id}]"
    return f"Zona {area_id}"


def _error_code(result: object) -> str | None:
    if isinstance(result, dict) and result.get("Err") is not None:
        return str(result.get("Err"))
    return None


def _redact_text(value: str) -> str:
    for secret in _REDACTOR_SECRETS:
        if secret and secret in value:
            value = value.replace(secret, "<redacted>")
    return value


def _redact_arg(item: object) -> object:
    if isinstance(item, str):
        return _redact_text(item)
    if isinstance(item, BaseException):
        rendered = _redact_text(str(item))
        if rendered != str(item):
            return rendered
    return item


def _redacting_factory(*args: object, **kwargs: object) -> logging.LogRecord:
    assert _PREVIOUS_LOG_FACTORY is not None
    record = _PREVIOUS_LOG_FACTORY(*args, **kwargs)
    if not _REDACTOR_SECRETS:
        return record
    if isinstance(record.msg, str):
        record.msg = _redact_text(record.msg)
    if isinstance(record.args, tuple):
        record.args = tuple(_redact_arg(item) for item in record.args)
    elif isinstance(record.args, dict):
        record.args = {
            key: _redact_arg(item) for key, item in record.args.items()
        }
    return record


def _register_secrets(*secrets: str) -> None:
    global _REDACTOR_INSTALLED, _PREVIOUS_LOG_FACTORY, _REDACTOR_SECRETS
    with _REDACTOR_LOCK:
        for secret in secrets:
            if not isinstance(secret, str) or len(secret) < 8:
                continue
            _SECRET_COUNTS[secret] = _SECRET_COUNTS.get(secret, 0) + 1
        _REDACTOR_SECRETS = tuple(_SECRET_COUNTS)
        if not _REDACTOR_INSTALLED:
            _PREVIOUS_LOG_FACTORY = logging.getLogRecordFactory()
            logging.setLogRecordFactory(_redacting_factory)
            _REDACTOR_INSTALLED = True


def _unregister_secrets(*secrets: str) -> None:
    global _REDACTOR_SECRETS
    with _REDACTOR_LOCK:
        for secret in secrets:
            if secret not in _SECRET_COUNTS:
                continue
            remaining = _SECRET_COUNTS[secret] - 1
            if remaining <= 0:
                del _SECRET_COUNTS[secret]
            else:
                _SECRET_COUNTS[secret] = remaining
        _REDACTOR_SECRETS = tuple(_SECRET_COUNTS)


class _Result:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.value: object = None
        self.error: BaseException | None = None

    def set_result(self, value: object) -> None:
        self.value = value
        self.event.set()

    def set_error(self, error: BaseException) -> None:
        self.error = error
        self.event.set()


def _match_info(info_type: int | str, request_ts: str) -> Callable[[dict], bool]:
    """Correlación por infoType y dInfo.ts cuando el robot lo envía."""
    expected_type = str(info_type)
    expected_ts = str(request_ts)

    def predicate(obj: dict) -> bool:
        if str(obj.get("infoType")) != expected_type:
            return False
        d_info = obj.get("dInfo")
        response_ts = d_info.get("ts") if isinstance(d_info, dict) else None
        if response_ts is None:
            return True
        return str(response_ts) == expected_ts

    return predicate


def _match_path(
    start_pos: int, expected_path_id: object
) -> Callable[[dict], bool]:
    def predicate(obj: dict) -> bool:
        if str(obj.get("infoType")) != "21011":
            return False
        data = obj.get("data")
        if not isinstance(data, dict) or data.get("startPos") != start_pos:
            return False
        if (
            expected_path_id is not None
            and data.get("pathID") != expected_path_id
        ):
            return False
        return True

    return predicate


def _require_ok(obj: dict, info_type: int | str) -> dict:
    if obj.get("message") != "ok":
        raise ZK901ProtocolError(
            f"infoType {info_type} rechazado: message={obj.get('message')!r}"
        )
    return obj


def _validate_compound(obj: dict) -> dict:
    if obj.get("message") != "ok":
        raise ZK901ProtocolError(
            f"30000 rechazado: message={obj.get('message')!r}"
        )
    data = obj.get("data")
    cmds = data.get("cmds") if isinstance(data, dict) else None
    if not isinstance(cmds, list):
        raise ZK901ProtocolError("30000 no incluye data.cmds")
    for child in cmds:
        if not isinstance(child, dict) or child.get("message") != "ok":
            info = child.get("infoType") if isinstance(child, dict) else None
            message = child.get("message") if isinstance(child, dict) else None
            raise ZK901ProtocolError(
                f"30000 hijo fallido: infoType={info} message={message!r}"
            )
    return obj


def _validate_path_chunk(data: dict) -> dict:
    point_counts = data.get("pointCounts")
    pos_array = data.get("posArray")
    if (
        not isinstance(point_counts, int)
        or isinstance(point_counts, bool)
        or not isinstance(pos_array, list)
        or point_counts != len(pos_array)
    ):
        raise ZK901ProtocolError(
            "21011 pointCounts no coincide con la longitud de posArray"
        )
    return data


class ZK901Client:
    """Sesión LAN con una ZK901. El acceso al socket está serializado."""

    def __init__(
        self,
        *,
        device_id: str,
        address: str,
        local_key: str,
        uid: str,
        sn: str,
        version: float = 3.3,
        device: object | None = None,
        socket_timeout: float = 0.5,
        heartbeat_interval: float = 10.0,
    ) -> None:
        self._device_id = _required_text("device_id", device_id)
        self._address = _required_text("address", address)
        self._local_key = _required_text("local_key", local_key)
        self._uid = _required_text("uid", uid)
        self._sn = _required_text("sn", sn)
        self._version = float(version)
        self._socket_timeout = socket_timeout
        self._heartbeat_interval = heartbeat_interval
        self._secrets = (self._device_id, self._local_key, self._uid, self._sn)
        _register_secrets(*self._secrets)

        if device is None:
            import tinytuya
            from tinytuya.core import message_helper

            # 21004 con varias zonas supera el límite conservador de TinyTuya.
            message_helper.MAX_PAYLOAD_LENGTH = max(
                message_helper.MAX_PAYLOAD_LENGTH, 16 * 1024
            )

            device = tinytuya.Device(
                dev_id=self._device_id,
                address=self._address,
                local_key=self._local_key,
                version=self._version,
                persist=True,
            )
        self._device = device
        self._queue: queue.Queue[tuple[Callable[[], object], _Result] | None] = (
            queue.Queue()
        )
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._status: dict = {}
        self._status_listener: Callable[[dict], None] | None = None
        self._connection_listener: Callable[[bool], None] | None = None
        self._online = False
        self._backoff = 1.0
        self._last_heartbeat = time.monotonic()
        self._last_ts = 0
        self._closed = False

    def set_status_listener(self, listener: Callable[[dict], None] | None) -> None:
        """Recibe cada ``20001`` ya decodificado, espontáneo o solicitado."""
        self._status_listener = listener

    def set_connection_listener(
        self, listener: Callable[[bool], None] | None
    ) -> None:
        """Recibe transiciones de enlace: True al recuperar, False al perder."""
        self._connection_listener = listener

    @property
    def status(self) -> dict:
        return dict(self._status)

    def connect(self) -> None:
        if self._closed:
            raise ZK901ConnectionError("El cliente está cerrado", code="closed")
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._device.set_socketPersistent(True)
        self._device.set_socketTimeout(self._socket_timeout)
        self._device.set_socketRetryLimit(1)
        self._device.set_socketRetryDelay(0.2)
        self._last_heartbeat = time.monotonic()
        self._thread = threading.Thread(
            target=self._worker,
            name="zk901-link",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self._closed = True
        self._status_listener = None
        self._connection_listener = None
        self._stop.set()
        self._queue.put(None)
        try:
            self._device.close()
        except Exception:
            _LOGGER.debug("error al cerrar el socket", exc_info=True)
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
            if thread.is_alive():
                _LOGGER.warning("el hilo de conexión no terminó al cerrar")
        _unregister_secrets(*self._secrets)

    def get_status(self, timeout: float = 5.0) -> dict:
        return self._call(lambda: self._get_status(timeout), timeout)

    def get_path_chunk(
        self,
        start_pos: int,
        *,
        mask: int = 0,
        expected_path_id: object = None,
        timeout: float = 5.0,
    ) -> dict:
        return self._call(
            lambda: self._get_path_chunk(
                start_pos,
                mask=mask,
                expected_path_id=expected_path_id,
                timeout=timeout,
            ),
            timeout,
        )

    def set_volume(self, value: int) -> None:
        self._call(lambda: self._set_volume(value), timeout=5)

    def set_led(self, enabled: bool) -> None:
        self._call(lambda: self._set_led(enabled), timeout=5)

    def start(self, timeout: float = 5.0) -> None:
        """Limpieza total. Si el último mode es ``pause``, continúa la sesión."""
        self._call(lambda: self._start(timeout), timeout)

    def return_to_base(self) -> None:
        self._call(self._return_to_base, timeout=5)

    def stop(self, timeout: float = 5.0) -> None:
        """Detiene la tarea actual. No es volver a la base."""
        self._call(lambda: self._stop_task(timeout), timeout)

    def pause(self, timeout: float = 5.0) -> None:
        self._call(lambda: self._pause(timeout), timeout)

    def resume(self, timeout: float = 5.0) -> None:
        self._call(lambda: self._resume(timeout), timeout)

    def drive(self, direction: str, duration: float = 0.3) -> None:
        self._call(lambda: self._drive(direction, duration), timeout=duration + 5)

    def clean_current_position(self) -> None:
        """Limpieza alrededor de la posición actual: ``21020`` ``ctrlCode=3001``."""
        self._call(self._clean_current_position, timeout=5)

    def set_cleaning_level(self, level: str, timeout: float = 5.0) -> None:
        self._call(lambda: self._set_cleaning_level(level, timeout), timeout)

    def get_areas(self, timeout: float = 5.0) -> dict:
        return self._call(lambda: self._get_areas(timeout), timeout)

    def apply_area_edit(
        self,
        *,
        base_map_id: object,
        base_revision: str,
        operation: str,
        area_id: int | None = None,
        tag: str | None = None,
        active: str | None = None,
        vertexs: list | None = None,
        timeout: float = 10.0,
    ) -> dict:
        """Aplica un único cambio contra la revisión que editó el usuario."""
        return self._call(
            lambda: self._apply_area_edit(
                base_map_id=base_map_id,
                base_revision=base_revision,
                operation=operation,
                area_id=area_id,
                tag=tag,
                active=active,
                vertexs=vertexs,
                timeout=timeout,
            ),
            timeout=timeout * 4 + 1,
        )

    def save_areas(self, areas: list, map_id: object, timeout: float = 5.0) -> dict:
        return self._call(
            lambda: self._save_areas(areas, map_id, timeout),
            timeout,
        )

    def create_area(
        self,
        tag: str,
        vertexs: list,
        active: str = "normal",
        area_id: int | None = None,
        timeout: float = 5.0,
    ) -> dict:
        return self._call(
            lambda: self._create_area(tag, vertexs, active, area_id, timeout),
            timeout,
        )

    def update_area(
        self,
        area_id: int,
        *,
        tag: str | None = None,
        active: str | None = None,
        vertexs: list | None = None,
        timeout: float = 5.0,
    ) -> dict:
        return self._call(
            lambda: self._update_area(
                area_id,
                tag=tag,
                active=active,
                vertexs=vertexs,
                timeout=timeout,
            ),
            timeout,
        )

    def delete_area(self, area_id: int, timeout: float = 5.0) -> dict:
        return self._call(lambda: self._delete_area(area_id, timeout), timeout)

    def clean_area(self, area_id: int, timeout: float = 5.0) -> dict:
        return self.clean_areas([area_id], timeout=timeout)

    def clean_areas(self, area_ids: list[int], timeout: float = 10.0) -> dict:
        """Limpia una selección completa con un solo 30000."""
        return self._call(
            lambda: self._clean_areas(area_ids, timeout),
            timeout=timeout * 2 + 2,
        )

    def clean_area_by_name(self, tag: str, timeout: float = 5.0) -> dict:
        return self._call(lambda: self._clean_area_by_name(tag, timeout), timeout)

    def full_clean_spatial(self, timeout: float = 5.0) -> dict:
        return self._call(lambda: self._full_clean_spatial(timeout), timeout)

    def _call(self, fn: Callable[[], object], timeout: float) -> object:
        if threading.current_thread() is self._thread:
            raise RuntimeError("no reentrar en el hilo de la conexión")
        thread = self._thread
        if self._closed or thread is None or not thread.is_alive():
            raise ZK901ConnectionError("El cliente no está conectado", code="closed")
        box = _Result()
        self._queue.put((fn, box))
        if not box.event.wait(max(timeout, 0) + 30):
            raise ZK901Timeout("La operación no terminó a tiempo")
        if box.error is not None:
            raise box.error
        return box.value

    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._queue.get(timeout=0.05)
            except queue.Empty:
                self._idle_once()
                continue
            if job is None:
                return
            fn, box = job
            try:
                box.set_result(fn())
            except Exception as err:
                box.set_error(err)
        _LOGGER.debug("hilo de conexión detenido")

    def _idle_once(self) -> None:
        now = time.monotonic()
        if now - self._last_heartbeat >= self._heartbeat_interval:
            try:
                result = self._device.heartbeat(nowait=True)
                self._check_send_result(result)
                self._last_heartbeat = now
            except ZK901ConnectionError:
                self._backoff_sleep()
                return
            except Exception:
                _LOGGER.debug("heartbeat falló", exc_info=True)
                self._backoff_sleep()
                return
        try:
            event = self._device.receive()
            self._dispatch(event, None)
        except ZK901ConnectionError:
            self._backoff_sleep()
        except Exception:
            if self._stop.is_set():
                return
            _LOGGER.debug("receive falló", exc_info=True)
            self._backoff_sleep()

    def _backoff_sleep(self) -> None:
        self._mark_offline()
        delay = self._backoff
        self._backoff = min(self._backoff * 2, 30.0)
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            if self._stop.is_set() or not self._queue.empty():
                return
            self._stop.wait(0.1)

    def _mark_online(self) -> None:
        self._backoff = 1.0
        if self._online:
            return
        self._online = True
        listener = self._connection_listener
        if listener is not None:
            try:
                listener(True)
            except Exception:
                _LOGGER.exception("connection listener falló")

    def _mark_offline(self) -> None:
        if not self._online:
            return
        self._online = False
        listener = self._connection_listener
        if listener is not None:
            try:
                listener(False)
            except Exception:
                _LOGGER.exception("connection listener falló")

    def _check_send_result(self, result: object) -> None:
        code = _error_code(result)
        if code is None:
            self._mark_online()
            return
        if code == _IGNORED_PAYLOAD_ERROR:
            return
        if code in _CONNECTION_ERRORS:
            self._mark_offline()
            raise ZK901ConnectionError(
                "No hay conexión local con el robot",
                code=code,
            )
        _LOGGER.debug("respuesta de transporte no clasificada code=%s", code)

    def _dispatch(self, event: object, predicate: Callable[[dict], bool] | None):
        if self._stop.is_set() and event is None:
            return None
        if event is None or not isinstance(event, dict):
            return None
        code = _error_code(event)
        if code is not None:
            if code == _IGNORED_PAYLOAD_ERROR:
                return None
            if code in _CONNECTION_ERRORS:
                self._mark_offline()
                raise ZK901ConnectionError(
                    "No hay conexión local con el robot",
                    code=code,
                )
            _LOGGER.debug("evento tuya ignorado code=%s", code)
            return None
        dps = event.get("dps")
        if not isinstance(dps, dict):
            return None
        matched = None
        saw_logical = False
        for dp, value in dps.items():
            if str(dp) not in _DP_PROPRIETARY:
                continue
            obj = decode_dp_payload(value)
            if obj is None:
                continue
            saw_logical = True
            self._observe(obj)
            if predicate is not None and matched is None and predicate(obj):
                matched = obj
        if saw_logical:
            self._mark_online()
        return matched

    def _observe(self, obj: dict) -> None:
        info_type = str(obj.get("infoType"))
        if info_type == "20001":
            data = obj.get("data")
            if isinstance(data, dict):
                stored = dict(data)
                self._status = stored
                listener = self._status_listener
                if listener is not None:
                    try:
                        listener(stored)
                    except Exception:
                        _LOGGER.exception("status listener falló")
            return
        _LOGGER.debug(
            "evento infoType=%s message=%s",
            info_type,
            obj.get("message"),
        )

    def _wait_for(
        self, predicate: Callable[[dict], bool], timeout: float
    ) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            if self._stop.is_set():
                raise ZK901ConnectionError("El cliente está cerrado", code="closed")
            if time.monotonic() >= deadline:
                raise ZK901Timeout("Tiempo de espera agotado esperando respuesta")
            try:
                event = self._device.receive()
            except ZK901ConnectionError:
                raise
            except Exception as err:
                raise ZK901ConnectionError(
                    "No hay conexión local con el robot",
                    code="901",
                ) from err
            matched = self._dispatch(event, predicate)
            if matched is not None:
                return matched

    def _next_ts(self) -> str:
        """Marca de correlación en milisegundos, única dentro de la sesión."""
        now = int(time.time() * 1000)
        if now <= self._last_ts:
            now = self._last_ts + 1
        self._last_ts = now
        return str(now)

    def _envelope(
        self,
        info_type: int,
        data: dict,
        connection_type: int,
        request_ts: str | None = None,
    ) -> tuple[dict, str]:
        if request_ts is None:
            request_ts = self._next_ts()
        payload = {
            "connectionType": connection_type,
            "dInfo": {
                "ts": request_ts,
                "userId": self._uid,
            },
            "data": {
                "userId": self._uid,
                "sn": self._sn,
                **data,
            },
            "infoType": info_type,
        }
        return payload, request_ts

    def _send_payload(self, payload: dict) -> None:
        raw_json = json.dumps(payload, separators=(",", ":"))
        encoded = base64.b64encode(raw_json.encode("utf-8")).decode("ascii")
        _LOGGER.debug(
            "envío infoType=%s bytes=%s",
            payload.get("infoType"),
            len(encoded),
        )
        result = self._device.set_value(102, encoded, nowait=True)
        self._check_send_result(result)

    def _send_command(
        self,
        info_type: int,
        data: dict,
        *,
        connection_type: int = 1,
        timeout: float | None = None,
        require_ok: bool = False,
    ) -> dict | None:
        payload, request_ts = self._envelope(info_type, data, connection_type)
        self._send_payload(payload)
        if timeout is None:
            return None
        obj = self._wait_for(_match_info(info_type, request_ts), timeout)
        if require_ok:
            _require_ok(obj, info_type)
        return obj

    def _set_dp3(self, value: str) -> None:
        _LOGGER.debug("envío dp3=%s", value)
        result = self._device.set_value(3, value, nowait=True)
        self._check_send_result(result)

    def _get_status(self, timeout: float) -> dict:
        obj = self._send_command(20001, {}, timeout=timeout)
        assert obj is not None
        data = obj.get("data")
        if not isinstance(data, dict):
            raise ZK901ProtocolError("20001 no contiene data")
        return data

    def _get_path_chunk(
        self,
        start_pos: int,
        *,
        mask: int,
        expected_path_id: object,
        timeout: float,
    ) -> dict:
        if (
            not isinstance(start_pos, int)
            or isinstance(start_pos, bool)
            or start_pos < 0
        ):
            raise ValueError("start_pos debe ser un entero no negativo")
        if not isinstance(mask, int) or isinstance(mask, bool) or mask not in (0, 1):
            raise ValueError("mask debe ser 0 o 1")
        self._send_command(
            21011,
            {"startPos": start_pos, "mask": mask},
            connection_type=2,
        )
        obj = self._wait_for(_match_path(start_pos, expected_path_id), timeout)
        data = obj.get("data")
        if not isinstance(data, dict):
            raise ZK901ProtocolError("21011 no contiene data")
        return _validate_path_chunk(data)

    def _set_volume(self, value: int) -> None:
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 1 <= value <= 10
        ):
            raise ValueError("el volumen debe estar entre 1 y 10")
        self._send_command(21024, {"cmd": "setVolume", "value": value})

    def _set_led(self, enabled: bool) -> None:
        self._send_command(
            21024,
            {"cmd": "setledswitch", "value": 1 if enabled else 0},
        )

    def _start(self, timeout: float) -> None:
        if self._status.get("mode") == "pause":
            self._resume(timeout)
            return
        self._set_dp3("smart")

    def _return_to_base(self) -> None:
        self._set_dp3("chargego")

    def _stop_task(self, timeout: float) -> None:
        self._send_command(21012, {"cmd": "stop"}, timeout=timeout, require_ok=True)

    def _pause(self, timeout: float) -> None:
        self._send_command(21017, {"cmd": "pause"}, timeout=timeout, require_ok=True)

    def _resume(self, timeout: float) -> None:
        self._send_command(
            21017, {"cmd": "continue"}, timeout=timeout, require_ok=True
        )

    def _drive(self, direction: str, duration: float) -> None:
        codes = {
            "forward": 3005,
            "backward": 3006,
            "left": 3007,
            "right": 3008,
        }
        if direction not in codes:
            raise ValueError("direction debe ser forward, backward, left o right")
        if duration <= 0:
            raise ValueError("duration debe ser mayor que 0")
        if duration > 2.0:
            raise ValueError("duration máxima: 2.0 segundos")
        ctrl_code = codes[direction]
        started = time.monotonic()
        next_send = started
        sent = 0
        while time.monotonic() - started < duration:
            now = time.monotonic()
            if now >= next_send:
                self._send_command(21020, {"ctrlCode": ctrl_code})
                sent += 1
                next_send += 0.05
            remaining = next_send - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
        _LOGGER.debug("drive direction=%s packets=%s", direction, sent)

    def _clean_current_position(self) -> None:
        self._send_command(21020, {"ctrlCode": 3001})

    def _set_cleaning_level(self, level: str, timeout: float) -> None:
        if level not in FAN_SPEEDS:
            raise ValueError("level debe ser quiet, auto o strong")
        self._send_command(21022, {"cmd": level}, timeout=timeout, require_ok=True)

    def _get_areas(self, timeout: float) -> dict:
        # 21004 puede devolver un catálogo grande. El controlador LAN validado
        # usa el timeout de socket de TinyTuya (5 s) para leer cada fragmento.
        self._device.set_socketTimeout(5.0)
        try:
            obj = self._send_command(21004, {}, timeout=timeout, require_ok=True)
        finally:
            self._device.set_socketTimeout(self._socket_timeout)
        assert obj is not None
        data = obj.get("data")
        if not isinstance(data, dict) or data.get("mapId") is None:
            raise ZK901ProtocolError("21004 no contiene data.mapId")
        areas = data.get("value")
        if not isinstance(areas, list):
            raise ZK901ProtocolError("21004 data.value no es una lista")
        return {"map_id": data["mapId"], "areas": areas}

    def _apply_area_edit(
        self,
        *,
        base_map_id: object,
        base_revision: str,
        operation: str,
        area_id: int | None,
        tag: str | None,
        active: str | None,
        vertexs: list | None,
        timeout: float,
    ) -> dict:
        current = self._get_areas(timeout)
        current_revision = area_catalog_revision(current)
        if (
            current["map_id"] != base_map_id
            or current_revision != base_revision
        ):
            raise ZK901AreaConflict(
                {**current, "revision": current_revision}
            )

        areas = copy.deepcopy(current["areas"])
        if operation == "create":
            if area_id is not None:
                raise ValueError("El ID de una zona nueva lo asigna la integración")
            new_tag = validate_area_tag(tag)
            if not isinstance(active, str) or active not in _AREA_TYPES:
                raise ValueError("active debe ser normal, depth o forbid")
            polygon = validate_area_vertices(vertexs)
            used_ids = {
                item.get("id")
                for item in areas
                if isinstance(item, dict)
                and isinstance(item.get("id"), int)
                and not isinstance(item.get("id"), bool)
                and item["id"] > 0
            }
            new_id = next(
                (candidate for candidate in range(1, len(used_ids) + 2) if candidate not in used_ids),
                None,
            )
            if new_id is None:
                raise ValueError("No se pudo asignar un ID libre")
            target = {
                "name": "",
                "tag": new_tag,
                "active": active,
                "vertexs": polygon,
                "id": new_id,
            }
            areas.append(target)
        elif operation in ("update", "delete"):
            if (
                not isinstance(area_id, int)
                or isinstance(area_id, bool)
                or area_id <= 0
            ):
                raise ValueError("area_id debe ser un entero positivo")
            matches = [
                index
                for index, item in enumerate(areas)
                if isinstance(item, dict) and item.get("id") == area_id
            ]
            if len(matches) != 1:
                if not matches:
                    raise ValueError(f"La zona {area_id} no existe")
                raise ValueError(f"El ID {area_id} está duplicado en el catálogo")
            index = matches[0]
            if operation == "delete":
                if any(value is not None for value in (tag, active, vertexs)):
                    raise ValueError("Eliminar una zona no acepta otros campos")
                areas.pop(index)
                target = None
            else:
                if tag is None and active is None and vertexs is None:
                    raise ValueError("La edición no contiene cambios")
                target = areas[index]
                if tag is not None:
                    target["tag"] = validate_area_tag(tag)
                if active is not None:
                    if not isinstance(active, str) or active not in _AREA_TYPES:
                        raise ValueError("active debe ser normal, depth o forbid")
                    target["active"] = active
                if vertexs is not None:
                    target["vertexs"] = validate_area_vertices(vertexs)
        else:
            raise ValueError("operation debe ser create, update o delete")

        if areas == current["areas"]:
            return {
                **current,
                "revision": current_revision,
                "operation": operation,
                "area_id": area_id,
            }

        # El catálogo ya fue leído y comparado. Desde el primer envío cualquier
        # timeout puede dejar el resultado en estado desconocido.
        try:
            self._send_command(
                21003,
                {"mapId": current["map_id"], "value": areas},
                timeout=timeout,
                require_ok=True,
            )
        except (ZK901Timeout, ZK901ConnectionError) as err:
            raise ZK901AreaUncertain("save") from err

        try:
            self._send_command(
                21023,
                {"mapId": current["map_id"], "cleanId": [-3], "extraAreas": []},
                connection_type=0,
                timeout=timeout,
                require_ok=True,
            )
            verified = self._get_areas(timeout)
        except Exception as err:
            raise ZK901AreaUncertain("refresh_or_verify") from err

        try:
            verified_revision = area_catalog_revision(verified)
            expected_revision = area_catalog_revision(
                {"map_id": current["map_id"], "areas": areas}
            )
        except ZK901Error as err:
            raise ZK901AreaUncertain("verify") from err
        if verified_revision != expected_revision:
            raise ZK901AreaUncertain("verify")
        return {
            **verified,
            "revision": verified_revision,
            "operation": operation,
            "area_id": target.get("id") if isinstance(target, dict) else area_id,
        }

    def _save_areas(self, areas: list, map_id: object, timeout: float) -> dict:
        save_response = self._send_command(
            21003,
            {"mapId": map_id, "value": areas},
            timeout=timeout,
            require_ok=True,
        )
        refresh_response = self._send_command(
            21023,
            {"mapId": map_id, "cleanId": [-3], "extraAreas": []},
            connection_type=0,
            timeout=timeout,
            require_ok=True,
        )
        return {"save": save_response, "refresh": refresh_response}

    def _create_area(
        self,
        tag: str,
        vertexs: list,
        active: str,
        area_id: int | None,
        timeout: float,
    ) -> dict:
        if active not in ("normal", "depth", "forbid"):
            raise ValueError("active debe ser normal, depth o forbid")
        state = self._get_areas(timeout)
        areas = state["areas"]
        existing_ids = [
            area["id"]
            for area in areas
            if isinstance(area.get("id"), int)
            and not isinstance(area.get("id"), bool)
            and area["id"] > 0
        ]
        if area_id is None:
            area_id = max(existing_ids, default=0) + 1
        elif (
            not isinstance(area_id, int)
            or isinstance(area_id, bool)
            or area_id <= 0
        ):
            raise ValueError("area_id debe ser un entero positivo")
        elif any(area.get("id") == area_id for area in areas):
            raise ValueError(f"la zona {area_id} ya existe")
        new_area = {
            "name": "",
            "active": active,
            "vertexs": vertexs,
            "id": area_id,
            "tag": tag,
        }
        areas.append(new_area)
        self._save_areas(areas, state["map_id"], timeout)
        return new_area

    def _update_area(
        self,
        area_id: int,
        *,
        tag: str | None,
        active: str | None,
        vertexs: list | None,
        timeout: float,
    ) -> dict:
        if active is not None and active not in ("normal", "depth", "forbid"):
            raise ValueError("active debe ser normal, depth o forbid")
        state = self._get_areas(timeout)
        areas = [dict(area) for area in state["areas"]]
        area = next((item for item in areas if item.get("id") == area_id), None)
        if area is None:
            raise ValueError(f"la zona {area_id} no existe")
        if tag is not None:
            area["tag"] = tag
        if active is not None:
            area["active"] = active
        if vertexs is not None:
            area["vertexs"] = vertexs
        self._save_areas(areas, state["map_id"], timeout)
        return area

    def _delete_area(self, area_id: int, timeout: float) -> dict:
        state = self._get_areas(timeout)
        areas = [dict(area) for area in state["areas"]]
        index = next(
            (
                position
                for position, area in enumerate(areas)
                if area.get("id") == area_id
            ),
            None,
        )
        if index is None:
            raise ValueError(f"la zona {area_id} no existe")
        areas.pop(index)
        return self._save_areas(areas, state["map_id"], timeout)

    def _clean_area(self, area_id: int, timeout: float) -> dict:
        return self._clean_areas([area_id], timeout)

    def _clean_areas(self, area_ids: object, timeout: float) -> dict:
        requested = validate_clean_area_ids(area_ids)
        state = self._get_areas(timeout)
        resolved: list[int] = []
        for area_id in requested:
            matches = [
                area
                for area in state["areas"]
                if isinstance(area, dict) and area.get("id") == area_id
            ]
            if not matches:
                raise ValueError(f"la zona {area_id} no existe en el catálogo actual")
            if len(matches) != 1:
                raise ValueError(f"el ID {area_id} está duplicado en el catálogo")
            area = matches[0]
            active = area.get("active")
            if active == "forbid":
                raise ValueError(f"la zona {area_id} está prohibida y no se puede limpiar")
            if active not in {"normal", "depth"}:
                raise ValueError(f"el tipo de la zona {area_id} no admite limpieza")
            resolved.append(area_id)
        return self._start_spatial_clean(
            map_id=state["map_id"],
            clean_ids=[*resolved, -3],
            timeout=timeout,
        )

    def _clean_area_by_name(self, tag: str, timeout: float) -> dict:
        state = self._get_areas(timeout)
        matches = [area for area in state["areas"] if area.get("tag") == tag]
        if not matches:
            raise ValueError(f"ninguna zona tiene el nombre {tag!r}")
        if len(matches) > 1:
            raise ValueError(f"varias zonas tienen el nombre {tag!r}")
        area = matches[0]
        return self._clean_areas([area.get("id")], timeout)

    def _full_clean_spatial(self, timeout: float) -> dict:
        state = self._get_areas(timeout)
        return self._start_spatial_clean(
            map_id=state["map_id"],
            clean_ids=[-1, -3],
            timeout=timeout,
        )

    def _start_spatial_clean(
        self,
        map_id: object,
        clean_ids: list,
        extra_areas: list | None = None,
        timeout: float = 5.0,
    ) -> dict:
        request_ts = self._next_ts()

        def make_request(info_type: int, data: dict, connection_type: int) -> dict:
            return {
                "connectionType": connection_type,
                "dInfo": {
                    "ts": request_ts,
                    "userId": self._uid,
                },
                "data": {
                    "userId": self._uid,
                    "sn": self._sn,
                    **data,
                },
                "infoType": info_type,
            }

        payload = make_request(
            30000,
            {
                "cmds": [
                    make_request(
                        21023,
                        {
                            "mapId": map_id,
                            "cleanId": clean_ids,
                            "extraAreas": extra_areas or [],
                        },
                        0,
                    ),
                    make_request(21005, {"mode": "reAppointClean"}, 0),
                ]
            },
            1,
        )
        try:
            self._send_payload(payload)
        except Exception as err:
            raise ZK901CleanUncertain("send") from err
        try:
            response = self._wait_for(_match_info(30000, request_ts), timeout)
        except (ZK901Timeout, ZK901ConnectionError) as err:
            raise ZK901CleanUncertain("ack") from err
        return _validate_compound(response)
