"""Autonomous incremental route capture; no browser or extra LAN connection."""
from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timezone
from functools import partial
import logging
import math
from typing import Any
from uuid import uuid4

from homeassistant.helpers.storage import Store
from homeassistant.exceptions import HomeAssistantError

from .client import ZK901Error
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
INTERVAL = 20
MAX_SESSIONS = 30
MAX_POINTS = 30000
CELL_SIZE = 100
MAX_CELLS = 30000
MAX_COVERAGE_CONTEXTS = 3
ACTIVE_MODES = {"sweep", "backcharge", "rfctrl"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RouteHistory:
    """Bounded, JSON serializable history with explicit segment boundaries."""

    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []
        self.current: dict[str, Any] | None = None
        self.updated_at: str | None = None
        self.error: str | None = None
        self.epoch = uuid4().hex
        self.break_segment = False
        self.coverage: list[dict[str, Any]] = []

    @property
    def cursor(self) -> int:
        return self.current["cursor"] if self.current else 0

    def start(self, map_id: Any) -> None:
        self.current = {
            "id": uuid4().hex, "map_id": map_id, "epoch": self.epoch,
            "started_at": now(), "ended_at": None, "path_id": None,
            "cursor": 0, "segments": [], "incomplete": False,
        }
        self.sessions.append(self.current)
        self.sessions = self.sessions[-MAX_SESSIONS:]
        self.break_segment = False

    def finish(self) -> None:
        if self.current:
            self.current["ended_at"] = now()
        self.current = None

    def interrupt(self, reason: str) -> None:
        self.error = reason
        self.break_segment = True
        if self.current:
            self.current["incomplete"] = True

    def ingest(self, chunk: dict, kind: str) -> bool:
        """Accept only complete, finite chunks at the persisted cursor.

        A new path at a nonzero cursor is not appended to the previous path.
        The caller will begin a new path from zero on the next scheduled read.
        """
        if self.current is None:
            return False
        start = chunk.get("startPos")
        count = chunk.get("pointCounts")
        total = chunk.get("totalPoints")
        points = chunk.get("posArray")
        path_id = chunk.get("pathID")
        if (any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in (start, count, total))
                or not isinstance(path_id, (str, int)) or isinstance(path_id, bool)
                or not isinstance(points, list) or len(points) != count
                or start + count > total
                or any(not isinstance(p, list) or len(p) != 2 or any(
                    isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                    for v in p) for p in points)):
            raise ValueError("invalid_path_chunk")
        current = self.current
        if current["path_id"] is not None and path_id != current["path_id"]:
            map_id = current["map_id"]
            self.interrupt("path_changed")
            self.finish()
            self.start(map_id)
            if start != 0:
                return False
            current = self.current
        if start != current["cursor"]:
            raise ValueError("unexpected_cursor")
        current["path_id"] = path_id
        if points:
            segments = current["segments"]
            previous = None
            if self.break_segment or not segments or segments[-1]["kind"] != kind:
                segments.append({"kind": kind, "points": []})
            elif segments[-1]["points"]:
                previous = segments[-1]["points"][-1]
            if kind == "cleaning":
                self._add_coverage(points, previous)
            segments[-1]["points"].extend(copy.deepcopy(points))
            self.break_segment = False
        current["cursor"] = start + count
        self.updated_at = now()
        self.error = None
        self._trim()
        return True

    def _add_coverage(self, points: list, previous: list | None) -> None:
        """Accumulate a bounded, illustrative 30 cm swath on a 10 cm grid.

        Only interpolate inside a confirmed contiguous cleaning segment. This
        is estimated travelled space, never obstacle or measured clean area.
        """
        context = next((c for c in self.coverage if c["map_id"] == self.current["map_id"] and c["epoch"] == self.epoch), None)
        if context is None:
            context = {"map_id": self.current["map_id"], "epoch": self.epoch, "cells": []}
            self.coverage.append(context)
            self.coverage = self.coverage[-MAX_COVERAGE_CONTEXTS:]
        self.coverage.remove(context)
        self.coverage.append(context)
        cells = context["cells"]
        seen = {tuple(cell) for cell in cells}
        sampling_budget = MAX_CELLS
        for point in points:
            samples = [point]
            if previous is not None:
                distance = math.hypot(point[0] - previous[0], point[1] - previous[1])
                steps = math.ceil(distance / CELL_SIZE)
                # Bound work for anomalous coordinates without filling a huge
                # inferred stripe. The raw route itself is retained unchanged.
                if 1 < steps <= min(1000, sampling_budget):
                    sampling_budget -= steps
                    samples = [[previous[0] + (point[0] - previous[0]) * i / steps,
                                previous[1] + (point[1] - previous[1]) * i / steps]
                               for i in range(1, steps + 1)]
            for x, y in samples:
                ix, iy = math.floor(x / CELL_SIZE), math.floor(y / CELL_SIZE)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        cell = (ix + dx, iy + dy)
                        if cell not in seen:
                            seen.add(cell)
                            cells.append(list(cell))
            previous = point
        # Keep recently added cells when the bounded reconstruction is full.
        while sum(len(c["cells"]) for c in self.coverage) > MAX_CELLS and len(self.coverage) > 1:
            self.coverage.pop(0)
        if len(cells) > MAX_CELLS:
            del cells[:-MAX_CELLS]

    def _trim(self) -> None:
        total = sum(len(seg["points"]) for s in self.sessions for seg in s["segments"])
        while total > MAX_POINTS and len(self.sessions) > 1:
            removed = self.sessions.pop(0)
            total -= sum(len(seg["points"]) for seg in removed["segments"])
        if total > MAX_POINTS and self.sessions:
            session = self.sessions[0]
            excess = total - MAX_POINTS
            for seg in session["segments"]:
                drop = min(excess, len(seg["points"]))
                del seg["points"][:drop]
                excess -= drop
                if not excess:
                    break
            session["segments"] = [s for s in session["segments"] if s["points"]]
            session["incomplete"] = True

    def dump(self) -> dict:
        return copy.deepcopy({"sessions": self.sessions, "current_id": self.current["id"] if self.current else None,
                              "updated_at": self.updated_at, "epoch": self.epoch, "coverage": self.coverage})

    def restore(self, data: dict) -> None:
        """Load our versioned storage, refusing malformed or unbounded data."""
        if not isinstance(data, dict):
            raise ValueError("invalid_route_storage")
        sessions = data.get("sessions", [])
        if not isinstance(sessions, list) or len(sessions) > MAX_SESSIONS:
            raise ValueError("invalid_route_storage")
        for session in sessions:
            if not isinstance(session, dict) or not isinstance(session.get("segments"), list):
                raise ValueError("invalid_route_storage")
            cursor = session.get("cursor")
            if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
                raise ValueError("invalid_route_storage")
            for seg in session["segments"]:
                if not isinstance(seg, dict) or seg.get("kind") not in {"cleaning", "return", "unknown"}:
                    raise ValueError("invalid_route_storage")
                points = seg.get("points")
                if not isinstance(points, list) or any(not isinstance(p, list) or len(p) != 2 or any(
                    isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in p) for p in points):
                    raise ValueError("invalid_route_storage")
            for key in ("id", "map_id", "epoch", "started_at", "ended_at", "path_id", "incomplete"):
                if key not in session:
                    raise ValueError("invalid_route_storage")
        coverage = data.get("coverage", [])
        if not isinstance(coverage, list) or len(coverage) > MAX_COVERAGE_CONTEXTS:
            raise ValueError("invalid_route_storage")
        count = 0
        for context in coverage:
            if not isinstance(context, dict) or "map_id" not in context or "epoch" not in context or not isinstance(context.get("cells"), list):
                raise ValueError("invalid_route_storage")
            for cell in context["cells"]:
                if not isinstance(cell, list) or len(cell) != 2 or any(isinstance(v, bool) or not isinstance(v, int) for v in cell):
                    raise ValueError("invalid_route_storage")
            count += len(context["cells"])
        if count > MAX_CELLS:
            raise ValueError("invalid_route_storage")
        self.coverage = copy.deepcopy(coverage)
        self.sessions = copy.deepcopy(sessions)
        self.current = next((s for s in self.sessions if s["id"] == data.get("current_id")), None)
        self.updated_at = data.get("updated_at")
        self.epoch = data.get("epoch") or uuid4().hex
        self._trim()
        if self.current:
            self.interrupt("restarted")

    def snapshot(self, map_id: Any, active: bool) -> dict:
        return {
            "sessions": copy.deepcopy([s for s in self.sessions if s["map_id"] == map_id and s["epoch"] == self.epoch]),
            "current_id": self.current["id"] if self.current else None,
            "updated_at": self.updated_at, "error": self.error,
            "capturing": active, "interval_seconds": INTERVAL,
            "coverage": {
                "cell_size": CELL_SIZE,
                "cells": copy.deepcopy(next((c["cells"] for c in self.coverage if c["map_id"] == map_id and c["epoch"] == self.epoch), [])),
            },
        }


