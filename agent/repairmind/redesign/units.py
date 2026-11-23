"""Small, strict quantities for design briefs.

Every number in a brief carries a unit, and is converted to SI once, here. A bare number for a
dimension or a load is refused: mixing mm and m, or N and kN, is the classic engineering mistake.
No third-party units library is needed for the handful of quantities a brief holds.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# unit spelling -> (dimension, factor to SI, offset to SI). SI value = value * factor + offset.
_UNITS: dict[str, tuple[str, float, float]] = {}


def _add(dimension: str, factor: float, *names: str, offset: float = 0.0) -> None:
    for n in names:
        _UNITS[n] = (dimension, factor, offset)


_add("length", 1.0, "m", "metre", "meter", "metres", "meters")
_add("length", 1e-3, "mm", "millimetre", "millimeter", "millimetres", "millimeters")
_add("length", 1e-2, "cm")
_add("length", 1e-6, "um", "µm", "micron", "microns")
_add("length", 0.0254, "in", "inch", "inches", '"')
_add("length", 0.3048, "ft", "foot", "feet")
_add("mass", 1.0, "kg")
_add("mass", 1e-3, "g", "gram", "grams")
_add("mass", 0.45359237, "lb", "lbs")
_add("force", 1.0, "n", "newton", "newtons")
_add("force", 1e3, "kn")
_add("force", 4.4482216, "lbf")
_add("force", 9.80665, "kgf")
_add("torque", 1.0, "n·m", "n*m", "nm", "n-m", "n m")
_add("torque", 1e-3, "n·mm", "n*mm", "nmm")
_add("torque", 0.112984829, "lbf·in", "lbf*in", "lbf-in", "in-lb", "in·lb")
_add("torque", 1.35581795, "lbf·ft", "lbf*ft", "ft-lb", "ft·lb")
_add("pressure", 1.0, "pa")
_add("pressure", 1e3, "kpa")
_add("pressure", 1e6, "mpa", "n/mm2", "n/mm²")
_add("pressure", 1e9, "gpa")
_add("pressure", 1e5, "bar")
_add("pressure", 6894.757, "psi")
_add("temperature", 1.0, "k", "kelvin")
_add("temperature", 1.0, "°c", "c", "degc", "celsius", offset=273.15)
_add("temperature", 5 / 9, "°f", "f", "degf", "fahrenheit", offset=273.15 - 32 * 5 / 9)
_add("angular_speed", 2 * 3.141592653589793 / 60, "rpm")
_add("angular_speed", 1.0, "rad/s")
_add("speed", 1.0, "m/s")
_add("speed", 1 / 3.6, "km/h", "kmh")
_add("power", 1.0, "w", "watt", "watts")
_add("power", 1e3, "kw")
_add("voltage", 1.0, "v", "volt", "volts")
_add("current", 1.0, "a", "amp", "amps")
_add("current", 1e-3, "ma")
_add("time", 1.0, "s", "sec", "second", "seconds")
_add("time", 60.0, "min", "minute", "minutes")
_add("time", 3600.0, "h", "hr", "hour", "hours")
_add("cycles", 1.0, "cycle", "cycles")
_add("frequency", 1.0, "hz")

SI_UNIT = {
    "length": "m", "mass": "kg", "force": "N", "torque": "N·m", "pressure": "Pa", "temperature": "K",
    "angular_speed": "rad/s", "speed": "m/s", "power": "W", "voltage": "V", "current": "A", "time": "s",
    "cycles": "cycles", "frequency": "Hz",
}

_NUM = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?"
_QTY = re.compile(rf"^\s*({_NUM})\s*(.*?)\s*$", re.IGNORECASE)


class UnitError(ValueError):
    """A value is missing its unit, or the unit is unknown or of the wrong kind."""


@dataclass(frozen=True)
class Quantity:
    value: float          # as the person gave it
    unit: str             # as the person gave it
    dimension: str
    si: float             # value in SI_UNIT[dimension]

    @property
    def si_unit(self) -> str:
        return SI_UNIT[self.dimension]

    def to_dict(self) -> dict:
        return {"value": self.value, "unit": self.unit, "dimension": self.dimension, "si": self.si,
                "si_unit": self.si_unit}


def _normalise_unit(unit: str) -> str:
    u = unit.strip().lower().replace("⋅", "·").replace("−", "-")
    u = re.sub(r"\s+", " ", u)
    return u


def parse(text: str | float | int, unit: str = "", *, expect: str | None = None) -> Quantity:
    """Parse "12 mm", or (12, "mm"). Raises UnitError for a bare number or an unknown/mismatched unit."""
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        value, u = float(text), unit
    else:
        m = _QTY.match(str(text))
        if not m:
            raise UnitError(f"'{text}' is not a number with a unit, e.g. '12 mm'.")
        value, u = float(m.group(1)), (m.group(2) or unit)
    key = _normalise_unit(u)
    if not key:
        raise UnitError(f"{value:g} has no unit. Give it one, e.g. '{value:g} mm' or '{value:g} N'.")
    if key not in _UNITS:
        raise UnitError(f"Unknown unit '{u}'.")
    dimension, factor, offset = _UNITS[key]
    if expect and dimension != expect:
        raise UnitError(f"'{value:g} {u}' is a {dimension.replace('_', ' ')}, but a {expect.replace('_', ' ')} "
                        "was expected here.")
    return Quantity(value=value, unit=u.strip(), dimension=dimension, si=value * factor + offset)


def dimension_of(unit: str) -> str | None:
    hit = _UNITS.get(_normalise_unit(unit))
    return hit[0] if hit else None
