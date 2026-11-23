import numpy as np
import pytest
from PIL import Image

from repairmind.expert import detector, products
from repairmind.session import Hypothesis, RepairSession


@pytest.fixture(autouse=True)
def _fresh_cache():
    products.load_all.cache_clear()
    yield
    products.load_all.cache_clear()


def fan_session(monkeypatch, allow=True) -> RepairSession:
    if allow:
        monkeypatch.setenv("RMX_ALLOW_UNREVIEWED", "1")
    s = RepairSession(review_required=True)
    s.identify_device("desk fan", "Example", "EX-DF30B", model_confirmed=True, source="label")
    s.expert_product_id = "example-desk-fan"
    s.record_history_answer("What happens?", "It wobbles and rattles")
    s.record_history_answer("How long?", "A week")
    s.record_test("Looked at the blade", "Thick dust on the blade")
    s.update_hypotheses([Hypothesis("Dust build-up on blade", 0.9), Hypothesis("Loose blade cap", 0.4)])
    assert s.set_diagnosis("Dust build-up on blade", 0.92, ["dust visible", "wobble"]).allowed
    return s


def test_example_product_loads_and_matches():
    p = products.find_product("Example", "EX-DF30B")
    assert p and p.id == "example-desk-fan"
    assert products.find_product("Other", "EX-DF30B") is None
    assert products.find_product("Example", "") is None


def test_unreviewed_procedures_hidden_by_default(monkeypatch):
    monkeypatch.delenv("RMX_ALLOW_UNREVIEWED", raising=False)
    p = products.load_all()["example-desk-fan"]
    assert products.usable_procedures(p) == []
    monkeypatch.setenv("RMX_ALLOW_UNREVIEWED", "1")
    assert len(products.usable_procedures(p)) == 1


def test_step_ref_resolution():
    p = products.load_all()["example-desk-fan"]
    proc, st = p.step("example-desk-fan/clean-blade#s3")
    assert "left-hand thread" in st.text
    assert p.step("other/clean-blade#s3") is None
    assert p.step("example-desk-fan/clean-blade#s99") is None


def test_procedure_text_must_match(monkeypatch):
    s = fan_session(monkeypatch)
    r = s.propose_step("Pull the blade off", "procedure", "example-desk-fan/clean-blade#s4", "blade off")
    assert r.code == "procedure_text_mismatch"


def test_unreviewed_procedure_blocked_in_production(monkeypatch):
    s = fan_session(monkeypatch)
    monkeypatch.delenv("RMX_ALLOW_UNREVIEWED")
    text = products.load_all()["example-desk-fan"].step("example-desk-fan/clean-blade#s2")[1].text
    r = s.propose_step(text, "procedure", "example-desk-fan/clean-blade#s2", "guard off")
    assert r.code == "procedure_unreviewed"


def test_procedure_step_flow_with_precautions(monkeypatch):
    s = fan_session(monkeypatch)
    p = products.load_all()["example-desk-fan"]
    text = p.step("example-desk-fan/clean-blade#s2")[1].text
    r = s.propose_step(text, "procedure", "example-desk-fan/clean-blade#s2", "guard off")
    assert r.code == "precautions_missing"  # mains appliance: unplugged + protective gear
    s.confirm_precaution("unplugged", True)
    s.confirm_precaution("protective_gear", True)
    r = s.propose_step(text, "procedure", "example-desk-fan/clean-blade#s2", "guard off")
    assert r.allowed  # reviewed-procedure steps skip the second-model review unless irreversible


def test_irreversible_step_must_be_flagged():
    with pytest.raises(ValueError):
        products.ProcedureStep(id="x", text="Cut the cable tie", expected_result="gone", irreversible=False)


def test_unknown_precaution_rejected():
    with pytest.raises(ValueError):
        products.ProcedureStep(id="x", text="Wipe it", expected_result="clean", precautions=["vibes"])


# ----------------------------------------------------------------- detector
class FakeBackend:
    def __init__(self, score, heat=None):
        self._score, self._heat = score, heat

    def score(self, image):
        return self._score, self._heat


def _product_with_detector():
    p = products.load_all()["example-desk-fan"].model_copy()
    p.detector = products.Detector(backend="anomalib", weights="x", threshold_good=0.3, threshold_defective=0.7)
    return p


@pytest.mark.parametrize("score,verdict", [(0.1, "good"), (0.5, "uncertain"), (0.9, "defective")])
def test_detector_thresholds(score, verdict, tmp_path):
    img = Image.new("RGB", (64, 64))
    r = detector.detect(_product_with_detector(), tmp_path, img, FakeBackend(score))
    assert r.verdict == verdict


def test_heatmap_hotspot(tmp_path):
    heat = np.zeros((8, 8))
    heat[1, 6] = 1.0
    r = detector.detect(_product_with_detector(), tmp_path, Image.new("RGB", (64, 64)), FakeBackend(0.9, heat))
    assert r.heatmap_jpeg_b64 and r.hotspot[0] > 0.7 and r.hotspot[1] < 0.3


def test_detector_unavailable_without_config_or_weights(tmp_path):
    p = products.load_all()["example-desk-fan"]
    assert detector.detect(p, tmp_path, Image.new("RGB", (8, 8))).verdict == "unavailable"
    lfs = tmp_path / "w.pth"
    lfs.write_text("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n", encoding="utf-8")
    pd = _product_with_detector()
    pd.detector.weights = str(lfs)
    r = detector.detect(pd, tmp_path, Image.new("RGB", (8, 8)))
    assert r.verdict == "unavailable" and "LFS" in r.reason


def test_threshold_picker():
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location("td", pathlib.Path(__file__).parents[1] / "scripts/train_detector.py")
    td = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(td)
    assert td.pick_thresholds(np.array([0.1, 0.2, 0.25]), np.array([0.8, 0.9, 0.95])) is not None
    assert td.pick_thresholds(np.array([0.1, 0.9]), np.array([0.2, 0.95])) is None


def test_product_endpoint(monkeypatch):
    from fastapi.testclient import TestClient

    from repairmind.token_server import app

    monkeypatch.setenv("RMX_ALLOW_UNREVIEWED", "1")
    c = TestClient(app)
    r = c.get("/api/products/example-desk-fan")
    assert r.status_code == 200
    body = r.json()
    assert body["illustrative"] is True
    assert any(p["name"] == "blade_cap" for p in body["parts"])
    assert body["procedures"][0]["steps"][2]["move"]["blade_cap"] == [0, 0, 1.4]
    assert c.get("/api/products/nope").status_code == 404


def test_product_endpoint_hides_unreviewed(monkeypatch):
    from fastapi.testclient import TestClient

    from repairmind.token_server import app

    monkeypatch.delenv("RMX_ALLOW_UNREVIEWED", raising=False)
    assert TestClient(app).get("/api/products/example-desk-fan").json()["procedures"] == []
