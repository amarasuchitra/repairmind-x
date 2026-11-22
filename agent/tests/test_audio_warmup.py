import threading

from livekit import rtc

from repairmind import audio_warmup


def test_warm_up_runs_once_and_resamplers_work_after():
    audio_warmup.warm_up_resampler()
    audio_warmup.warm_up_resampler()  # second call is a no-op
    assert audio_warmup._done

    errors = []

    def work():
        try:
            r = rtc.AudioResampler(48000, 16000, num_channels=1)
            out = r.push(bytearray(960 * 2)) + r.flush()
            assert sum(f.samples_per_channel for f in out) > 0
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
