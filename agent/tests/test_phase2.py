import asyncio

from repairmind import reviewer, speech_guard
from repairmind.manuals import ManualIndex, Passage, split_pages
from repairmind.session import Hypothesis, RepairSession


def bike(review=False) -> RepairSession:
    s = RepairSession(review_required=review)
    s.identify_device("bicycle", "Trek", "FX 2", model_confirmed=True, source="label")
    s.record_history_answer("What happened?", "Chain came off while shifting")
    s.record_history_answer("Noises?", "Clicking")
    s.record_test("Spun pedals", "No drive")
    s.update_hypotheses([Hypothesis("Chain derailed", 0.9), Hypothesis("Bent hanger", 0.3)])
    s.set_diagnosis("Chain derailed", 0.9, ["chain off ring"])
    return s


# ------------------------------------------------------------------ manuals
def test_split_pages_keeps_page_numbers():
    passages = split_pages(["short page one", "", "x " * 1000])
    assert passages[0].page == 1
    assert all(p.page == 3 for p in passages[1:])
    assert len(passages) > 2


def test_manual_search_ranks_relevant_page():
    idx = ManualIndex("Bosch WAN28 manual", [
        Passage(12, "Safety instructions. Always unplug the appliance before cleaning."),
        Passage(32, "Cleaning the drain pump filter. Open the service flap at the bottom right. Place a bowl "
                    "underneath. Unscrew the drain pump filter slowly anticlockwise; water will run out."),
        Passage(40, "Detergent drawer cleaning and descaling."),
    ])
    hits = idx.search("drain pump filter blocked E18")
    assert hits and hits[0]["page"] == 32 and hits[0]["ref"] == "Bosch WAN28 manual p.32"


def test_manual_roundtrip(tmp_path):
    idx = ManualIndex("M", [Passage(1, "hello world")])
    p = tmp_path / "m.json"
    idx.save(p)
    assert ManualIndex.load(p).search("hello")[0]["page"] == 1


def test_manual_from_real_pdf():
    from pypdf import PdfWriter
    import io

    w = PdfWriter()
    w.add_blank_page(200, 200)
    buf = io.BytesIO()
    w.write(buf)
    idx = ManualIndex.from_pdf("blank", buf.getvalue())
    assert idx.search("anything") == []


# ------------------------------------------------------------ speech guard
def test_guard_flags_ungated_instruction():
    s = bike()
    v = speech_guard.check("Okay, now remove the four screws on the back cover.", s)
    assert v and v.kind == "ungated_step"


def test_guard_allows_safe_and_conversational_speech():
    s = bike()
    assert speech_guard.check("Could you show me the back of the bike?", s) is None
    assert speech_guard.check("First, unplug it from the wall. Then show me the label.", s) is None
    assert speech_guard.check("I think the chain has come off the front ring.", s) is None


def test_guard_allows_active_step():
    s = bike()
    r = s.propose_step("Lift the chain onto the small front ring", "manual", "Trek p.12", "chain on ring")
    assert r.allowed
    assert speech_guard.check("Now lift the chain onto the small front ring.", s) is None


def test_guard_flags_irreversible_without_confirmation():
    s = bike()
    s.propose_step("Lift the chain onto the small front ring", "manual", "Trek p.12", "chain on ring")
    v = speech_guard.check("Next, cut the old cable tie.", s)
    assert v and v.kind == "irreversible_unapproved"


def test_guard_flags_red_instruction():
    s = bike()
    v = speech_guard.check("Go ahead and open the microwave cover.", s)
    assert v and v.kind == "red_instruction"


# ---------------------------------------------------------------- reviewer
def test_reviewer_fails_closed_without_credentials(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    r = asyncio.run(reviewer.review_step(bike(), "Lift the chain", "manual", "p.12", "", "chain on"))
    assert r.status == "unavailable"


def test_reviewer_evidence_includes_key_facts():
    text = reviewer._evidence(bike(), "Lift the chain", "manual", "Trek p.12", "excerpt here", "on ring")
    for needle in ("FX 2", "Chain derailed", "Spun pedals", "Trek p.12", "excerpt here"):
        assert needle in text


def test_contradictory_approve_is_downgraded(monkeypatch):
    class FakeResp:
        stop_reason = "end_turn"
        parsed_output = reviewer.Review(diagnosis_supported=True, step_matches_model_and_source=False,
                                        verdict="approve", reason="looks fine")

    class FakeMessages:
        async def parse(self, **kw):
            return FakeResp()

    class FakeClient:
        def __init__(self, **kw):
            self.messages = FakeMessages()

    import anthropic
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(anthropic, "AsyncAnthropic", FakeClient)
    r = asyncio.run(reviewer.review_step(bike(), "Lift the chain", "manual", "p.12", "", "on"))
    assert r.status == "revise"