class TrajectoryCapture:
    """A single entry-owned scheduler, independent of coordinator listeners."""

    def __init__(self, coordinator) -> None:
        self.coordinator = coordinator
        self.hass = coordinator.hass
        self.history = RouteHistory()
        self.store = Store(self.hass, 1, f"{DOMAIN}.trajectory.{coordinator.entry_id}")
        self.task: asyncio.Task | None = None
        self.wake = asyncio.Event()
        self.stopping = False
        self.active = False
        self.last_active = False
        self.mode: str | None = None
        self.map_id: Any = None
        self.kind = "unknown"
        self.boundary = False
        self.generation = 0
        self.observed = False
        self.phase = 0
        self.save_lock = asyncio.Lock()

    async def start(self) -> None:
        try:
            data = await self.store.async_load()
            if data:
                self.history.restore(data)
        except (ValueError, KeyError, TypeError, OSError, HomeAssistantError):
            _LOGGER.warning("ZK901 route storage invalid; starting a new reconstruction")
            self.history = RouteHistory()
        self.task = self.hass.async_create_background_task(self._run(), "ZK901 trajectory")

    def observe(self, status: dict, map_id: Any) -> None:
        mode = status.get("mode")
        self.last_active = self.active
        self.active = mode in ACTIVE_MODES
        if map_id is not None and self.history.current and map_id != self.history.current["map_id"]:
            self.boundary = True
            self.wake.set()
        # Pauses preserve the route; dock -> active means a new activity.
        if self.active and not self.last_active and self.mode not in {"pause", *ACTIVE_MODES} and (self.observed or self.history.current is None):
            self.boundary = True
        if map_id is not None:
            if map_id != self.map_id and self.active:
                self.wake.set()
            self.map_id = map_id
        self.observed = True
        new_kind = "cleaning" if mode == "sweep" else "return" if mode == "backcharge" else "unknown"
        if mode != self.mode:
            # Points since the previous read may straddle this transition.
            self.kind = "unknown"
            self.phase += 1
            self.mode = mode
            self.wake.set()
        elif self.kind != "unknown":
            self.kind = new_kind

    def disconnected(self) -> None:
        self.history.interrupt("disconnected")
        self.coordinator._publish_card_update()

    async def clear(self) -> None:
        self.generation += 1
        previous = self.history.current
        self.history = RouteHistory()
        # Clearing the drawing must not request an entire, potentially large
        # device backlog while a route is already being consumed.
        if previous is not None and (self.active or self.mode == "pause"):
            self.history.start(previous["map_id"])
            self.history.current["cursor"] = previous["cursor"]
            self.history.current["path_id"] = previous["path_id"]
            self.history.current["incomplete"] = previous["cursor"] > 0
            self.boundary = False
        else:
            self.boundary = True
        await self._save()
        self.coordinator._publish_card_update()
        self.wake.set()

    async def stop(self) -> None:
        if self.stopping:
            return
        self.stopping = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        if self.history.current:
            self.history.interrupt("stopped")
        await self._save()

    async def _capture(self) -> None:
        history = self.history
        generation = self.generation
        if self.boundary:
            history.finish()
            self.boundary = False
        if history.current is None:
            if not self.active or self.map_id is None:
                return
            history.start(self.map_id)
        requested_kind = self.kind
        requested_phase = self.phase
        cursor = history.cursor
        try:
            chunk = await self.hass.async_add_executor_job(partial(
                self.coordinator.client.get_path_chunk, cursor,
                expected_path_id=history.current["path_id"], detect_path_change=True,
            ))
            if self.stopping or generation != self.generation:
                return
            if self.boundary:
                history.interrupt("activity_changed")
                return
            kind = requested_kind if requested_phase == self.phase else "unknown"
            accepted = history.ingest(chunk, kind)
            _LOGGER.debug("ZK901 route path=%s cursor=%s count=%s accepted=%s", chunk.get("pathID"), cursor, chunk.get("pointCounts"), accepted)
            self.kind = "cleaning" if self.mode == "sweep" else "return" if self.mode == "backcharge" else "unknown"
        except (ZK901Error, ValueError) as err:
            if generation != self.generation:
                return
            history.interrupt("timeout_or_invalid_response")
            _LOGGER.warning("ZK901 route read failed at cursor=%s: %s", cursor, type(err).__name__)
        if not self.active and self.mode != "pause":
            history.finish()
        await self._save()
        self.coordinator._publish_card_update()

    async def _save(self) -> None:
        async with self.save_lock:
            try:
                await self.store.async_save(self.history.dump())
            except (OSError, HomeAssistantError):
                self.history.error = "storage_unavailable"
                _LOGGER.error("ZK901 route history could not be saved")

    async def _run(self) -> None:
        while not self.stopping:
            await self.wake.wait()
            self.wake.clear()
            due = asyncio.get_running_loop().time() + INTERVAL
            await self._capture()
            while self.active and not self.stopping:
                try:
                    await asyncio.wait_for(self.wake.wait(), timeout=max(0, due - asyncio.get_running_loop().time()))
                    self.wake.clear()
                except TimeoutError:
                    pass
                due = asyncio.get_running_loop().time() + INTERVAL
                await self._capture()
