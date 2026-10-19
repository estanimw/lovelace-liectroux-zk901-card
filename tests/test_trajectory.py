"""Route capture tests: finite chunks, gaps, persistence and no card subscriber."""
import asyncio
from types import SimpleNamespace

import pytest
from homeassistant.core import HomeAssistant

from custom_components.liectroux_zk901 import trajectory as route
from custom_components.liectroux_zk901.client import ZK901Timeout


def chunk(start=0, points=None, path=10):
    points = [[10, 20], [20, 30]] if points is None else points
    return {"pathID": path, "startPos": start, "pointCounts": len(points),
            "totalPoints": start + len(points), "posArray": points}


def test_incremental_restart_gap_and_changed_path():
    history = route.RouteHistory()
    history.start(336)
    history.ingest(chunk(), "cleaning")
    saved = history.dump()
    restored = route.RouteHistory()
    restored.restore(saved)
    assert restored.cursor == 2
    assert restored.current["incomplete"]
    restored.ingest(chunk(2, [[30, 40]]), "cleaning")
    assert len(restored.current["segments"]) == 2
    assert restored.cursor == 3
    with pytest.raises(ValueError, match="unexpected_cursor"):
        restored.ingest(chunk(2, [[30, 40]]), "cleaning")
    assert restored.cursor == 3
    # A changed path response at the old cursor cannot bridge trajectories.
    assert not restored.ingest(chunk(3, [[100, 200]], path=11), "unknown")
    assert restored.cursor == 0
    restored.ingest(chunk(0, [[100, 200]], path=11), "unknown")
    assert len(restored.sessions) == 2
    assert restored.sessions[0]["ended_at"]
    assert restored.current["segments"][0]["points"] == [[100, 200]]


@pytest.mark.parametrize("bad", [
    {"pointCounts": True}, {"totalPoints": 1}, {"pathID": None},
    {"posArray": [[float("nan"), 2], [1, 2]]}, {"posArray": [[1], [2]]},
])
def test_invalid_chunks_do_not_advance(bad):
    history = route.RouteHistory()
    history.start(336)
    with pytest.raises(ValueError):
        history.ingest({**chunk(), **bad}, "cleaning")
    assert history.cursor == 0
    assert not history.current["segments"]


def test_history_bounds_map_separation_and_retention(monkeypatch):
    monkeypatch.setattr(route, "MAX_POINTS", 5)
    history = route.RouteHistory()
    for index in range(35):
        history.start(index % 2)
        history.ingest(chunk(points=[[index, 1], [index, 2]]), "cleaning")
        history.finish()
    assert len(history.sessions) <= 30
    assert sum(len(seg["points"]) for s in history.sessions for seg in s["segments"]) <= 5
    assert all(s["map_id"] == 1 for s in history.snapshot(1, False)["sessions"])
    history.start(1)
    history.ingest(chunk(points=[[n, 1] for n in range(10)]), "cleaning")
    assert history.current["incomplete"]
    assert history.cursor == 10  # storage trimming never rewinds the device cursor
    assert len(history.current["segments"][0]["points"]) == 5


def test_capture_without_subscribers_timeout_final_read_and_restore(tmp_path, monkeypatch):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        captures = []
        updates = []
        fail = False

        class Client:
            def get_path_chunk(self, cursor, **kwargs):
                captures.append(cursor)
                if fail:
                    raise ZK901Timeout("test")
                return chunk(cursor, [[cursor * 10, 1]])

        coordinator = SimpleNamespace(hass=hass, entry_id="autonomous", client=Client(),
                                      _publish_card_update=lambda: updates.append(True))
        capture = route.TrajectoryCapture(coordinator)
        monkeypatch.setattr(route, "INTERVAL", 0.03)
        try:
            await capture.start()
            capture.observe({"mode": "charge"}, 336)
            await asyncio.sleep(0.02)
            assert not captures
            capture.observe({"mode": "sweep"}, 336)
            await asyncio.sleep(0.09)
            assert len(captures) >= 2  # no entities, card, or dispatcher listeners
            assert captures == list(range(len(captures)))
            cursor = capture.history.cursor
            fail = True
            await asyncio.sleep(0.04)
            assert capture.history.cursor == cursor
            assert capture.history.error
            fail = False
            capture.observe({"mode": "backcharge"}, 336)
            await asyncio.sleep(0.04)
            assert capture.history.current["incomplete"]
            capture.observe({"mode": "charge"}, 336)
            await asyncio.sleep(0.04)
            assert capture.history.current is None
            reads = len(captures)
            await asyncio.sleep(0.06)
            assert len(captures) == reads
            assert updates
            await capture.stop()
            # Reloads preserve all route data even when the card was never open.
            restored = route.TrajectoryCapture(coordinator)
            await restored.start()
            assert restored.history.sessions == capture.history.sessions
            await restored.clear()
            assert restored.history.sessions == []
            await restored.stop()
        finally:
            await capture.stop()
            await hass.async_stop(force=True)

    asyncio.run(run())


