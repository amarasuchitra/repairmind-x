"""Deterministic safety rules for RepairMind X.

These rules are plain code on purpose. The language model never decides on its
own whether a repair is safe: every device and every step goes through these
checks, and nothing the model says can unlock a red-level repair.

Levels
------
GREEN  Guide fully.
AMBER  Guide only after mandatory precautions have been confirmed.
RED    No step-by-step instructions. Explain the danger, help describe the
       fault, and recommend a qualified professional.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import IntEnum


class RiskLevel(IntEnum):
    GREEN = 0
    AMBER = 1
    RED = 2

    @property
    def label(self) -> str:
        return self.name.lower()


@dataclass(frozen=True)
class Rule:
    key: str
    level: RiskLevel
    patterns: tuple[str, ...]
    reason: str
    precautions: tuple[str, ...] = ()


@dataclass
class Assessment:
    level: RiskLevel
    reasons: list[str] = field(default_factory=list)
    precautions: list[str] = field(default_factory=list)
    matched_rules: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "level": self.level.label,
            "reasons": self.reasons,
            "precautions": self.precautions,
            "matched_rules": self.matched_rules,
        }


# ---------------------------------------------------------------------------
# Precautions (ids are stable so the session can track which were confirmed)
# ---------------------------------------------------------------------------
UNPLUGGED = "unplugged"
BATTERY_REMOVED_OR_CHECKED = "battery_checked"
POWER_ISOLATED = "power_isolated"
COOLED_DOWN = "cooled_down"
WATER_SHUT_OFF = "water_shut_off"
PROTECTIVE_GEAR = "protective_gear"
VEHICLE_SECURED = "vehicle_secured"

PRECAUTION_TEXT = {
    UNPLUGGED: "The device is unplugged from the wall (show the loose plug on camera).",
    BATTERY_REMOVED_OR_CHECKED: "The battery is not swollen, punctured or hot (show it on camera).",
    POWER_ISOLATED: "Power is isolated at the switch or breaker and locked or tagged out.",
    COOLED_DOWN: "The device has cooled down and nothing is hot to the touch.",
    WATER_SHUT_OFF: "The water supply valve is closed and pressure released.",
    PROTECTIVE_GEAR: "Safety glasses and suitable gloves are on.",
    VEHICLE_SECURED: "The vehicle is on level ground, parked, engine off, wheels chocked.",
}


def _p(*words: str) -> tuple[str, ...]:
    return tuple(words)


# ---------------------------------------------------------------------------
# RED: never give step-by-step instructions
# ---------------------------------------------------------------------------
RED_RULES: tuple[Rule, ...] = (
    Rule("microwave_internal", RiskLevel.RED,
         _p(r"microwave"),
         "Microwave ovens hold a high-voltage capacitor that can kill even when unplugged."),
    Rule("mains_wiring", RiskLevel.RED,
         _p(r"fuse ?box", r"breaker (panel|box)", r"consumer unit", r"distribution board",
            r"wall (socket|outlet) wiring", r"(house|home|household|building) wiring",
            r"mains wiring", r"light switch wiring", r"rewir(e|ing)",
            r"electrical panel", r"(ceiling|light) fixture wiring"),
         "Fixed mains wiring can cause electrocution or fire and often legally requires a licensed electrician."),
    Rule("gas", RiskLevel.RED,
         _p(r"\bgas\b(?! ?(spring|strut|pedal|cap|tank cap|mileage))", r"propane", r"\blpg\b",
            r"natural gas", r"\bboiler\b", r"furnace", r"gas (stove|oven|hob|heater|line|valve|pipe)",
            r"water heater burner"),
         "Gas appliances can leak, explode or produce carbon monoxide. They need a certified gas engineer."),
    Rule("refrigerant", RiskLevel.RED,
         _p(r"refrigerant", r"\bfreon\b", r"\br-?(12|22|32|134a|404a|407c|410a|290|600a|1234yf)\b", r"compressor recharge",
            r"(ac|a/c|air ?con(ditioner)?) (recharge|regas|gas)", r"sealed system"),
         "Refrigerant systems are pressurised, harmful, and in most countries legally require certification."),
    Rule("airbag", RiskLevel.RED,
         _p(r"air ?bag", r"\bsrs\b", r"seat ?belt pretensioner"),
         "Airbags and pretensioners contain explosive charges that can fire unexpectedly."),
    Rule("brakes", RiskLevel.RED,
         _p(r"(car|vehicle|truck|motorbike|motorcycle|scooter) brake", r"brake (line|fluid|caliper|master cylinder|booster|hose)",
            r"\babs\b"),
         "Vehicle brakes are safety-critical. A mistake can cause a fatal crash."),
    Rule("fuel_system", RiskLevel.RED,
         _p(r"fuel (line|pump|tank|injector|rail)", r"petrol line", r"gasoline line"),
         "Fuel systems can leak and ignite."),
    Rule("high_voltage_battery", RiskLevel.RED,
         _p(r"\bev\b battery", r"electric (car|vehicle) battery", r"hybrid battery",
            r"high[- ]voltage battery", r"traction battery", r"\b(400|800) ?v\b",
            r"orange (cable|wire)s?", r"power ?wall", r"home battery"),
         "High-voltage traction and storage batteries can deliver lethal shocks and cause fires."),
    Rule("damaged_lithium", RiskLevel.RED,
         _p(r"swollen battery", r"swelling battery", r"battery (is )?(swollen|swelling|bulging|puffed|puffy|punctured|leaking|smoking|hot)",
            r"bulging battery", r"puffy battery", r"punctured battery", r"spicy pillow"),
         "A swollen or damaged lithium battery can catch fire or explode. Do not open or charge it."),
    Rule("crt", RiskLevel.RED,
         _p(r"\bcrt\b", r"cathode ray", r"tube (tv|television|monitor)", r"flyback"),
         "CRT displays store very high voltage long after being unplugged."),
    Rule("medical", RiskLevel.RED,
         _p(r"pacemaker", r"defibrillator", r"\baed\b", r"insulin pump", r"ventilator", r"oxygen concentrator",
            r"dialysis", r"medical device", r"hearing aid internals", r"cpap"),
         "Medical devices must be repaired by the manufacturer or an authorised service."),
    Rule("power_supply_internal", RiskLevel.RED,
         _p(r"inside (the )?(psu|power supply)", r"open (the )?(psu|power supply)", r"(psu|power supply) capacitor",
            r"inverter board", r"(tv|monitor) power board"),
         "Mains power supplies keep dangerous charge in their capacitors after unplugging."),
    Rule("industrial_no_lockout", RiskLevel.RED,
         _p(r"without (lockout|lock ?out|isolation)", r"while (it'?s |it is )?(running|energi[sz]ed|live|powered)",
            r"bypass(ing)? (the )?(interlock|guard|safety)", r"(disable|defeat|remove) (the )?(interlock|guard|safety switch)",
            r"live (work|wire|circuit)", r"hot[- ]wir(e|ing)"),
         "Working on live or unguarded equipment, or bypassing a safety interlock, is never allowed."),
    Rule("elevated_structural", RiskLevel.RED,
         _p(r"roof", r"load[- ]bearing", r"structural", r"garage door (torsion )?spring", r"torsion spring",
            r"chimney", r"scaffold"),
         "Work at height, on structures or on tensioned springs can cause serious injury."),
    Rule("pressure_vessel", RiskLevel.RED,
         _p(r"pressure (vessel|cooker valve)", r"air compressor tank", r"gas cylinder", r"\bcylinder valve\b"),
         "Pressure vessels can burst violently."),
)

# ---------------------------------------------------------------------------
# AMBER: guide only after precautions
# ---------------------------------------------------------------------------
AMBER_RULES: tuple[Rule, ...] = (
    Rule("mains_appliance", RiskLevel.AMBER,
         _p(r"washing machine", r"washer", r"dryer", r"dishwasher", r"fridge", r"refrigerator", r"freezer",
            r"oven", r"toaster", r"kettle", r"blender", r"vacuum", r"hair ?dryer", r"iron\b", r"heater",
            r"\bfan\b", r"air purifier", r"coffee (machine|maker)", r"espresso", r"printer", r"desktop (pc|computer)",
            r"\btv\b", r"television", r"monitor", r"lamp", r"speaker", r"amplifier", r"power tool", r"drill",
            r"angle grinder", r"\bsaw\b", r"motor", r"pump", r"plug(ged)? in", r"mains", r"\b(110|120|220|230|240) ?v\b"),
         "Mains-powered devices can shock if opened while connected.",
         (UNPLUGGED, PROTECTIVE_GEAR)),
    Rule("lithium_battery_device", RiskLevel.AMBER,
         _p(r"phone", r"smartphone", r"iphone", r"android", r"tablet", r"ipad", r"laptop", r"macbook", r"notebook",
            r"e-?bike", r"e-?scooter", r"power ?bank", r"drone", r"smart ?watch", r"headphones", r"earbuds",
            r"lithium", r"li-?ion", r"lipo", r"battery"),
         "Lithium batteries can catch fire if punctured, bent or shorted.",
         (BATTERY_REMOVED_OR_CHECKED, UNPLUGGED)),
    Rule("hot_device", RiskLevel.AMBER,
         _p(r"oven", r"stove", r"hob", r"iron\b", r"soldering", r"engine", r"exhaust", r"radiator", r"kettle"),
         "Parts may be hot enough to burn.",
         (COOLED_DOWN,)),
    Rule("plumbing", RiskLevel.AMBER,
         _p(r"(leaking|leaky|dripping|kitchen|bathroom|mixer|water) tap", r"tap (is )?(leak|drip)", r"faucet", r"toilet", r"sink", r"drain", r"pipe", r"shower", r"valve", r"leak"),
         "Water under pressure can flood and damage property.",
         (WATER_SHUT_OFF,)),
    Rule("vehicle_general", RiskLevel.AMBER,
         _p(r"\bcar\b", r"vehicle", r"truck", r"motorcycle", r"motorbike", r"scooter", r"tyre", r"tire", r"wheel nut",
            r"car battery", r"12 ?v battery", r"jump start"),
         "Vehicles can roll, and car batteries can short or spark.",
         (VEHICLE_SECURED, PROTECTIVE_GEAR)),
    Rule("industrial_machine", RiskLevel.AMBER,
         _p(r"conveyor", r"\bcnc\b", r"lathe", r"hydraulic press", r"punch press", r"press brake", r"robot arm", r"industrial", r"machine guard",
            r"gearbox", r"spindle", r"hydraulic", r"pneumatic"),
         "Industrial machines must be isolated and locked out before any work.",
         (POWER_ISOLATED, PROTECTIVE_GEAR)),
    Rule("sharp_or_glass", RiskLevel.AMBER,
         _p(r"glass", r"screen replacement", r"cracked screen", r"blade", r"razor"),
         "Broken glass and blades can cut.",
         (PROTECTIVE_GEAR,)),
)


# ---------------------------------------------------------------------------
# Irreversible actions: always warn, re-check, photo, explicit yes
# ---------------------------------------------------------------------------
IRREVERSIBLE_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bcut(ting)?\b", "cutting"),
    (r"\bsnip\b", "cutting"),
    (r"desolder", "desoldering"),
    (r"\bsolder", "soldering"),
    (r"\bdrill(ing)? (a |the |out )", "drilling"),
    (r"\bglue\b|adhesive|epoxy|super ?glue|thread ?lock|loctite", "gluing or applying adhesive"),
    (r"pry|prying|prise|lever (off|open)|spudger", "prying parts that may crack or snap"),
    (r"break (the )?(seal|adhesive|tab|clip)", "breaking a seal or clip"),
    (r"heat (gun|up the adhesive)|hot ?air", "heating adhesive"),
    (r"(flash|update|reset) (the )?(firmware|bios|ecu)", "flashing firmware"),
    (r"factory reset|wipe (the )?(data|device)|\bformat\b", "erasing data"),
    (r"(disconnect|remove|replace|swap) (the )?battery", "handling the battery"),
    (r"discharge", "discharging stored energy"),
    (r"(remove|peel) (the )?(warranty|void) (sticker|seal)", "voiding the warranty seal"),
    (r"grind|sand(ing)? down|file (down|off)", "removing material"),
    (r"(rivet|weld|crimp)", "permanent joining"),
    (r"bend (the )?", "bending parts"),
)

# Words in what the user says that mean: stop everything now.
HAZARD_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bsmoke\b|\bsmoking\b|smoky", "smoke"),
    (r"burning smell|smells? (like )?burn|smell of burning|something('?s| is) burning", "a burning smell"),
    (r"\bfire\b|flames?|on fire|caught fire", "fire"),
    (r"spark(s|ing|ed)?(?! ?plug)", "sparks"),
    (r"smell (of )?gas|gas smell|smells? like gas|rotten eggs?", "a gas smell"),
    (r"(got |getting |i got )?(an? )?(electric )?shock(ed)?|zapped|electrocut", "an electric shock"),
    (r"\bbleeding\b|\bblood\b|cut myself|i'?m hurt|injur(ed|y)|burn(ed|t) (myself|my)", "an injury"),
    (r"swell(ing|ed)|bulg(ing|e)|puff(ed|y)", "a swelling battery"),
    (r"hissing|popping sound|crackling", "hissing or crackling"),
    (r"(water|liquid) (near|on|in) (the )?(socket|outlet|plug|wire)", "water near electricity"),
)


def _match(patterns: tuple[str, ...], text: str) -> bool:
    # Whole words only (plurals allowed), so "tap" never matches "laptop".
    return any(re.search(rf"(?<![a-z0-9])(?:{p})(?:s|es)?(?![a-z0-9])", text) for p in patterns)


def _norm(*parts: str | None) -> str:
    return " ".join(p for p in parts if p).lower()


def assess(text: str, *, base: Assessment | None = None) -> Assessment:
    """Classify a device, problem or step description.

    The result is never lower than ``base``: once a session is amber or red,
    later text cannot lower it.
    """
    t = _norm(text)
    level = base.level if base else RiskLevel.GREEN
    reasons = list(base.reasons) if base else []
    precautions = list(base.precautions) if base else []
    matched = list(base.matched_rules) if base else []

    for rule in RED_RULES + AMBER_RULES:
        if rule.key in matched:
            continue
        if _match(rule.patterns, t):
            matched.append(rule.key)
            reasons.append(rule.reason)
            level = max(level, rule.level)
            for pc in rule.precautions:
                if pc not in precautions:
                    precautions.append(pc)
    return Assessment(level=level, reasons=reasons, precautions=precautions, matched_rules=matched)


def irreversible_actions(step_text: str) -> list[str]:
    t = _norm(step_text)
    found: list[str] = []
    for pattern, label in IRREVERSIBLE_PATTERNS:
        if re.search(pattern, t) and label not in found:
            found.append(label)
    return found


# The same stop words in the other languages the app speaks, plus romanised Hindi ("Hinglish"), because the
# live transcript comes back in whatever language the person speaks. Latin-script words use word boundaries;
# other scripts are matched as text (their vowel signs don't count as word characters). Kept to phrases that
# mean danger on their own: a word that is also part of a harmless word is written so it can't match there
# (Tamil புகை "smoke" is also the start of புகைப்படம் "photo").
HAZARD_PATTERNS_INTL: tuple[tuple[str, str], ...] = (
    (r"धुआं|धुआँ|धुंआ|धुँआ|\bdhu+a+n?\b|\bdhuwa\b|ধোঁয়া|ধোয়া|పొగ|धूर|புகை(?!ப்பட)|ધુમાડો|ಹೊಗೆ|പുക(?!ഴ)|ਧੂੰਆਂ|ਧੂਆਂ"
     r"|\bhumo\b|\bfum[ée]e\b|\brauch(t|en)?\b|دخان|冒烟|烟雾|煙が|煙", "smoke"),
    (r"आग(?![ेाऱर])|\baag\b|लपट|আগুন|మంటలు|మంట వస్త|ஒரு தீ|தீப்பிடி|தீ பிடி|நெருப்பு|આગ(?![ળેા])|ಬೆಂಕಿ|തീപിടി|തീ പിടി|ਅੱਗ(?![ੇਾ])"
     r"|\bfuego\b|\bincendio\b|\bllamas\b|\bfeu\b|\bflammes?\b|\bincendie\b|\bfeuer\b|\bflammen?\b|حريق|اشتعل"
     r"|着火|起火|火焰|失火|火事|炎が|発火", "fire"),
    (r"जलने की|जल रहा|जल रही|\bjalne ki\b|\bjal raha\b|পোড়া গন্ধ|পোড়া|కాలిన వాసన|కాలుతోంది|जळल्याचा|जळण्याचा"
     r"|எரியும் வாசனை|கருகிய|எரிகிறது|બળવાની|બળેલી|ಸುಟ್ಟ ವಾಸನೆ|ಸುಡುತ್ತಿದೆ|കരിഞ്ഞ|കത്തുന്ന മണം|ਸੜਨ ਦੀ|ਸੜ ਰਿਹਾ"
     r"|olor a quemado|sent (le )?br[ûu]l[ée]|se est[áa] quemando|odeur de br[ûu]l[ée]|[çc]a br[ûu]le|verbrannt|brandgeruch"
     r"|رائحة حريق|رائحة احتراق|يحترق|烧焦|焦味|糊味|焦げ", "a burning smell"),
    (r"चिंगारी|\bchingar[iy]\b|স্ফুলিঙ্গ|ফুলকি|నిప్పురవ్వ|ठिणगी|தீப்பொறி|તણખ|ಕಿಡಿ|തീപ്പൊരി|ਚੰਗਿਆੜ"
     r"|\bchispas?\b|[ée]tincelles?|\bfunken\b|شرار|火花", "sparks"),
    (r"गैस की (गंध|बू|बदबू|स्मेल)|\bgas ki (smell|badbu|boo|bu)\b|গ্যাসের গন্ধ|గ్యాస్ వాసన|गॅसचा वास|கேஸ் வாசனை"
     r"|எரிவாயு வாசனை|ગેસની ગંધ|ગેસની વાસ|ಗ್ಯಾಸ್ ವಾಸನೆ|ഗ്യാസ് മണം|ഗ്യാസിന്റെ മണം|ਗੈਸ ਦੀ (ਬੋ|ਗੰਧ|ਬਦਬੂ)"
     r"|olor a gas|odeur de gaz|gasgeruch|riecht nach gas|رائحة غاز|رائحة الغاز|煤气味|燃气味|闻到煤气|闻到燃气"
     r"|ガス臭|ガスの臭い|ガスのにおい", "a gas smell"),
    (r"करंट लग|करेंट लग|झटका लग|\bcurrent la?g\w*|\bjhatka\b|শক লেগেছে|কারেন্ট লেগেছে|షాక్ కొట్టి|కరెంట్ కొట్టి"
     r"|शॉक लाग|करंट लाग|ஷாக் அடி|மின்சாரம் தாக்கி|કરંટ લાગ|શૉક લાગ|ಶಾಕ್ ಹೊಡೆ|ಕರೆಂಟ್ ಹೊಡೆ|ഷോക്ക് അടി|ഷോക്കേറ്റു"
     r"|ਕਰੰਟ ਲੱਗ|ਝਟਕਾ ਲੱਗ|descarga el[ée]ctrica|\bcalambre\b|electrocut|[ée]lectrocut|d[ée]charge [ée]lectrique"
     r"|stromschlag|صعقة|صعق|触电|电到我|感電", "an electric shock"),
    (r"खून|चोट लग|कट गया|कट गई|\bkhoon\b|\bchot lag\w*|রক্ত|আঘাত লেগেছে|কেটে গেছে|రక్తం|గాయం|रक्त|जखम"
     r"|ரத்தம்|இரத்தம்|காயம்|લોહી|ઈજા|ರಕ್ತ|ಗಾಯ|രക്തം|മുറിവ്|ਖ਼ੂਨ|ਖੂਨ|ਸੱਟ ਲੱਗ"
     r"|\bsangre\b|\bherid[oa]\b|me (cort|quem)[ée]|\bsang\b|bless[ée]e?\b|je me suis (coup|br[ûu]l)[ée]"
     r"|\bblut(e|et)?\b|verletzt|ينزف|نزيف|جرح|إصابة|流血|受伤|出血|けが|怪我", "an injury"),
    (r"(बैटरी|battery|ব্যাটারি|బ్యాటరీ|பேட்டரி|બેટરી|ಬ್ಯಾಟರಿ|ബാറ്ററി|ਬੈਟਰੀ)\s*\S*\s*(फूल|phool|ফুলে|ఉబ్బ|फुग|வீங்க|ફૂલ|ಊದ"
     r"|വീർ|ਫੁੱਲ)|bater[íi]a hinchada|batterie gonfl[ée]e|akku (ist )?aufgebl[äa]ht|鼓包|膨張|膨らん",
     "a swelling battery"),
)

# "No smoke" in other languages: the negation usually comes right after the word ("धुआं नहीं").
_NEG_AFTER = re.compile(r"^\s*(है\s*)?(नहीं|नही|nahi+n?|না|నహీ|లేదు|ఏమీ లేదు|नाही|இல்லை|નથી|ಇಲ್ಲ|ഇല്ല|ਨਹੀਂ|ないです|ない|ありません|没有)")
_NEG_BEFORE = re.compile(r"(\b(no|not|never|without|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|sin|pas de|aucune?|kein\w*|nicht)\b"
                         r"|没有|没|لا يوجد|(?<!\w)لا(?!\w))[^.?!।，。！？]*$")


def detect_hazards(utterance: str) -> list[str]:
    t = _norm(utterance)
    # Ignore clearly negated mentions like "no smoke", "there's no burning smell" or "धुआं नहीं".
    found: list[str] = []
    for pattern, label in HAZARD_PATTERNS + HAZARD_PATTERNS_INTL:
        if label in found:
            continue
        for m in re.finditer(pattern, t):
            before = t[max(0, m.start() - 20): m.start()]
            after = t[m.end(): m.end() + 12]
            if _NEG_BEFORE.search(before) or _NEG_AFTER.match(after):
                continue
            found.append(label)
            break
    return found


HAZARD_STOP_MESSAGE = (
    "Stop now and step back. Don't touch the device. If it is safe to do so, switch it off at the wall or "
    "breaker, without touching the device itself. If there is fire, a gas smell, or someone is hurt, leave "
    "the area and call your local emergency number. We will not continue this repair until the danger is gone."
)


def red_refusal_message(assessment: Assessment) -> str:
    why = " ".join(dict.fromkeys(r for r in assessment.reasons))
    return (
        f"This is a repair I won't walk you through step by step, because it is dangerous. {why} "
        "I can help you describe the fault clearly so a qualified professional can fix it quickly, "
        "and I can tell you what to say when you contact them."
    )
