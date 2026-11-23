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
