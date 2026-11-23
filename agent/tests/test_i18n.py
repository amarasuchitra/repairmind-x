"""Multilingual support: language rules, value-preserving translation, hazard words in other languages."""

import asyncio
import json

import jwt as _jwt
import pytest
from fastapi.testclient import TestClient

from repairmind import agent, i18n, safety, token_server


def test_normalize():
    assert i18n.normalize("hi") == "hi"
    assert i18n.normalize("hi-IN") == "hi"
    assert i18n.normalize("TA_in") == "ta"
    assert i18n.normalize("auto") == "auto"
    assert i18n.normalize("xx") == ""
    assert i18n.normalize(None) == ""


def test_call_rules_keep_tools_in_english():
    rules = i18n.call_rules("te")
    assert "Telugu" in rules and "తెలుగు" in rules
    assert "Write every tool argument in English" in rules
    auto = i18n.call_rules("auto", "hi")
    assert "language the user speaks" in auto and "Hindi" in auto
    assert "Write every tool argument in English" in auto


def test_say_in_keeps_english_wording_for_english():
    assert i18n.say_in("en", "", "Stop now.") == "Say exactly, calmly and slowly: Stop now."
    hi = i18n.say_in("hi", "", "Stop now.")
    assert "Hindi" in hi and "nothing left out" in hi and hi.endswith("Stop now.")


def test_greeting_language():
    assert i18n.greeting_language("en") == ""
    assert "Kannada" in i18n.greeting_language("kn")
    assert "Tamil" in i18n.greeting_language("auto", "ta")


def test_design_rules_protect_engineering_fields():
    assert i18n.design_rules("en") == ""
    rules = i18n.design_rules("mr")
    assert "Marathi" in rules
    for kept in ("symbols", "expressions", "units", "Western digits", "enum values"):
        assert kept in rules


def test_gemini_code_is_opt_in(monkeypatch):
    monkeypatch.delenv("RMX_GEMINI_SET_LANGUAGE", raising=False)
    assert i18n.gemini_language_code("hi") == ""
    monkeypatch.setenv("RMX_GEMINI_SET_LANGUAGE", "1")
    assert i18n.gemini_language_code("hi") == "hi-IN"
    assert i18n.gemini_language_code("pa") == ""  # not offered by the Live API
    assert i18n.gemini_language_code("auto") == ""


@pytest.mark.parametrize("src,out,ok", [
    ("Charge a 12 V battery in 4 m/s wind", "4 m/s हवा में 12 V बैटरी चार्ज करें", True),
    ("Charge a 12 V battery in 4 m/s wind", "4 मीटर/सेकंड हवा में 12 वोल्ट बैटरी", False),  # units translated
    ("Step 3 of 4", "4 में से चरण 3", True),
    ("Step 3 of 4", "चरण 3", False),  # a number dropped
    ("{n} failing", "{n} विफल", True),
    ("{n} failing", "विफल", False),  # placeholder dropped
    ("Hold the door shut, about 20 N", "दरवाज़ा बंद रखें, लगभग 20 N", True),
    ("Max temperature 60 °C", "अधिकतम तापमान 60°C", True),
])
def test_keeps_values(src, out, ok):
    assert i18n.keeps_values(src, out) is ok


def test_native_digits_become_western():
    assert i18n._ascii_digits("१२ V") == "12 V"
    assert i18n._ascii_digits("٤ m/s") == "4 m/s"


def test_translate_caches_and_rejects(tmp_path, monkeypatch):
    monkeypatch.setenv("RMX_I18N_DIR", str(tmp_path))
    monkeypatch.setattr(i18n, "_cache", i18n._Cache())
    calls = []

    async def fake(lang, texts):
        calls.append(list(texts))
        table = {"Start a repair": "मरम्मत शुरू करें", "Wall thickness 2 mm": "दीवार की मोटाई २ mm",
                 "Load 20 N": "भार बीस न्यूटन"}
        return [table[t] for t in texts]

    monkeypatch.setattr(i18n, "_model_translate", fake)
    texts = ["Start a repair", "Wall thickness 2 mm", "Load 20 N"]
    out, ok = asyncio.run(i18n.translate("hi", texts))
    assert out == ["मरम्मत शुरू करें", "दीवार की मोटाई 2 mm", "Load 20 N"]  # bad one stays English
    assert ok == [True, True, False]
    saved = json.loads((tmp_path / "hi.json").read_text(encoding="utf-8"))
    assert len(saved) == 2

    # second time: cached ones are not asked again
    out2, _ = asyncio.run(i18n.translate("hi", texts[:2]))
    assert out2 == out[:2]
    assert len(calls) == 1


