"""The computer work: compile the build's code, upload it to the board on USB and read what it prints.

It runs arduino-cli on the computer that runs the agent (the person's laptop), always with a fixed list of
arguments, never through a shell. The code is written into its own folder under the sessions folder, so nothing
else on the computer is touched. Set RMX_LOCAL_BOARD=0 to switch all of it off.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from .brief import Brief

TIMEOUT_COMPILE = 240.0
TIMEOUT_UPLOAD = 120.0


def enabled() -> bool:
    return os.getenv("RMX_LOCAL_BOARD", "1") != "0"


def cli() -> str | None:
    """The arduino-cli program: RMX_ARDUINO_CLI if set, else whatever is on the PATH."""
    custom = os.getenv("RMX_ARDUINO_CLI", "").strip()
    if custom:
        return custom if Path(custom).is_file() else None
    return shutil.which("arduino-cli")


@dataclass
class Result:
    ok: bool
    text: str


@dataclass
class Port:
    address: str
    label: str
    board: str
    fqbn: str


async def _run(args: list[str], timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, f"Timed out after {int(timeout)} s."
    return proc.returncode or 0, out.decode(errors="replace")


def unavailable() -> str | None:
    """Why the computer work can't run here, in words for the person, or None if it can."""
    if not enabled():
        return "Board tools are switched off on this computer (RMX_LOCAL_BOARD=0)."
    if not cli():
        return ("arduino-cli isn't installed on the computer running RepairMind. Install it from "
                "https://arduino.github.io/arduino-cli/latest/installation/ (or set RMX_ARDUINO_CLI to its path), "
                "or upload from the Arduino IDE instead.")
    return None


def parse_ports(raw: str) -> list[Port]:
    """`arduino-cli board list --format json`, old and new layouts, keeping only real serial ports."""
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    rows = data.get("detected_ports", []) if isinstance(data, dict) else data
    out: list[Port] = []
    for r in rows if isinstance(rows, list) else []:
        port = r.get("port", r) if isinstance(r, dict) else {}
        addr = str(port.get("address", ""))
        if not addr or port.get("protocol", "serial") != "serial":
            continue
        boards = r.get("matching_boards") or r.get("boards") or []
        b = boards[0] if boards else {}
        out.append(Port(addr, str(port.get("protocol_label", "") or port.get("label", "")), str(b.get("name", "")),
                        str(b.get("fqbn", ""))))
    return out


async def ports() -> list[Port]:
    exe = cli()
    if not exe or not enabled():
        return []
    code, out = await _run([exe, "board", "list", "--format", "json"], 30)
    return parse_ports(out) if code == 0 else []


def pick_port(found: list[Port], board: str, wanted: str = "") -> Port | None:
    """The port to use: the one asked for, else the one that matches the board, else the only USB serial port."""
    if wanted:
        return next((p for p in found if p.address.lower() == wanted.lower()), None)
    fam = {"esp32": "esp32:", "nano": "arduino:avr"}.get(board, "")
    match = [p for p in found if fam and p.fqbn.startswith(fam)]
    if len(match) == 1:
        return match[0]
    usb = [p for p in found if "usb" in (p.label + p.address).lower() or p.address.upper().startswith("COM")]
    return usb[0] if len(usb) == 1 else None


def write_sketch(brief: Brief, root: Path) -> Path:
    """Writes the code as <root>/<name>/<name>.ino and returns the folder."""
    name = brief.sketch_name
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.ino").write_text(brief.code, encoding="utf-8")
    return folder


def _tail(text: str, n: int = 12) -> str:
    lines = [x for x in text.strip().splitlines() if x.strip()]
    return "\n".join(lines[-n:])


