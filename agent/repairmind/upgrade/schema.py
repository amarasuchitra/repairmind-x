"""What the product analyst returns. Same shape as web/src/build/assess.ts (Assessment).

Kept free of dict-typed and union fields so both Claude and Gemini structured outputs accept it.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Inside(BaseModel):
    name: str = Field(description="A part that is, or is probably, inside: 'two AA cells', 'one 5 mm LED with resistor'")
    purpose: str
    confidence: Literal["seen", "likely", "guess"] = Field(description="seen: visible in a photo or stated by the user")


class Product(BaseModel):
    kind: Literal["existing", "new"] = Field(description="existing: something the user already owns; new: an invention to build")
    name: str = Field(description="What it is, or what the invention would be called, in plain words")
    category: str = Field(description="One or two words: soft toy, desk lamp, table fan, bicycle, ...")
    how_it_works: str = Field(description="One or two plain sentences on how it works today, or for a new idea how it would work")
    power: Literal["battery", "usb", "wall", "none", "unknown"] = Field(description="How it is powered today; for a new idea, how it should be")
    power_detail: str = Field(description="e.g. '2 x AA, about 3 V' or 'mains 230 V AC'; 'unknown' if unknown")
    inside: list[Inside] = Field(description="What is inside today, most important first; for a new idea, the main building blocks it needs")
    space: str = Field(description="How much free room there is inside or on it to add parts, in plain words")
    inner_mm: list[float] = Field(description="Free space inside as [width, height, depth] in mm if it can be estimated, else []")
    for_kids: bool
    hazards: list[str] = Field(description="Hazards already present: mains voltage, heat, water, lithium cells, moving blades, small parts")
    can_open: str = Field(description="Whether and how it can be opened without damage: screws, clips, glued, sewn seam, sealed")


class Factor(BaseModel):
    kind: Literal["physics", "power", "space", "cost", "safety", "skill", "legal"]
    verdict: Literal["ok", "concern", "blocker"]
    text: str = Field(description="One plain sentence with the number that decides it where there is one")


class Wish(BaseModel):
    wish: str = Field(description="One thing the user wants, restated plainly")
    verdict: Literal["possible", "possible_with_changes", "not_possible"]
    why: str = Field(description="The deciding reason in one or two plain sentences")
    factors: list[Factor]
    how: str = Field(description="How it would be done, in plain words; empty if not possible")
    alternative: str = Field(description="If not possible or risky: the closest thing that is possible; else empty")
    effort: Literal["easy", "moderate", "hard"]
    cost_inr: int = Field(description="Approximate added cost in Indian rupees for this wish alone")


class OtherPart(BaseModel):
    name: str = Field(description="Something needed that is not in the electronics catalogue: a frame, a 3D-printed part, a bigger motor, a service")
    why: str
    price_inr: int


class Stage(BaseModel):
    name: str = Field(description="e.g. 'Desk prototype', 'Working model', 'Finished product'")
    goal: str = Field(description="What this stage proves, in one plain sentence")
    tasks: list[str] = Field(description="2-6 short tasks")
    weeks: float = Field(description="Rough time for a beginner working evenings")


class Question(BaseModel):
    q: str = Field(description="A plain-language question whose answer would change the plan")
    why: str = Field(description="Why it matters, in a few words")
    options: list[str] = Field(description="2-4 short likely answers the user can tap")


class PlanPart(BaseModel):
    id: str = Field(description="A part id from the catalogue given in the request, exactly")
    why: str


class PlanRule(BaseModel):
    when: str = Field(description="A trigger id from the list given in the request")
    then: str = Field(description="An action id from the list given in the request")
    text: str = Field(description="Words to say or show, if the action is say or show; else empty")
    color: str = Field(description="#rrggbb for a light action; else empty")


class Plan(BaseModel):
    summary: str = Field(description="The recommended enhancement in two or three plain sentences")
    reuse: str = Field(description="What of the existing product is kept or reused (its case, its light, its battery box)")
    steps: list[str] = Field(description="The approach in 3-8 short steps, from opening it to testing")
    parts: list[PlanPart] = Field(description="Catalogue parts for the possible wishes only; include a brain and a power source when any electronics are added")
    rules: list[PlanRule]
    other_parts: list[OtherPart] = Field(description="What the idea needs beyond the catalogue; empty if nothing")
    stages: list[Stage] = Field(description="The path from idea to a real product, 2-4 stages; the first is a cheap desk prototype")
    warnings: list[str]


class Concept(BaseModel):
    title: str = Field(description="A short product name for this direction: 'Bedtime story star', 'Plant that texts you'")
    pitch: str = Field(description="One sentence: what the product becomes")
    for_user: str = Field(description="Who it is for and what changes in their day, concretely ('a 4-year-old falls asleep to a story instead of a screen')")
    tech: str = Field(description="The technology that makes it work, in plain words, with the number that makes it feasible")
    new_because: str = Field(description="Honestly: what similar products already exist, and what is new or better here")
    parts: list[str] = Field(description="Catalogue part ids this concept needs, exactly as given in the request")
    cost_inr: int = Field(description="Approximate total parts cost in Indian rupees")
    effort: Literal["easy", "moderate", "hard"]
    risk: str = Field(description="The biggest technical risk, and how the first prototype stage retires it")


class Assessment(BaseModel):
    product: Product
    wishes: list[Wish]
    overall: Literal["go", "go_with_changes", "not_recommended"]
    overall_why: str
    plan: Plan
    restated: str = Field(description="The user's idea or wish restated in one or two plain sentences, so they can confirm you understood")
    questions: list[Question] = Field(description="Up to 4 questions that would most change the plan; empty when nothing important is unclear")
    design_lab: bool = Field(description="True when the idea has mechanical or structural parts (frames, loads, moving mechanisms) that need engineering calculations")
    concepts: list[Concept] = Field(default_factory=list, description="Exactly 3 product concepts, ranked best first; the plan builds the chosen one (the first unless the user picked another)")
