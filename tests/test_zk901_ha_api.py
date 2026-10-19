"""Runtime API checks against the Home Assistant version installed by CI."""

from __future__ import annotations

import asyncio
from importlib.metadata import version
import time
from types import SimpleNamespace

import pytest
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntries, ConfigEntryState
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady, Unauthorized
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

import custom_components.liectroux_zk901 as integration
from custom_components.liectroux_zk901 import async_setup
from custom_components.liectroux_zk901.const import DOMAIN
from custom_components.liectroux_zk901.coordinator import (
    ZK901Coordinator,
    card_update_signal,
)
from custom_components.liectroux_zk901 import zone_editor


HA_VERSION = "2026.9.2"


class FakeEntry:
    entry_id = "test-entry"

    def async_on_unload(self, callback) -> None:
        self.unload_callback = callback


class FakeClient:
    def __init__(self) -> None:
        self.area_reads = 0

    def get_areas(self, timeout: float) -> dict:
        self.area_reads += 1
        time.sleep(0.01)
        return {
            "map_id": 554722792,
            "areas": [
                {
                    "id": 7,
                    "tag": "Cocina",
                    "active": "normal",
                    "vertexs": [[0, 0], [100, 0], [100, 100]],
                    "future_field": "preserved",
                }
            ],
        }


class FakeConnection:
    def __init__(self, *, is_admin: bool = True) -> None:
        self.user = SimpleNamespace(is_admin=is_admin)
        self.subscriptions: dict[int, object] = {}
        self.messages: list[tuple[str, int, dict]] = []
        self.first_message = asyncio.Event()

    def send_result(self, msg_id: int, result: dict) -> None:
        self.messages.append(("result", msg_id, result))
        self.first_message.set()

    def send_event(self, msg_id: int, event: dict) -> None:
        self.messages.append(("event", msg_id, event))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.messages.append(("error", msg_id, {"code": code, "message": message}))
        self.first_message.set()


def test_home_assistant_version_is_the_declared_target() -> None:
    assert version("homeassistant") == HA_VERSION
    assert "config_entry" in DataUpdateCoordinator.__init__.__annotations__
    assert "data" in DataUpdateCoordinator.async_set_updated_data.__annotations__
    assert all(
        hasattr(websocket_api.ActiveConnection, method)
        for method in ("send_result", "send_event", "send_error")
    )


