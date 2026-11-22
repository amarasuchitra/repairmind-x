"""Keeps the latest full-resolution frame of the user's camera.

The live model only sees ~1 low-res frame per second. When the mechanic needs detail (reading a label,
checking a connector) or the reviewer needs evidence, we grab the newest full frame from here.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time

from livekit import rtc
from livekit.agents.utils import images

log = logging.getLogger("repairmind.frames")


class FrameGrabber:
    def __init__(self) -> None:
        self._latest: rtc.VideoFrame | None = None
        self._at = 0.0
        self._task: asyncio.Task | None = None
        self._track_sid: str | None = None

    def attach(self, room: rtc.Room) -> None:
        @room.on("track_subscribed")
        def _on_track(track: rtc.Track, pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
            if track.kind == rtc.TrackKind.KIND_VIDEO and not participant.identity.startswith("agent"):
                self._start(track)

        for p in room.remote_participants.values():
            for pub in p.track_publications.values():
                if pub.track and pub.track.kind == rtc.TrackKind.KIND_VIDEO:
                    self._start(pub.track)

    def _start(self, track: rtc.Track) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._track_sid = track.sid
        self._task = asyncio.create_task(self._run(rtc.VideoStream(track)))

    async def _run(self, stream: rtc.VideoStream) -> None:
        try:
            async for event in stream:
                self._latest = event.frame
                self._at = time.monotonic()
        except asyncio.CancelledError:
            pass
        finally:
            await stream.aclose()

    @property
    def age_seconds(self) -> float | None:
        return None if self._latest is None else time.monotonic() - self._at

    def jpeg_b64(self, max_side: int = 1280, quality: int = 85) -> str | None:
        frame = self._latest
        if frame is None:
            return None
        w, h = frame.width, frame.height
        scale = min(1.0, max_side / max(w, h))
        opts = images.EncodeOptions(
            format="JPEG",
            quality=quality,
            resize_options=images.ResizeOptions(width=int(w * scale), height=int(h * scale),
                                                strategy="scale_aspect_fit") if scale < 1 else None,
        )
        return base64.b64encode(images.encode(frame, opts)).decode()
