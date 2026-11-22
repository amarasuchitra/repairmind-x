"""Work around a crash in the LiveKit native audio library on Windows.

The resampler inside livekit_ffi.dll (libsoxr) sets up a shared FFT table the first
time any resampler runs, without a lock. A call creates several resamplers at once on
different native threads (mic in, Gemini in, voice out), and on Windows two of them can
race on that first setup. The DLL is built with assertions on, so the loser hits
`assert(LSX_FFT_BR == NULL)` in soxr-sys/src/fft4g_cache.h and the job process dies
with a Visual C++ "Assertion failed" dialog right after the call starts listening.

The table is only ever set up once per process and is not freed until exit. Running one
resampler of each quality on a single thread before the room connects sets it up
safely, so the later concurrent resamplers skip the racy path.
"""

from __future__ import annotations

import logging
import threading

from livekit import rtc

log = logging.getLogger("repairmind.audio_warmup")

_lock = threading.Lock()
_done = False


def warm_up_resampler() -> None:
    """Initialise libsoxr's shared FFT cache once, on the calling thread."""
    global _done
    with _lock:
        if _done:
            return
        # 48 kHz room audio <-> 16/24 kHz Gemini audio, both directions, every quality,
        # so every precision variant of the cache is created here and not mid-call.
        rates = [(48000, 16000), (48000, 24000), (24000, 48000), (16000, 48000)]
        for quality in rtc.AudioResamplerQuality:
            for rate_in, rate_out in rates:
                try:
                    r = rtc.AudioResampler(rate_in, rate_out, num_channels=1, quality=quality)
                    silence = bytearray(rate_in // 50 * 2)  # 20 ms of 16-bit mono
                    for _ in range(3):
                        r.push(silence)
                    r.flush()
                except Exception:  # never block a call over the warm-up itself
                    log.exception("resampler warm-up failed for %s %s->%s", quality, rate_in, rate_out)
        _done = True