def test_real_home_assistant_registration_and_schemas(tmp_path) -> None:
    async def run() -> None:
        hass = HomeAssistant(str(tmp_path))
        try:
            assert await async_setup(hass, {})

            commands = hass.data[websocket_api.DOMAIN]
            assert set(commands) == {
                f"{DOMAIN}/zone_editor/get",
                f"{DOMAIN}/zone_editor/apply",
                f"{DOMAIN}/card/subscribe",
                f"{DOMAIN}/card/refresh",
                f"{DOMAIN}/trajectory/clear",
            }
            service = hass.services.async_services()[DOMAIN]
            assert {"clean_area", "clean_areas"} <= set(service)

            multi_schema = service["clean_areas"].schema
            normalized = multi_schema(
                {"entity_id": "vacuum.liectroux_zk901", "area_ids": [7, 2]}
            )
            assert normalized["area_ids"] == [7, 2]
            assert normalized["entity_id"] == ["vacuum.liectroux_zk901"]
            for bad_ids in ([], [7, 7], [True], [0], [-2], ["7"]):
                with pytest.raises(Exception):
                    multi_schema(
                        {"entity_id": "vacuum.liectroux_zk901", "area_ids": bad_ids}
                    )

            apply_schema = commands[f"{DOMAIN}/zone_editor/apply"][1]
            valid_edit = {
                "id": 1,
                "type": f"{DOMAIN}/zone_editor/apply",
                "entity_id": "vacuum.liectroux_zk901",
                "base_map_id": 554722792,
                "base_revision": "a" * 64,
                "operation": "update",
                "area_id": 7,
                "tag": "Cocina",
                "active": "normal",
                "vertexs": [[0, 0], [100, 0], [100, 100]],
            }
            assert apply_schema(valid_edit)["area_id"] == 7
            with pytest.raises(Exception):
                apply_schema({**valid_edit, "area_id": True})
            with pytest.raises(Exception):
                apply_schema({**valid_edit, "base_map_id": True})
        finally:
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_websocket_subscription_uses_coordinator_and_unsubscribes(monkeypatch, tmp_path) -> None:
    async def run() -> None:
        hass = HomeAssistant(str(tmp_path))
        try:
            client = FakeClient()
            coordinator = ZK901Coordinator(hass, client, FakeEntry())
            coordinator.set_status(
                {
                    "mode": "sweep",
                    "subMode": "area",
                    "elec": 81,
                    "workNoisy": "strong",
                    "mop": 0,
                    "pos": [125, 250],
                    "phi": 1000,
                }
            )
            monkeypatch.setattr(
                zone_editor,
                "_coordinator_for_entity",
                lambda _hass, _entity_id: coordinator,
            )
            updates: list[None] = []
            remove_listener = async_dispatcher_connect(
                hass, card_update_signal(coordinator.entry_id), lambda: updates.append(None)
            )
            connection = FakeConnection()
            message = {
                "id": 9,
                "type": f"{DOMAIN}/card/subscribe",
                "entity_id": "vacuum.liectroux_zk901",
            }

            zone_editor.websocket_subscribe_card(hass, connection, message)
            await asyncio.wait_for(connection.first_message.wait(), timeout=2)
            await asyncio.sleep(0.05)

            assert [kind for kind, _msg_id, _body in connection.messages] == [
                "result",
                "event",
            ]
            initial = connection.messages[0][2]
            event = connection.messages[1][2]
            assert initial["ok"] is True
            assert event["api_version"] == 1
            assert event["entity_id"] == message["entity_id"]
            assert event["generation"] == initial["generation"]
            assert event["sequence"] > initial["sequence"]
            assert event["status"]["battery"] == 81
            assert event["pose"]["pos"] == [125, 250]
            assert event["catalog"]["areas"][0]["future_field"] == "preserved"
            assert event["status"]["observed_at"] != event["catalog"]["observed_at"]
            assert client.area_reads == 1
            assert len(updates) == 1

            unsubscribe = connection.subscriptions.pop(message["id"])
            unsubscribe()
            coordinator.set_status({"mode": "pause", "elec": 80})
            await asyncio.sleep(0)
            assert len(connection.messages) == 2
            remove_listener()
        finally:
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_websocket_subscription_retains_admin_requirement(tmp_path) -> None:
    async def run() -> None:
        hass = HomeAssistant(str(tmp_path))
        try:
            connection = FakeConnection(is_admin=False)
            with pytest.raises(Unauthorized):
                zone_editor.websocket_subscribe_card(
                    hass,
                    connection,
                    {
                        "id": 3,
                        "type": f"{DOMAIN}/card/subscribe",
                        "entity_id": "vacuum.liectroux_zk901",
                    },
                )
            assert connection.messages == []
        finally:
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_live_subscription_recovers_when_entry_is_reloaded(monkeypatch, tmp_path) -> None:
    async def run() -> None:
        hass = HomeAssistant(str(tmp_path))
        connection = FakeConnection()
        try:
            entry = FakeEntry()
            entry.state = ConfigEntryState.SETUP_IN_PROGRESS
            entry.pref_disable_polling = False
            entry.data = dict.fromkeys(("device_id", "host", "local_key", "uid", "sn"), "test")
            old = ZK901Coordinator(hass, FakeClient(), entry)
            old.set_status({"mode": "charge", "elec": 81})
            entry.runtime_data = old
            monkeypatch.setattr(zone_editor, "_coordinator_for_entity", lambda *_: entry.runtime_data)
            zone_editor.websocket_subscribe_card(hass, connection, {
                "id": 9, "type": f"{DOMAIN}/card/subscribe",
                "entity_id": "vacuum.liectroux_zk901",
            })
            await asyncio.wait_for(connection.first_message.wait(), timeout=2)
            await hass.async_block_till_done()
            generation = connection.messages[-1][2]["generation"]
            old.mark_unloaded()
            await hass.async_block_till_done()
            assert connection.messages[-1][2]["available"] is False

            class ReplacementClient(FakeClient):
                def connect(self):
                    pass

                def close(self):
                    pass

                def set_status_listener(self, listener):
                    pass

                def set_connection_listener(self, listener):
                    pass

                def get_status(self):
                    return {"mode": "sweep", "elec": 50}

            monkeypatch.setattr(integration, "ZK901Client", lambda **_: ReplacementClient())

            async def forward_setups(*_):
                pass

            hass.config_entries = ConfigEntries(hass, {})
            monkeypatch.setattr(hass.config_entries, "async_forward_entry_setups", forward_setups)
            assert await integration.async_setup_entry(hass, entry)
            await hass.async_block_till_done()
            recovered = connection.messages[-1][2]
            assert recovered["generation"] != generation
            assert recovered["available"] is True
            assert recovered["status"]["battery"] == 50
            assert len(connection.subscriptions) == 1
            entry.runtime_data.set_status({"mode": "pause", "elec": 49})
            await hass.async_block_till_done()
            assert connection.messages[-1][2]["status"]["battery"] == 49
            assert connection.messages[-1][2]["sequence"] > recovered["sequence"]
        finally:
            for unsubscribe in connection.subscriptions.values():
                unsubscribe()
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_offline_robot_does_not_block_update_platform(monkeypatch, tmp_path) -> None:
    async def run() -> None:
        hass = HomeAssistant(str(tmp_path))
        forwarded: list[tuple[object, tuple[Platform, ...]]] = []

        class OfflineClient:
            def connect(self) -> None:
                pass

            def close(self) -> None:
                pass

            def set_status_listener(self, _listener) -> None:
                pass

            def set_connection_listener(self, _listener) -> None:
                pass

        class OfflineCoordinator:
            def __init__(self, _hass, client, _entry) -> None:
                self.client = client
                from unittest.mock import AsyncMock
                self.trajectory = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())

            def handle_status(self, _status) -> None:
                pass

            def handle_connection(self, _connected) -> None:
                pass

            async def async_config_entry_first_refresh(self) -> None:
                raise ConfigEntryNotReady("robot offline")

        async def forward_entry_setups(entry, platforms) -> None:
            forwarded.append((entry, platforms))

        try:
            entry = FakeEntry()
            entry.data = dict.fromkeys(("device_id", "host", "local_key", "uid", "sn"), "test")
            hass.config_entries = SimpleNamespace(async_forward_entry_setups=forward_entry_setups)
            monkeypatch.setattr(integration, "ZK901Client", lambda **_: OfflineClient())
            monkeypatch.setattr(integration, "ZK901Coordinator", OfflineCoordinator)

            assert await integration.async_setup_entry(hass, entry)
            assert entry.runtime_data.client is not None
            assert len(forwarded) == 1
            assert Platform.UPDATE in forwarded[0][1]
        finally:
            await hass.async_stop(force=True)

    asyncio.run(run())