def test_translate_english_is_identity():
    assert asyncio.run(i18n.translate("en", ["Hello"])) == (["Hello"], [False])


def test_translate_api(tmp_path, monkeypatch):
    monkeypatch.setenv("RMX_I18N_DIR", str(tmp_path))
    monkeypatch.setattr(i18n, "_cache", i18n._Cache())
    monkeypatch.setattr(i18n, "_model_translate", lambda lang, texts: _done([f"[{lang.code}] {t}" for t in texts]))
    from repairmind import checker
    monkeypatch.setattr(checker, "provider", lambda: "gemini")
    client = TestClient(token_server.app)
    r = client.post("/api/i18n/translate", json={"lang": "ta", "texts": ["Mute", "Step 3 of 4"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"translations": ["[ta] Mute", "[ta] Step 3 of 4"], "translated": [True, True]}
    assert client.post("/api/i18n/translate", json={"lang": "xx", "texts": ["Mute"]}).status_code == 400
    assert len(client.get("/api/i18n/languages").json()) == len(i18n.LANGUAGES)


def test_translate_api_without_model(monkeypatch):
    from repairmind import checker
    monkeypatch.setattr(checker, "provider", lambda: None)
    r = TestClient(token_server.app).post("/api/i18n/translate", json={"lang": "hi", "texts": ["Mute"]})
    assert r.status_code == 503


async def _done(value):
    return value


def test_token_carries_language(monkeypatch):
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    monkeypatch.setenv("LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "x" * 32)
    r = TestClient(token_server.app).post("/api/token", json={"accepted_notice": True, "language": "hi-IN"})
    claims = _jwt.decode(r.json()["participant_token"], "x" * 32, algorithms=["HS256"], options={"verify_aud": False})
    meta = json.loads(claims["roomConfig"]["agents"][0]["metadata"])
    assert meta["language"] == "hi"


def test_agent_reads_language_metadata():
    assert agent._languages('{"language": "ml", "ui_language": "ml"}') == ("ml", "ml")
    assert agent._languages('{"language": "klingon"}') == ("auto", "")
    assert agent._languages("not json") == ("auto", "")
    assert agent._languages("") == ("auto", "")


@pytest.mark.parametrize("utterance,label", [
    ("धुआं निकल रहा है", "smoke"),
    ("dhuan aa raha hai machine se", "smoke"),
    ("मुझे करंट लगा", "an electric shock"),
    ("motor se chingari nikli", "sparks"),
    ("gas ki smell aa rahi hai", "a gas smell"),
    ("আগুন লেগেছে", "fire"),
    ("పొగ వస్తోంది", "smoke"),
    ("கருகிய வாசனை வருகிறது", "a burning smell"),
    ("ಕಿಡಿ ಬರುತ್ತಿದೆ", "sparks"),
    ("ഷോക്കേറ്റു", "an electric shock"),
    ("ਅੱਗ ਲੱਗ ਗਈ", "fire"),
    ("હાથમાંથી લોહી નીકળે છે", "an injury"),
    ("बैटरी फूल गई है", "a swelling battery"),
    ("sale humo del motor", "smoke"),
    ("ça sent le brûlé", "a burning smell"),
    ("ich habe einen Stromschlag bekommen", "an electric shock"),
    ("هناك دخان", "smoke"),
    ("插座冒烟了", "smoke"),
    ("ガス臭い", "a gas smell"),
])
def test_hazards_in_other_languages(utterance, label):
    assert label in safety.detect_hazards(utterance)


@pytest.mark.parametrize("utterance", [
    "धुआं नहीं है",           # no smoke
    "आगे बढ़ो",               # "go ahead" contains आग (fire)
    "આગળ જાઓ",              # Gujarati "go ahead"
    "ਅੱਗੇ ਚੱਲੋ",              # Punjabi "go ahead"
    "புகைப்படம் எடுக்கவும்",   # Tamil "take a photo" starts with புகை (smoke)
    "no hay humo",
    "没有冒烟",
    "the verbrauch is high",
])
def test_no_false_hazards_in_other_languages(utterance):
    assert safety.detect_hazards(utterance) == []