async def compile_sketch(brief: Brief, root: Path) -> Result:
    why = unavailable()
    if why:
        return Result(False, why)
    if not brief.code.strip() or not brief.fqbn:
        return Result(False, "There's no code or no board in this project yet.")
    folder = write_sketch(brief, root)
    code, out = await _run([cli() or "", "compile", "--fqbn", brief.fqbn, str(folder)], TIMEOUT_COMPILE)
    if code == 0:
        return Result(True, "Compiled. " + _tail(out, 3))
    if "No such file or directory" in out and ".h" in out:
        return Result(False, "A library is missing on this computer: " + _tail(out, 4)
                      + f" Install it with: arduino-cli lib install \"<name>\". Libraries this project needs: "
                      + ", ".join(brief.libs))
    if "platform not installed" in out.lower() or "unknown fqbn" in out.lower():
        core = "esp32:esp32@2.0.17" if brief.board == "esp32" else "arduino:avr"
        return Result(False, f"The board package isn't installed. Run: arduino-cli core install {core}")
    return Result(False, "Compile failed:\n" + _tail(out))


async def upload(brief: Brief, root: Path, port: str = "") -> Result:
    why = unavailable()
    if why:
        return Result(False, why)
    found = await ports()
    p = pick_port(found, brief.board, port)
    if p is None:
        listed = ", ".join(f"{x.address} ({x.board or x.label or 'unknown'})" for x in found) or "none"
        return Result(False, f"Couldn't tell which USB port the board is on. Ports found: {listed}. "
                      "Plug the board in with a data USB cable, or name the port.")
    built = await compile_sketch(brief, root)
    if not built.ok:
        return built
    folder = root / brief.sketch_name
    code, out = await _run([cli() or "", "upload", "--fqbn", brief.fqbn, "-p", p.address, str(folder)], TIMEOUT_UPLOAD)
    if code == 0:
        return Result(True, f"Uploaded to the board on {p.address}.")
    low = out.lower()
    if "not in sync" in low or "stk500" in low:
        hint = "The Nano didn't answer. On clone boards set the processor to ATmega328P (Old Bootloader) and retry."
        if brief.board == "nano":
            code2, out2 = await _run([cli() or "", "upload", "--fqbn", "arduino:avr:nano:cpu=atmega328old", "-p",
                                      p.address, str(folder)], TIMEOUT_UPLOAD)
            if code2 == 0:
                return Result(True, f"Uploaded to the board on {p.address} (old-bootloader Nano).")
            out = out2
        return Result(False, hint + "\n" + _tail(out, 6))
    if "failed to connect to esp32" in low or "wrong boot mode" in low:
        return Result(False, "The ESP32 didn't enter upload mode. Hold its BOOT button while the upload starts, "
                      "then let go.\n" + _tail(out, 4))
    if "access is denied" in low or "permission denied" in low or "busy" in low:
        return Result(False, f"{p.address} is in use. Close the Arduino IDE's Serial Monitor or any other program "
                      "using the board, then try again.")
    return Result(False, "Upload failed:\n" + _tail(out))


async def read_serial(brief: Brief, seconds: float = 6.0, port: str = "", baud: int = 115200) -> Result:
    why = unavailable()
    if why:
        return Result(False, why)
    p = pick_port(await ports(), brief.board, port)
    if p is None:
        return Result(False, "Couldn't find the board's USB port to listen on.")
    seconds = max(1.0, min(20.0, seconds))
    proc = await asyncio.create_subprocess_exec(
        cli() or "", "monitor", "-p", p.address, "--config", f"baudrate={baud}", "--quiet",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.PIPE)
    chunks: list[bytes] = []

    async def pump() -> None:
        assert proc.stdout
        while True:
            b = await proc.stdout.read(1024)
            if not b:
                break
            chunks.append(b)

    try:
        await asyncio.wait_for(pump(), seconds)
    except asyncio.TimeoutError:
        pass
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    text = b"".join(chunks).decode(errors="replace").strip()
    if not text:
        return Result(True, f"Listened on {p.address} for {int(seconds)} s at {baud} baud: the board printed nothing.")
    return Result(True, f"The board printed (last lines):\n{_tail(text, 20)}")