def test_restart_resumes_saved_cursor_and_map_change_starts_separate_session(tmp_path):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        calls = []
        class Client:
            def get_path_chunk(self, cursor, **kwargs):
                calls.append(cursor)
                return chunk(cursor, [[cursor, cursor]])
        coordinator = SimpleNamespace(hass=hass, entry_id="restart", client=Client(), _publish_card_update=lambda: None)
        capture = route.TrajectoryCapture(coordinator)
        try:
            capture.history.start(336)
            capture.history.ingest(chunk(), "cleaning")
            await capture._save()
            await capture.start()
            capture.observe({"mode": "sweep"}, 336)
            await asyncio.sleep(0.04)
            assert calls[0] == 2
            capture.observe({"mode": "sweep"}, 337)
            # A map change must wake the worker even if the mode is unchanged.
            await asyncio.sleep(0.04)
            assert calls[-1] == 0
            assert {s["map_id"] for s in capture.history.sessions} == {336, 337}
            assert all(s["map_id"] == 337 for s in capture.history.snapshot(337, True)["sessions"])
        finally:
            await capture.stop()
            await hass.async_stop(force=True)
    asyncio.run(run())


def test_clear_during_pending_read_discards_old_response_and_preserves_cursor(tmp_path):
    async def run():
        import threading
        hass = HomeAssistant(str(tmp_path))
        entered = threading.Event()
        release = threading.Event()
        class Client:
            def get_path_chunk(self, cursor, **kwargs):
                entered.set()
                release.wait(timeout=2)
                return chunk(cursor, [[999, 999]])
        coordinator = SimpleNamespace(hass=hass, entry_id="race", client=Client(), _publish_card_update=lambda: None)
        capture = route.TrajectoryCapture(coordinator)
        pending = None
        try:
            capture.active = True
            capture.mode = "sweep"
            capture.map_id = 336
            capture.history.start(336)
            capture.history.ingest(chunk(), "cleaning")
            previous_epoch = capture.history.epoch
            pending = asyncio.create_task(capture._capture())
            while not entered.is_set():
                await asyncio.sleep(0.001)
            await capture.clear()
            release.set()
            await pending
            assert capture.history.epoch != previous_epoch
            assert capture.history.cursor == 2
            assert capture.history.current["segments"] == []
            assert len(capture.history.sessions) == 1
            restored = route.RouteHistory()
            restored.restore(await capture.store.async_load())
            assert restored.cursor == 2
            assert restored.current["segments"] == []
        finally:
            release.set()
            if pending:
                await pending
            await capture.stop()
            await hass.async_stop(force=True)
    asyncio.run(run())


def test_accumulated_coverage_survives_history_retention_and_never_fills_gaps(monkeypatch):
    monkeypatch.setattr(route, "MAX_SESSIONS", 1)
    history = route.RouteHistory()
    history.start(336)
    history.ingest(chunk(points=[[0, 0], [100, 0]]), "cleaning")
    original = set(map(tuple, history.coverage[0]["cells"]))
    history.finish()
    history.start(336)
    history.ingest(chunk(points=[[10000, 10000]]), "unknown")
    history.ingest(chunk(1, [[11000, 11000]]), "return")
    assert set(map(tuple, history.coverage[0]["cells"])) == original
    history.interrupt("disconnected")
    history.ingest(chunk(2, [[20000, 20000]]), "cleaning")
    cells = set(map(tuple, history.coverage[0]["cells"]))
    assert original <= cells
    assert not any(10 <= x <= 100 for x, y in cells)  # no stripe across the missing interval
    assert len(history.sessions) == 1
    restored = route.RouteHistory()
    restored.restore(history.dump())
    assert restored.coverage == history.coverage
    assert restored.snapshot(337, False)["coverage"]["cells"] == []


def test_coverage_is_bounded_independently_of_raw_points(monkeypatch):
    monkeypatch.setattr(route, "MAX_CELLS", 20)
    history = route.RouteHistory()
    for map_id in range(5):
        history.start(map_id)
        history.ingest(chunk(points=[[0, 0], [5000, 5000]]), "cleaning")
        history.finish()
    assert sum(len(c["cells"]) for c in history.coverage) <= 20
    assert len(history.coverage) <= 3
    assert len(history.snapshot(4, False)["coverage"]["cells"]) <= 20


def test_empty_final_path_does_not_hide_last_recorded_activity():
    history = route.RouteHistory()
    history.start(336)
    history.ingest(chunk(), "cleaning")
    recorded_id = history.current["id"]
    history.ingest(chunk(0, [], path=11), "unknown")
    history.finish()
    assert len(history.sessions) == 1
    assert history.sessions[-1]["id"] == recorded_id
