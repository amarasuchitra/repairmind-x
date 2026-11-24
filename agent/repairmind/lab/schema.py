"""The engineering breakdown the design agent returns. Same shape as web/src/lab/design.ts.

Kept free of dict-typed and union fields so both Claude and Gemini structured outputs accept it.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Requirement(BaseModel):
    id: str = Field(description="R1, R2, ...")
    text: str = Field(description="One verifiable 'shall' statement with a number and unit where possible")
    kind: Literal["functional", "performance", "safety", "environmental", "interface", "cost"]
    verification: Literal["analysis", "test", "inspection", "demonstration"]
    rationale: str


class Component(BaseModel):
    name: str
    function: str
    material: str
    mass_kg: float
    notes: str


class Variable(BaseModel):
    symbol: str = Field(description="Identifier usable in expressions: letters, digits, underscore; e.g. m, h_cg, sigma_y")
    name: str
    value: float
    unit: str = Field(description="SI or common engineering unit, e.g. kg, mm, MPa, N*m, m/s^2, rpm, deg, Wh, 1 for dimensionless")
    source: str = Field(description="Where the value comes from: requirement, datasheet, handbook (name it), or 'assumption'")


class Check(BaseModel):
    kind: Literal["none", "max", "min"] = Field(description="max: result must stay below limit; min: must stay above")
    limit: float
    limit_unit: str
    factor_of_safety: float
    label: str


class Equation(BaseModel):
    id: str = Field(description="E1, E2, ...")
    name: str
    symbol: str = Field(description="The symbol this equation defines; later equations may use it")
    expression: str = Field(description="Right-hand side only, using variable and earlier equation symbols")
    unit: str = Field(description="Unit of the result; must be dimensionally consistent with the expression")
    explanation: str = Field(description="The physics: why this equation governs, where it comes from, in plain words")
    assumptions: str
    requirement_id: str = Field(description="The requirement this equation verifies, or empty")
    check: Check


class Criterion(BaseModel):
    name: str
    weight: float


class TradeOption(BaseModel):
    name: str
    description: str
    scores: list[float] = Field(description="One 1-10 score per criterion, in criteria order")


class TradeStudy(BaseModel):
    question: str
    criteria: list[Criterion]
    options: list[TradeOption]
    recommendation: str


class Risk(BaseModel):
    id: str
    failure_mode: str
    cause: str
    effect: str
    severity: int = Field(description="1-10")
    occurrence: int = Field(description="1-10")
    detection: int = Field(description="1-10, 10 = almost impossible to detect before failure")
    mitigation: str


class SimBody(BaseModel):
    id: str
    label: str
    shape: Literal["box", "sphere", "cylinder"]
    size: list[float] = Field(description="box: [x, y, z] full extents; sphere: [radius]; cylinder: [radius, height], axis along y. Metres")
    position: list[float] = Field(description="[x, y, z] metres, y up, ground top at y = 0")
    rotation_deg: list[float] = Field(description="Turns the collider shape only; the body frame stays world-aligned")
    fixed: bool
    mass_kg: float
    mass_symbol: str = Field(description="Variable symbol to take the mass from, or empty")
    friction: float
    restitution: float
    initial_velocity: list[float]
    color: str


class SimJoint(BaseModel):
    kind: Literal["fixed", "revolute", "spring", "prismatic"]
    a: str
    b: str
    anchor_a: list[float] = Field(description="Joint point in body a's frame (world-aligned, origin at a's centre)")
    anchor_b: list[float]
    axis: list[float] = Field(description="World-aligned axis for revolute/prismatic")
    motor_speed: float = Field(description="Revolute only: target rad/s about axis; 0 for no motor")
    motor_max_torque: float = Field(description="Revolute only: N*m limit of the motor")
    stiffness: float = Field(description="Spring only: N/m")
    damping: float = Field(description="Spring only: N*s/m")
    rest_length: float = Field(description="Spring only: m")
    stiffness_symbol: str = Field(description="Variable symbol to take the stiffness from, or empty")


class SimProbe(BaseModel):
    id: str
    label: str
    body: str
    quantity: Literal["x", "y", "z", "vx", "vy", "vz", "speed", "angular_speed", "tilt_deg"]
    compare: Literal["final", "max", "min"]
    predicted_by: str = Field(description="Equation id whose SI result the probe should reproduce, or empty")
    tolerance_pct: float


class Simulation(BaseModel):
    title: str
    description: str
    gravity: float
    duration_s: float
    ground: bool
    bodies: list[SimBody]
    joints: list[SimJoint]
    probes: list[SimProbe]


class ResearchNote(BaseModel):
    topic: str
    explanation: str
    key_equations: list[str]
    further_reading: list[str] = Field(description="Real textbooks, standards or handbooks by title and author. No URLs.")


class LearnStep(BaseModel):
    concept: str = Field(description="The idea this step teaches, in a few words, e.g. 'Torque: turning force at the wheel'")
    intuition: str = Field(description="An everyday picture of the idea at the learner's level, 2-3 sentences")
    why_here: str = Field(description="Why it decides something in THIS design, with its numbers")
    equation_id: str = Field(description="The id of the equation in this design that this step explains (E1, E2...)")
    walkthrough: list[str] = Field(description="2-5 short lines working the equation with this design's numbers and units, at the learner's level")
    try_variable: str = Field(description="A variable symbol from this design that the equation depends on, for the learner to change")
    try_factor: float = Field(description="What to multiply that variable by in the experiment, e.g. 2 to double it or 0.5 to halve it")
    question: str = Field(description="A prediction question, e.g. 'If the rover were twice as heavy, what would happen to the torque each wheel needs?'")
    explain_after: str = Field(description="Why the result comes out the way it does, to show after the learner has predicted and seen it")


class Revision(BaseModel):
    round: int
    critique: str = Field(description="Root cause of each finding, and the alternatives considered")
    changes: list[str]
    lessons: list[str] = Field(description="General, reusable engineering lessons learned this round (not specific numbers)")


class Design(BaseModel):
    title: str
    idea: str
    summary: str
    objective: str
    operating_context: str
    constraints: list[str]
    requirements: list[Requirement]
    assumptions: list[str]
    components: list[Component]
    variables: list[Variable]
    equations: list[Equation]
    trade_study: TradeStudy
    risks: list[Risk]
    simulation: Simulation
    research: list[ResearchNote]
    open_questions: list[str]
    trl: int = Field(description="Technology readiness level 1-9 of the design as described")
    next_steps: list[str]
    revisions: list[Revision]
    inputs_used: list[str] = Field(default_factory=list,
                                   description="One line per attachment (A1, A2, ...): what was taken from it. Empty if none.")
    learn: list[LearnStep] = Field(default_factory=list,
                                   description="3-6 steps that teach the physics and maths behind this design, simplest idea first")


# ---- think first: understand the idea before designing it -----------------------------------------------------


class Known(BaseModel):
    fact: str = Field(description="One fact the design will rest on, in plain words, with its number and unit if any")
    source: Literal["you_said", "photo", "file", "typical", "assumed"] = Field(
        description="you_said: stated by the user; photo/file: seen in an attachment; typical: true of almost every "
                    "product or situation like this; assumed: a guess that should be confirmed")
    ref: str = Field(description="Which attachment (A1, A2...) or which words it came from; empty if none")


class BriefQuestion(BaseModel):
    q: str = Field(description="A plain question whose answer would change the design the most")
    why: str = Field(description="What changes depending on the answer, in a few words")
    options: list[str] = Field(description="2-4 short likely answers the user can tap")


class Feasibility(BaseModel):
    verdict: Literal["feasible", "feasible_with_changes", "not_feasible_now", "not_physically_possible"] = Field(
        description="not_feasible_now: possible in principle but not with today's parts, money or skills; "
                    "not_physically_possible: breaks a law of physics (energy, momentum, thermodynamics)")
    why: str = Field(description="The deciding reason in one or two plain sentences")
    deciding_numbers: list[str] = Field(
        description="1-4 back-of-the-envelope estimates that decide it, each worked out in one line with units, "
                    "e.g. 'Energy to lift 1000 L by 10 m: 1000 kg x 9.81 m/s^2 x 10 m = 98 kJ = 27 Wh per day'")
    closest_alternative: str = Field(description="If not feasible as asked: the nearest thing that is; else empty")


class RiskiestAssumption(BaseModel):
    statement: str = Field(description="The one belief that, if wrong, sinks the idea")
    why_it_matters: str
    cheapest_test: str = Field(description="The cheapest, quickest experiment or calculation that could prove it wrong, step by step in plain words")
    pass_if: str = Field(description="The measurable result that means the idea survives, with a number and unit")
    test_cost_inr: int = Field(description="Rough cost of that test in Indian rupees")
    test_time: str = Field(description="Rough time for a beginner, e.g. 'one evening'")


class Concept(BaseModel):
    name: str
    how_it_works: str = Field(description="One or two plain sentences")
    pros: list[str]
    cons: list[str]


class Brief(BaseModel):
    restated: str = Field(description="The idea restated in one or two plain sentences, so the user can confirm it")
    kind: Literal["new", "improve"] = Field(description="new: an invention; improve: making something that exists better")
    real_goal: str = Field(description="The need behind the request: what success looks like for the user, measurably")
    known: list[Known] = Field(description="3-10 facts the design will rest on, most important first")
    feasibility: Feasibility
    riskiest: RiskiestAssumption
    concepts: list[Concept] = Field(description="2-3 genuinely different ways to do it")
    recommended_concept: str = Field(description="The name of the concept you would start with, exactly as in concepts")
    recommended_why: str
    questions: list[BriefQuestion] = Field(description="Up to 4 questions that would change the design most; none already answered; empty when nothing important is unclear")
