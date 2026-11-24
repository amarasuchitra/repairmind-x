"""Shared test setup."""

import pytest


@pytest.fixture(autouse=True)
def _no_backoff_waits(monkeypatch):
    """Model retries back off for seconds in real use; tests don't need to wait for them."""
    from repairmind import checker

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(checker, "_sleep", no_wait)
