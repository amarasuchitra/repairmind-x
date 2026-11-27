"""Live build coach: the project brief, wiring progress, and the board tools (with a stand-in arduino-cli)."""

import asyncio
import json
import os
import stat
import sys

import pytest

from repairmind.agent import _mode
from repairmind.coach import board
from repairmind.coach.brief import Brief, BuildState

BRIEF = {
    "name": "Glowing star toy", "board": "nano", "parts": ["Arduino Nano", "LED ring"], "sketch": "glowing_star_toy.ino",
    "wires": [
        {"n": 1, "text": "LED ring DIN → D6 (yellow wire)", "from": "LED ring DIN", "to": "D6", "colour": "yellow"},
        {"n": 2, "text": "LED ring GND → GND (black wire)", "from": "LED ring GND", "to": "GND", "colour": "black"},
    ],
    "pins": [{"pin": "D6", "use": "LED ring data"}],
    "steps": [{"title": "Load the code first", "detail": ["Plug in the Nano."]}],
    "code": "void setup(){}\nvoid loop(){}\n", "libs": ["Adafruit NeoPixel"],
}


def test_the_brief_reads_what_the_app_sends():
    b = Brief.model_validate(BRIEF)
    assert b.fqbn == "arduino:avr:nano"
    assert b.sketch_name == "glowing_star_toy"
    assert b.wires[0].from_ == "LED ring DIN"
    assert Brief.model_validate({**BRIEF, "sketch": "9 lives!"}).sketch_name == "sketch_9_lives"


def test_wiring_progress_moves_to_the_next_wire_and_the_model_sees_it():
    s = BuildState(brief=Brief.model_validate(BRIEF))
    assert s.next_wire().n == 1
    s.mark(1, seen=True)
    assert s.current == 2 and s.done == [1] and s.checked == [1]
    text = s.for_model()
    assert "1. LED ring DIN → D6 (yellow wire) [done, seen on camera]" in text
    assert "next is wire 2" in text
    s.mark(2, seen=False)
    assert s.wired and s.current == 0
    s.undo(2)
    assert not s.wired and s.current == 2
    assert s.mark(9, seen=True) is None


def test_build_calls_are_told_apart_by_the_dispatch_metadata():
    assert _mode(json.dumps({"mode": "build"})) == "build"
    assert _mode(json.dumps({"language": "hi"})) == "repair"
    assert _mode("not json") == "repair"


def test_ports_are_read_from_both_arduino_cli_layouts_and_the_right_one_is_picked():
    new = json.dumps({"detected_ports": [
        {"port": {"address": "COM3", "protocol": "serial", "protocol_label": "Serial Port (USB)"},
         "matching_boards": [{"name": "Arduino Nano", "fqbn": "arduino:avr:nano"}]},
        {"port": {"address": "COM1", "protocol": "serial", "protocol_label": "Serial Port"}},
        {"port": {"address": "192.168.1.5", "protocol": "network"}},
    ]})
    found = board.parse_ports(new)
    assert [p.address for p in found] == ["COM3", "COM1"]
    assert board.pick_port(found, "nano").address == "COM3"
    assert board.pick_port(found, "esp32") is None, "two COM ports and none is an ESP32: ask, don't guess"
    assert board.pick_port(found, "esp32", "com1").address == "COM1"
    old = json.dumps([{"address": "/dev/ttyUSB0", "protocol": "serial", "protocol_label": "Serial Port (USB)", "boards": []}])
    assert board.pick_port(board.parse_ports(old), "esp32").address == "/dev/ttyUSB0"
    assert board.parse_ports("garbage") == []


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    """A stand-in arduino-cli that records its arguments and answers like the real one."""
    log = tmp_path / "calls.txt"
    script = tmp_path / "arduino-cli"
    script.write_text(encoding="utf-8", data=f"""#!{sys.executable}
import json, sys
args = sys.argv[1:]
open({str(log)!r}, "a", encoding="utf-8").write(" ".join(args) + "\\n")
if args[:2] == ["board", "list"]:
    print(json.dumps({{"detected_ports": [{{"port": {{"address": "COM3", "protocol": "serial", "protocol_label": "Serial Port (USB)"}},
                                          "matching_boards": [{{"name": "Arduino Nano", "fqbn": "arduino:avr:nano"}}]}}]}}))
elif args[0] == "compile":
    print("Sketch uses 924 bytes (3%) of program storage space.")
elif args[0] == "upload":
    if "atmega328old" in args[2]:
        print("done")
    else:
        print("avrdude: stk500_recv(): programmer is not responding"); sys.exit(1)
elif args[0] == "monitor":
    print("Touch: yes\\nLights on"); sys.stdout.flush()
""")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    exe = script
    if os.name == "nt":  # Windows can't run a #! script directly: call it through a .cmd wrapper
        exe = tmp_path / "arduino-cli.cmd"
        exe.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    monkeypatch.setenv("RMX_ARDUINO_CLI", str(exe))
    monkeypatch.delenv("RMX_LOCAL_BOARD", raising=False)
    return log


def test_upload_compiles_then_retries_an_old_bootloader_nano(fake_cli, tmp_path):
    b = Brief.model_validate(BRIEF)
    r = asyncio.run(board.upload(b, tmp_path / "work"))
    assert r.ok, r.text
    assert "old-bootloader" in r.text
    assert (tmp_path / "work" / "glowing_star_toy" / "glowing_star_toy.ino").read_text(encoding="utf-8") == BRIEF["code"]
    calls = fake_cli.read_text(encoding="utf-8").splitlines()
    assert calls[0].startswith("board list")
    assert calls[1].startswith("compile --fqbn arduino:avr:nano")
    assert calls[-1].startswith("upload --fqbn arduino:avr:nano:cpu=atmega328old -p COM3")


def test_serial_output_comes_back_to_the_coach(fake_cli):
    r = asyncio.run(board.read_serial(Brief.model_validate(BRIEF), seconds=2))
    assert r.ok and "Lights on" in r.text


def test_without_arduino_cli_it_says_what_to_install(monkeypatch, tmp_path):
    monkeypatch.setenv("RMX_ARDUINO_CLI", str(tmp_path / "missing"))
    r = asyncio.run(board.compile_sketch(Brief.model_validate(BRIEF), tmp_path))
    assert not r.ok and "arduino-cli isn't installed" in r.text
    monkeypatch.setenv("RMX_LOCAL_BOARD", "0")
    assert "switched off" in board.unavailable()


def test_the_token_asks_for_the_build_coach(monkeypatch):
    from fastapi.testclient import TestClient
    from livekit import api
    from repairmind import token_server
    for k, v in {"LIVEKIT_URL": "wss://x", "LIVEKIT_API_KEY": "k", "LIVEKIT_API_SECRET": "s" * 32}.items():
        monkeypatch.setenv(k, v)
    r = TestClient(token_server.app).post("/api/token", json={"accepted_notice": True, "mode": "build"})
    assert r.status_code == 200, r.text
    claims = api.TokenVerifier("k", "s" * 32).verify(r.json()["participant_token"])
    meta = json.loads(claims.room_config.agents[0].metadata)
    assert meta["mode"] == "build"
