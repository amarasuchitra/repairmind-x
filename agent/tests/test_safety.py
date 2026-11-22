import pytest

from repairmind import safety
from repairmind.safety import RiskLevel


@pytest.mark.parametrize("text", [
    "Samsung microwave not heating",
    "replace the breaker panel switch",
    "gas stove igniter clicking",
    "recharge the car AC with R134a",
    "airbag light is on, remove the steering wheel airbag",
    "replace the car brake caliper",
    "Tesla EV battery module",
    "my phone battery is swollen",
    "old CRT monitor flyback",
    "insulin pump not working",
    "open the power supply and replace the capacitor",
    "can I bypass the interlock on the door",
    "garage door torsion spring snapped",
])
def test_red_cases(text):
    assert safety.assess(text).level is RiskLevel.RED


@pytest.mark.parametrize("text,precaution", [
    ("washing machine won't drain", safety.UNPLUGGED),
    ("iPhone 13 screen cracked", safety.BATTERY_REMOVED_OR_CHECKED),
    ("leaky kitchen tap", safety.WATER_SHUT_OFF),
    ("conveyor belt slipping", safety.POWER_ISOLATED),
    ("change a car tyre", safety.VEHICLE_SECURED),
])
def test_amber_cases_require_precautions(text, precaution):
    a = safety.assess(text)
    assert a.level is RiskLevel.AMBER
    assert precaution in a.precautions


@pytest.mark.parametrize("text", [
    "bike chain fell off",
    "squeaky door hinge",
    "replace the RAM stick",  # no battery word
    "tighten the loose chair leg",
    "replace resistor r10 on the guitar pedal",  # must not look like refrigerant
    "press the reset button",  # must not look like an industrial press
    "the gas pedal on my piano bench",  # 'gas pedal' is not a gas appliance
])
def test_green_cases(text):
    assert safety.assess(text).level is RiskLevel.GREEN


def test_word_boundaries():
    # "tap" must not match inside "laptop"; a laptop is amber for its battery, not plumbing.
    a = safety.assess("laptop keyboard")
    assert safety.WATER_SHUT_OFF not in a.precautions
    assert a.level is RiskLevel.AMBER


def test_level_never_drops():
    base = safety.assess("microwave")
    after = safety.assess("just a loose knob", base=base)
    assert after.level is RiskLevel.RED


@pytest.mark.parametrize("step,label", [
    ("Cut the zip tie holding the cable", "cutting"),
    ("Use a spudger to pry the screen", "prying parts that may crack or snap"),
    ("Disconnect the battery connector", "handling the battery"),
    ("Apply thread lock to the bolt", "gluing or applying adhesive"),
    ("Flash the firmware", "flashing firmware"),
])
def test_irreversible(step, label):
    assert label in safety.irreversible_actions(step)


def test_reversible_step():
    assert safety.irreversible_actions("Remove the four Phillips screws on the back cover") == []
    assert safety.irreversible_actions("Check the information on the label") == []


@pytest.mark.parametrize("utterance", [
    "I can see smoke coming out",
    "it smells like something is burning",
    "there were sparks when I plugged it in",
    "I think I smell gas",
    "I just got a shock",
    "ouch I cut myself",
])
def test_hazards_detected(utterance):
    assert safety.detect_hazards(utterance)


@pytest.mark.parametrize("utterance", [
    "there's no smoke and no burning smell",
    "I replaced the spark plug last week",
    "it isn't sparking",
    "the battery is not swollen",
])
def test_hazards_negated_or_irrelevant(utterance):
    assert safety.detect_hazards(utterance) == []
