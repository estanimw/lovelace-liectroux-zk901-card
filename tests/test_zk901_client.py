"""Pruebas del cliente ZK901 con mensajes simulados.

No abre red ni habla con el robot. Comprueba la codificación DP102, la
correlación de respuestas y los errores de un 30000 con hijos fallidos.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import logging
import queue
import threading
from pathlib import Path

import pytest

_CLIENT_PATH = (
    Path(__file__).resolve().parents[1]
    / "custom_components"
    / "liectroux_zk901"
    / "client.py"
)
_SPEC = importlib.util.spec_from_file_location("zk901_client_under_test", _CLIENT_PATH)
assert _SPEC is not None and _SPEC.loader is not None
client_mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(client_mod)

UID = "uid-value-123456"
SN = "sn-value-12345678"
DEVICE_ID = "device-id-123456"
LOCAL_KEY = "local-key-123456"


def dp_event(obj: dict, dp: str = "102") -> dict:
    raw = base64.b64encode(
        json.dumps(obj, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    return {"dps": {dp: raw}}


def decode_sent(raw_b64: str) -> dict:
    return json.loads(base64.b64decode(raw_b64).decode("utf-8"))


class FakeDevice:
    def __init__(self, handler) -> None:
        self.handler = handler
        self.sent: list[tuple] = []
        self.connection_timeout = 5
        self._incoming: queue.Queue = queue.Queue()
        self.closed = False

    def set_socketPersistent(self, persist: bool) -> None:
        self.persist = persist

    def set_socketTimeout(self, seconds: float) -> None:
        self.connection_timeout = seconds

    def set_socketRetryLimit(self, limit: int) -> None:
        self.retry_limit = limit

    def set_socketRetryDelay(self, delay: float) -> None:
        self.retry_delay = delay

    def heartbeat(self, nowait: bool = True):
        self.sent.append(("heartbeat", nowait))
        return None

    def close(self) -> None:
        self.closed = True

    def push(self, event) -> None:
        self._incoming.put(event)

    def set_value(self, index, value, nowait: bool = False):
        self.sent.append((index, value, nowait))
        if str(index) == "102":
            logical = decode_sent(value)
            for message in self.handler(logical):
                self.push(message if "dps" in message or "Err" in message else dp_event(message))
        return None

    def receive(self):
        try:
            return self._incoming.get(timeout=self.connection_timeout)
        except queue.Empty:
            if self.closed:
                return {"Err": "905", "Error": "offline"}
            return None


def make_client(device: FakeDevice, **kwargs):
    client = client_mod.ZK901Client(
        device_id=DEVICE_ID,
        address="192.0.2.20",
        local_key=LOCAL_KEY,
        uid=UID,
        sn=SN,
        device=device,
        socket_timeout=0.05,
        heartbeat_interval=3600,
        **kwargs,
    )
    client.connect()
    return client


@pytest.fixture
def linked():
    holder: dict = {}

    def handler(obj):
        return holder["handler"](obj)

    device = FakeDevice(handler)
    holder["handler"] = lambda obj: []
    robot = make_client(device)
    try:
        yield robot, device, holder
    finally:
        robot.close()


def _ok(info_type, ts, data=None, message="ok"):
    return {
        "message": message,
        "infoType": info_type,
        "dInfo": {"ts": ts, "userId": UID},
        "data": {} if data is None else data,
    }


def test_dp102_is_utf8_json_base64_not_hex(linked):
    robot, device, holder = linked

    def handler(obj):
        return [_ok(21022, obj["dInfo"]["ts"])]

    holder["handler"] = handler
    robot.set_cleaning_level("quiet")

    index, raw, nowait = device.sent[-1]
    assert index == 102
    assert nowait is True
    logical = decode_sent(raw)
    assert logical["infoType"] == 21022
    assert logical["data"]["cmd"] == "quiet"
    assert logical["data"]["userId"] == UID
    assert logical["data"]["sn"] == SN
    assert logical["dInfo"]["userId"] == UID
    text = base64.b64decode(raw)
    assert text.startswith(b"{")
    assert b"quiet" in text


def test_status_keeps_spontaneous_update_and_returns_matching_ts(linked):
    robot, device, holder = linked
    seen: list[str] = []
    robot.set_status_listener(lambda status: seen.append(status["mode"]))

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        return [
            _ok(20001, "otro-ts", {"mode": "sweep", "elec": 80}),
            {"Err": "904"},
            _ok(20001, ts, {"mode": "pause", "elec": 81}),
        ]

    holder["handler"] = handler
    status = robot.get_status(timeout=2)

    assert status["mode"] == "pause"
    assert seen == ["sweep", "pause"]
    assert robot.status["mode"] == "pause"


def test_parallel_status_queries_do_not_share_a_response(linked):
    robot, _device, holder = linked

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        return [_ok(20001, ts, {"mode": "charge", "marker": ts, "elec": 70})]

    holder["handler"] = handler
    results: list[dict | None] = [None, None]

    def run(index: int) -> None:
        results[index] = robot.get_status(timeout=2)

    threads = [threading.Thread(target=run, args=(index,)) for index in (0, 1)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert results[0] is not None and results[1] is not None
    assert results[0]["marker"] != results[1]["marker"]


def test_area_query_does_not_consume_status_and_zone_clean_checks_children(linked):
    robot, device, holder = linked
    seen: list[str] = []
    robot.set_status_listener(lambda status: seen.append(status["mode"]))

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            assert device.connection_timeout == 5.0
            return [
                _ok(20001, "espontaneo", {"mode": "charge", "elec": 100}),
                _ok(
                    21004,
                    ts,
                    {
                        "mapId": 336,
                        "value": [
                            {"id": 1, "tag": "Cocina", "active": "normal"},
                            {"id": 2, "tag": "Bloqueo", "active": "forbid"},
                        ],
                    },
                ),
            ]
        if obj["infoType"] == 30000:
            cmds = obj["data"]["cmds"]
            assert [item["infoType"] for item in cmds] == [21023, 21005]
            assert cmds[0]["connectionType"] == 0
            assert cmds[1]["connectionType"] == 0
            assert cmds[0]["data"]["mapId"] == 336
            assert cmds[0]["data"]["cleanId"] == [1, -3]
            assert cmds[1]["data"]["mode"] == "reAppointClean"
            return [
                _ok(
                    30000,
                    ts,
                    {
                        "cmds": [
                            {"message": "ok", "infoType": 21023},
                            {"message": "ok", "infoType": 21005},
                        ]
                    },
                )
            ]
        raise AssertionError(obj["infoType"])

    holder["handler"] = handler
    response = robot.clean_area(1, timeout=2)

    assert response["message"] == "ok"
    assert seen == ["charge"]
    assert device.connection_timeout == 0.05
    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004, 30000]


def test_compound_child_failure_is_not_success(linked):
    robot, device, holder = linked

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [
                _ok(
                    21004,
                    ts,
                    {"mapId": 336, "value": [{"id": 1, "tag": "Cocina", "active": "normal"}]},
                )
            ]
        return [
            _ok(
                30000,
                ts,
                {
                    "cmds": [
                        {"message": "fail", "infoType": "21023"},
                        {"message": "ok", "infoType": "21005"},
                    ]
                },
            )
        ]

    holder["handler"] = handler
    with pytest.raises(client_mod.ZK901ProtocolError) as raised:
        robot.clean_area(1, timeout=2)

    assert "21023" in str(raised.value)
    assert UID not in str(raised.value)
    assert LOCAL_KEY not in str(raised.value)


def test_forbid_zone_is_not_sent(linked):
    robot, device, holder = linked

    def handler(obj):
        return [
            _ok(
                21004,
                obj["dInfo"]["ts"],
                {
                    "mapId": 336,
                    "value": [{"id": 4, "tag": "Mueble", "active": "forbid"}],
                },
            )
        ]

    holder["handler"] = handler
    with pytest.raises(ValueError, match="prohibida"):
        robot.clean_area(4, timeout=2)

    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004]


def test_multi_zone_clean_uses_one_ordered_compound(linked):
    robot, device, holder = linked

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [
                _ok(
                    21004,
                    ts,
                    {
                        "mapId": 336,
                        "value": [
                            {"id": 1, "tag": "Cocina", "active": "normal"},
                            {"id": 2, "tag": "Dormitorio", "active": "depth"},
                        ],
                    },
                )
            ]
        assert obj["infoType"] == 30000
        cmds = obj["data"]["cmds"]
        assert [cmd["infoType"] for cmd in cmds] == [21023, 21005]
        assert cmds[0]["data"]["mapId"] == 336
        assert cmds[0]["data"]["cleanId"] == [2, 1, -3]
        assert cmds[0]["data"]["extraAreas"] == []
        assert cmds[1]["data"] == {"userId": UID, "sn": SN, "mode": "reAppointClean"}
        return [
            _ok(
                30000,
                ts,
                {
                    "cmds": [
                        {"message": "ok", "infoType": "21023"},
                        {"message": "ok", "infoType": "21005"},
                    ]
                },
            )
        ]

    holder["handler"] = handler
    response = robot.clean_areas([2, 1], timeout=2)

    assert response["message"] == "ok"
    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004, 30000]


@pytest.mark.parametrize("area_ids", [[], [1, 1], [True], [0], [-1], ["1"]])
def test_invalid_multi_zone_selection_sends_nothing(linked, area_ids):
    robot, device, _holder = linked

    with pytest.raises(ValueError):
        robot.clean_areas(area_ids, timeout=2)

    assert not [
        value
        for index, value, _nowait in device.sent
        if index in (3, 102)
    ]


@pytest.mark.parametrize(
    ("areas", "message"),
    [
        ([], "no existe"),
        ([{"id": 1, "tag": "Cocina", "active": "forbid"}], "prohibida"),
        (
            [
                {"id": 1, "tag": "Cocina", "active": "normal"},
                {"id": 1, "tag": "Otra", "active": "normal"},
            ],
            "duplicado",
        ),
        ([{"id": 1, "tag": "Cocina", "active": "other"}], "no admite"),
    ],
)
def test_invalid_fresh_multi_zone_catalog_sends_nothing(linked, areas, message):
    robot, device, holder = linked

    def handler(obj):
        assert obj["infoType"] == 21004
        return [_ok(21004, obj["dInfo"]["ts"], {"mapId": 336, "value": areas})]

    holder["handler"] = handler
    with pytest.raises(ValueError, match=message):
        robot.clean_areas([1], timeout=2)

    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004]


def test_multi_zone_partial_compound_failure_is_not_success(linked):
    robot, device, holder = linked

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [
                _ok(
                    21004,
                    ts,
                    {
                        "mapId": 336,
                        "value": [
                            {"id": 1, "tag": "Cocina", "active": "normal"},
                            {"id": 2, "tag": "Dormitorio", "active": "normal"},
                        ],
                    },
                )
            ]
        return [
            _ok(
                30000,
                ts,
                {
                    "cmds": [
                        {"message": "ok", "infoType": "21023"},
                        {"message": "fail", "infoType": "21005"},
                    ]
                },
            )
        ]

    holder["handler"] = handler
    with pytest.raises(client_mod.ZK901ProtocolError, match="21005"):
        robot.clean_areas([1, 2], timeout=2)

    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004, 30000]


def test_zone_by_name_and_cleanable_catalog():
    areas = [
        {"id": 1, "tag": "Cocina", "active": "normal"},
        {"id": 2, "tag": "Sofá", "active": "depth"},
        {"id": 2, "tag": "duplicada", "active": "normal"},
        {"id": 3, "tag": "Mueble", "active": "forbid"},
        {"id": -9, "name": "CurPoint", "active": "depth"},
        {"id": 0, "tag": "cero", "active": "normal"},
    ]
    chosen = client_mod.cleanable_areas(areas)
    assert [area["id"] for area in chosen] == [1, 2]
    assert client_mod.area_option(chosen[0]) == "Cocina [1]"
    assert client_mod.area_option({"id": 8, "tag": "", "name": ""}) == "Zona 8"


def test_start_pause_stop_and_spot_use_confirmed_commands(linked):
    robot, device, holder = linked
    acks: list[int] = []

    def handler(obj):
        acks.append(obj["infoType"])
        if obj["infoType"] == 20001:
            return [_ok(20001, obj["dInfo"]["ts"], {"mode": "pause", "workNoisy": "auto"})]
        return [_ok(obj["infoType"], obj["dInfo"]["ts"])]

    holder["handler"] = handler
    robot.get_status(timeout=2)
    robot.start()
    robot.stop()
    robot.return_to_base()
    robot.clean_current_position()

    logicals = [
        decode_sent(value)
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert logicals[1]["infoType"] == 21017
    assert logicals[1]["data"]["cmd"] == "continue"
    assert logicals[2]["infoType"] == 21012
    assert logicals[2]["data"]["cmd"] == "stop"
    assert logicals[3]["infoType"] == 21020
    assert logicals[3]["data"]["ctrlCode"] == 3001
    dp3 = [(index, value, nowait) for index, value, nowait in device.sent if index == 3]
    assert dp3 == [(3, "chargego", True)]


def test_start_from_other_mode_uses_dp3_smart(linked):
    robot, device, holder = linked

    def handler(obj):
        return [_ok(20001, obj["dInfo"]["ts"], {"mode": "charge"})]

    holder["handler"] = handler
    robot.get_status(timeout=2)
    robot.start()
    assert (3, "smart", True) in device.sent


def test_path_chunk_matches_cursor_and_rejects_bad_counts(linked):
    robot, _device, holder = linked

    def handler(obj):
        return [
            {
                "infoType": 21011,
                "data": {
                    "startPos": 99,
                    "pathID": "path-a",
                    "pointCounts": 1,
                    "posArray": [[1, 2]],
                },
            },
            {
                "infoType": 21011,
                "data": {
                    "startPos": obj["data"]["startPos"],
                    "pathID": "other",
                    "pointCounts": 1,
                    "posArray": [[1, 2]],
                },
            },
            {
                "infoType": 21011,
                "data": {
                    "startPos": obj["data"]["startPos"],
                    "pathID": "path-a",
                    "pointCounts": 1,
                    "posArray": [[4, 5]],
                },
            },
        ]

    holder["handler"] = handler
    chunk = robot.get_path_chunk(3, expected_path_id="path-a", timeout=2)
    assert chunk["posArray"] == [[4, 5]]

    def bad_handler(obj):
        return [
            {
                "infoType": 21011,
                "data": {
                    "startPos": obj["data"]["startPos"],
                    "pathID": "path-a",
                    "pointCounts": 2,
                    "posArray": [[1, 2]],
                },
            }
        ]

    holder["handler"] = bad_handler
    with pytest.raises(client_mod.ZK901ProtocolError, match="pointCounts"):
        robot.get_path_chunk(3, expected_path_id="path-a", timeout=2)


def test_command_timeout_and_missing_ts_behavior(linked):
    robot, _device, holder = linked
    holder["handler"] = lambda obj: []
    with pytest.raises(client_mod.ZK901Timeout):
        robot.pause(timeout=0.3)

    def handler(obj):
        return [{"message": "ok", "infoType": 21017, "data": {}}]

    holder["handler"] = handler
    robot.pause()


def test_rejected_ack_fails(linked):
    robot, _device, holder = linked

    def handler(obj):
        return [_ok(21022, obj["dInfo"]["ts"], message="fail")]

    holder["handler"] = handler
    with pytest.raises(client_mod.ZK901ProtocolError):
        robot.set_cleaning_level("strong")


def test_secrets_are_redacted_from_logs(caplog):
    device = FakeDevice(lambda obj: [])
    robot = client_mod.ZK901Client(
        device_id=DEVICE_ID,
        address="192.0.2.20",
        local_key=LOCAL_KEY,
        uid=UID,
        sn=SN,
        device=device,
    )
    logger = logging.getLogger("zk901-redaction-test")
    try:
        with caplog.at_level(logging.WARNING):
            logger.warning("clave %s uid %s", LOCAL_KEY, UID)
        assert LOCAL_KEY not in caplog.text
        assert UID not in caplog.text
        assert "<redacted>" in caplog.text
    finally:
        robot.close()

    caplog.clear()
    with caplog.at_level(logging.WARNING):
        logger.warning("clave %s", LOCAL_KEY)
    assert LOCAL_KEY in caplog.text


def test_close_stops_the_reader_thread():
    device = FakeDevice(lambda obj: [])
    robot = make_client(device)
    thread = robot._thread
    assert thread is not None and thread.is_alive()
    robot.close()
    thread.join(timeout=2)
    assert not thread.is_alive()
    with pytest.raises(client_mod.ZK901ConnectionError):
        robot.get_status(timeout=0.2)


def test_decode_rejects_non_json_and_non_objects():
    assert client_mod.decode_dp_payload("not-base64") is None
    encoded_list = base64.b64encode(b"[1,2]").decode("ascii")
    assert client_mod.decode_dp_payload(encoded_list) is None
    encoded = base64.b64encode(b'{"infoType":20001}').decode("ascii")
    assert client_mod.decode_dp_payload(encoded) == {"infoType": 20001}


def test_area_revision_is_stable_for_object_key_order_but_tracks_list_order():
    first = {
        "map_id": 336,
        "areas": [{"id": 1, "tag": "Entrada", "vertexs": [[0, 0], [2, 0]]}],
    }
    reordered_keys = {
        "areas": [{"vertexs": [[0, 0], [2, 0]], "tag": "Entrada", "id": 1}],
        "map_id": 336,
    }
    reversed_vertices = {
        "map_id": 336,
        "areas": [{"id": 1, "tag": "Entrada", "vertexs": [[2, 0], [0, 0]]}],
    }
    assert client_mod.area_catalog_revision(first) == client_mod.area_catalog_revision(
        reordered_keys
    )
    assert client_mod.area_catalog_revision(first) != client_mod.area_catalog_revision(
        reversed_vertices
    )


def test_area_vertex_validation_accepts_concave_polygon_and_rejects_invalid_shapes():
    concave = [[0, 0], [4, 0], [2, 1], [4, 3], [0, 3]]
    assert client_mod.validate_area_vertices(concave) == concave

    invalid = [
        ([[0, 0], [4, 4], [0, 4], [3, 0]], "cruzarse"),
        ([[0, 0], [4, 0], [0, 0]], "distintos"),
        ([[0, 0], [2, 0], [4, 0]], "área cero"),
        ([[0, 0], [True, 1], [0, 2]], "enteros"),
        ([[0, 0], [1.5, 1], [0, 2]], "enteros"),
    ]
    for vertices, message in invalid:
        with pytest.raises(ValueError, match=message):
            client_mod.validate_area_vertices(vertices)


def test_area_edit_is_one_queue_job_and_verifies_full_catalog(linked):
    robot, device, holder = linked
    original = {
        "id": 1,
        "name": "",
        "tag": "Entrada",
        "active": "normal",
        "vertexs": [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
        "customField": {"preserve": True},
    }
    catalog = {"map_id": 336, "areas": [original]}
    base_revision = client_mod.area_catalog_revision(catalog)
    seen: list[int] = []

    def handler(obj):
        seen.append(obj["infoType"])
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [_ok(21004, ts, {"mapId": catalog["map_id"], "value": catalog["areas"]})]
        if obj["infoType"] == 21003:
            assert obj["data"]["mapId"] == 336
            catalog["areas"] = obj["data"]["value"]
            assert catalog["areas"][0]["customField"] == {"preserve": True}
            assert catalog["areas"][0]["tag"] == "Entrada principal"
            return [_ok(21003, ts)]
        if obj["infoType"] == 21023:
            assert obj["connectionType"] == 0
            assert obj["data"]["cleanId"] == [-3]
            assert obj["data"]["extraAreas"] == []
            return [_ok(21023, ts)]
        raise AssertionError(obj["infoType"])

    holder["handler"] = handler
    result = robot.apply_area_edit(
        base_map_id=336,
        base_revision=base_revision,
        operation="update",
        area_id=1,
        tag="Entrada principal",
        timeout=2,
    )

    assert seen == [21004, 21003, 21023, 21004]
    assert result["areas"][0]["tag"] == "Entrada principal"
    assert result["areas"][0]["customField"] == {"preserve": True}
    assert result["revision"] == client_mod.area_catalog_revision(
        {"map_id": 336, "areas": catalog["areas"]}
    )
    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004, 21003, 21023, 21004]


def test_area_edit_conflict_and_validation_do_not_write(linked):
    robot, device, holder = linked
    stale = {"map_id": 336, "areas": [{"id": 1, "tag": "Antes", "active": "normal"}]}
    changed = {"map_id": 336, "areas": [{"id": 1, "tag": "Después", "active": "normal"}]}

    holder["handler"] = lambda obj: [
        _ok(21004, obj["dInfo"]["ts"], {"mapId": 336, "value": changed["areas"]})
    ]
    with pytest.raises(client_mod.ZK901AreaConflict) as conflict:
        robot.apply_area_edit(
            base_map_id=336,
            base_revision=client_mod.area_catalog_revision(stale),
            operation="delete",
            area_id=1,
            timeout=2,
        )
    assert conflict.value.current["areas"] == changed["areas"]

    holder["handler"] = lambda obj: [
        _ok(21004, obj["dInfo"]["ts"], {"mapId": 336, "value": stale["areas"]})
    ]
    with pytest.raises(ValueError, match="cruzarse"):
        robot.apply_area_edit(
            base_map_id=336,
            base_revision=client_mod.area_catalog_revision(stale),
            operation="create",
            tag="Mala",
            active="normal",
            vertexs=[[0, 0], [4, 4], [0, 4], [3, 0]],
            timeout=2,
        )

    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004, 21004]


def test_area_edit_reports_uncertain_when_verification_differs(linked):
    robot, _device, holder = linked
    catalog = {"map_id": 336, "areas": [{"id": 1, "tag": "Vieja", "active": "normal"}]}

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [_ok(21004, ts, {"mapId": 336, "value": catalog["areas"]})]
        if obj["infoType"] in {21003, 21023}:
            return [_ok(obj["infoType"], ts)]
        raise AssertionError(obj["infoType"])

    holder["handler"] = handler
    with pytest.raises(client_mod.ZK901AreaUncertain) as uncertain:
        robot.apply_area_edit(
            base_map_id=336,
            base_revision=client_mod.area_catalog_revision(catalog),
            operation="update",
            area_id=1,
            tag="Nueva",
            timeout=2,
        )
    assert uncertain.value.phase == "verify"


def test_area_edit_catalog_timeout_does_not_write(linked):
    robot, device, holder = linked
    holder["handler"] = lambda _obj: []
    set_timeout = device.set_socketTimeout
    device.set_socketTimeout = lambda seconds: set_timeout(min(seconds, 0.05))

    with pytest.raises(client_mod.ZK901Timeout):
        robot.apply_area_edit(
            base_map_id=336,
            base_revision=client_mod.area_catalog_revision(
                {"map_id": 336, "areas": []}
            ),
            operation="delete",
            area_id=1,
            timeout=0.15,
        )

    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004]


@pytest.mark.parametrize(
    "data",
    [
        {"mapId": 336},
        {"mapId": 336, "value": None},
        {"mapId": None, "value": []},
    ],
)
def test_area_edit_rejects_incomplete_catalog_without_writing(linked, data):
    robot, device, holder = linked
    holder["handler"] = lambda obj: [_ok(21004, obj["dInfo"]["ts"], data)]

    with pytest.raises(client_mod.ZK901ProtocolError):
        robot.apply_area_edit(
            base_map_id=336,
            base_revision=client_mod.area_catalog_revision(
                {"map_id": 336, "areas": []}
            ),
            operation="create",
            tag="Nueva",
            active="normal",
            vertexs=[[0, 0], [100, 0], [100, 100]],
            timeout=2,
        )

    assert [decode_sent(value)["infoType"] for index, value, _ in device.sent if index == 102] == [21004]


@pytest.mark.parametrize(
    ("operation", "initial_areas", "area_id", "expected_ids"),
    [
        ("create", [{"id": 1, "tag": "Uno", "active": "normal"}, {"id": 3, "tag": "Tres", "active": "depth"}], None, [1, 3, 2]),
        ("delete", [{"id": 1, "tag": "Uno", "active": "normal"}, {"id": 2, "tag": "Dos", "active": "depth"}], 1, [2]),
    ],
)
def test_area_edit_create_and_delete_use_the_full_catalog(
    linked, operation, initial_areas, area_id, expected_ids
):
    robot, _device, holder = linked
    catalog = {"map_id": 336, "areas": initial_areas}
    writes: list[list[dict]] = []

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [_ok(21004, ts, {"mapId": 336, "value": catalog["areas"]})]
        if obj["infoType"] == 21003:
            catalog["areas"] = obj["data"]["value"]
            writes.append(catalog["areas"])
            return [_ok(21003, ts)]
        if obj["infoType"] == 21023:
            return [_ok(21023, ts)]
        raise AssertionError(obj["infoType"])

    holder["handler"] = handler
    result = robot.apply_area_edit(
        base_map_id=336,
        base_revision=client_mod.area_catalog_revision(catalog),
        operation=operation,
        area_id=area_id,
        tag="Nueva" if operation == "create" else None,
        active="normal" if operation == "create" else None,
        vertexs=[[10, 10], [100, 10], [100, 100], [10, 100]] if operation == "create" else None,
        timeout=2,
    )

    assert [area["id"] for area in result["areas"]] == expected_ids
    assert len(writes) == 1
    if operation == "create":
        assert result["area_id"] == 2
        assert result["areas"][-1]["tag"] == "Nueva"


def test_area_edit_explicit_save_rejection_does_not_refresh_or_claim_success(linked):
    robot, device, holder = linked
    catalog = {"map_id": 336, "areas": [{"id": 1, "tag": "Uno", "active": "normal"}]}

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [_ok(21004, ts, {"mapId": 336, "value": catalog["areas"]})]
        if obj["infoType"] == 21003:
            return [_ok(21003, ts, message="fail")]
        raise AssertionError(obj["infoType"])

    holder["handler"] = handler
    with pytest.raises(client_mod.ZK901ProtocolError):
        robot.apply_area_edit(
            base_map_id=336,
            base_revision=client_mod.area_catalog_revision(catalog),
            operation="update",
            area_id=1,
            tag="No guardar",
            timeout=2,
        )

    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == [21004, 21003]


@pytest.mark.parametrize(
    ("missing_ack", "phase", "expected_types"),
    [
        (21003, "save", [21004, 21003]),
        (21023, "refresh_or_verify", [21004, 21003, 21023]),
    ],
)
def test_area_edit_timeout_after_write_is_uncertain(
    linked, missing_ack, phase, expected_types
):
    robot, device, holder = linked
    catalog = {"map_id": 336, "areas": [{"id": 1, "tag": "Uno", "active": "normal"}]}

    def handler(obj):
        ts = obj["dInfo"]["ts"]
        if obj["infoType"] == 21004:
            return [_ok(21004, ts, {"mapId": 336, "value": catalog["areas"]})]
        if obj["infoType"] == 21003:
            catalog["areas"] = obj["data"]["value"]
            return [] if missing_ack == 21003 else [_ok(21003, ts)]
        if obj["infoType"] == 21023:
            return [] if missing_ack == 21023 else [_ok(21023, ts)]
        raise AssertionError(obj["infoType"])

    holder["handler"] = handler
    with pytest.raises(client_mod.ZK901AreaUncertain) as uncertain:
        robot.apply_area_edit(
            base_map_id=336,
            base_revision=client_mod.area_catalog_revision(catalog),
            operation="update",
            area_id=1,
            tag="Nueva",
            timeout=0.15,
        )

    assert uncertain.value.phase == phase
    sent_types = [
        decode_sent(value)["infoType"]
        for index, value, _nowait in device.sent
        if index == 102
    ]
    assert sent_types == expected_types
