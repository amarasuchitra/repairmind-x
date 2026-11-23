"""Every text file read or write names its encoding.

Without encoding="utf-8", Python uses the system code page (cp1252 on most Windows machines), so
files with characters like "°C", "µm" or non-English text fail to load or save there.
"""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEXT_METHODS = {"read_text", "write_text"}


def _offenders() -> list[str]:
    bad = []
    for path in [*(ROOT / "repairmind").rglob("*.py"), *(ROOT / "tests").rglob("*.py"), *(ROOT / "scripts").rglob("*.py")]:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            kws = {k.arg for k in node.keywords}
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
            if name in TEXT_METHODS and "encoding" not in kws:
                bad.append(f"{path.relative_to(ROOT)}:{node.lineno} {name}()")
            elif name == "open" and isinstance(f, ast.Name) and "encoding" not in kws:
                mode = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "mode"), None)
                if not (isinstance(mode, ast.Constant) and "b" in str(mode.value)):
                    bad.append(f"{path.relative_to(ROOT)}:{node.lineno} open()")
    return bad


def test_text_io_names_utf8():
    assert _offenders() == []
