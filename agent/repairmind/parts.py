"""Part finder: shopping searches for the exact part, ready while the call goes on.

Without a paid shopping API there are no live prices, so this never states one: it builds searches on
well-known shops for the exact brand, model and part number, and the app shows them as links. Shops can be
changed with RMX_PART_SHOPS ("Name|https://shop.example/search?q={q},Other|..."), e.g. for local stores.
"""

from __future__ import annotations

import os
import re
from urllib.parse import quote_plus, urlparse

DEFAULT_SHOPS = [
    ("iFixit", "https://www.ifixit.com/Search?query={q}"),
    ("Amazon", "https://www.amazon.com/s?k={q}"),
    ("eBay", "https://www.ebay.com/sch/i.html?_nkw={q}"),
    ("Google Shopping", "https://www.google.com/search?tbm=shop&q={q}"),
]


def shops() -> list[tuple[str, str]]:
    raw = os.getenv("RMX_PART_SHOPS", "").strip()
    if not raw:
        return DEFAULT_SHOPS
    out = []
    for item in raw.split(","):
        name, _, tpl = item.partition("|")
        url = urlparse(tpl.strip())
        if name.strip() and url.scheme == "https" and url.netloc and "{q}" in tpl:
            out.append((name.strip()[:30], tpl.strip()))
    return out or DEFAULT_SHOPS


def _clean(s: str, n: int) -> str:
    return " ".join(re.sub(r"[^\w\s./+-]", " ", s or "").split())[:n]


def query(brand: str, model: str, part: str, number: str = "") -> str:
    # a manufacturer part number is the most precise search on its own; otherwise brand + model + part
    num = _clean(number, 40)
    if num:
        return " ".join(x for x in (_clean(brand, 40), num, _clean(part, 60)) if x)
    return " ".join(x for x in (_clean(brand, 40), _clean(model, 40), _clean(part, 60)) if x)


def find(brand: str, model: str, part: str, number: str = "") -> dict:
    q = query(brand, model, part, number)
    return {"part": _clean(part, 60), "number": _clean(number, 40), "query": q,
            "links": [{"shop": name, "url": tpl.replace("{q}", quote_plus(q))} for name, tpl in shops()]}


def for_model(found: dict, model_confirmed: bool) -> str:
    msg = (f"Shopping searches for \"{found['query']}\" are now on the user's screen ("
           + ", ".join(link["shop"] for link in found["links"]) + "). You don't know prices: never state one. "
           "Tell them to match the part number on the old part before buying.")
    if not model_confirmed:
        msg += " The model isn't confirmed, so warn them the part may not fit; ask for the label first if you can."
    return msg
