"""What the build guide answers each turn: what to say, which tools to drive, and where the person is."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# The tools run in the person's browser, where the parts checker, circuit simulator, shell maths and design-lab
# analysis already live. The guide asks for them; the page runs them and sends back what happened.
Tool = Literal[
    "understand_idea",      # idea, product, for_kids: the idea analyst (feasibility, wishes, questions, plan)
    "answer_questions",     # args: each key is a question, each value the person's answer
    "correct_understanding",  # text: what the analyst got wrong
    "start_build",          # lay the plan's parts out and check them
    "suggest_parts",        # goal: add parts for a goal in plain words
    "add_part",             # id: a catalogue part id
    "remove_part",          # id
    "apply_fix",            # n: the issue number from the checks, or "all"
    "add_rule",             # when, then, text: a "When ... then ..." behaviour
    "rename",               # name
    "check",                # re-run the checks and get the report
    "show",                 # view: plan, parts, wiring, try, body, code, steps, design, none
    "test_on_bench",        # power, seconds, and any bench world or change keys: run the virtual bench
    "shape_body",           # shape, width, height, depth, wall, round, material, fit
    "design_mechanism",     # idea, context: the design lab's engineer (equations, margins, physics sandbox)
    "rethink_design",       # note: send the failed checks back to the engineer for a redesign
    "open_full_lab",        # open the full design lab page with this design
    "show_step",            # n: show build step n
    "step_done",            # n: mark build step n done
]

Stage = Literal["idea", "understand", "plan", "design", "simulate", "body", "build", "done"]


class KV(BaseModel):
    key: str = Field(max_length=200)
    value: str = Field(max_length=1200)


class ToolCall(BaseModel):
    tool: Tool
    args: list[KV] = Field(default_factory=list)
    # one short line the page shows while the tool runs, in the person's language: "Testing it in the dark"
    why: str = ""


class Checkpoint(BaseModel):
    """A question about the real thing on the person's desk. An empty question means there is none this turn."""

    step: int = 0
    question: str = ""
    options: list[str] = Field(default_factory=list)


class GuideTurn(BaseModel):
    say: str
    actions: list[ToolCall] = Field(default_factory=list)
    checkpoint: Checkpoint = Field(default_factory=Checkpoint)
    # up to four short replies the person can tap
    chips: list[str] = Field(default_factory=list)
    stage: Stage = "idea"
    # facts worth keeping for the rest of the project: tools they own, skills, constraints, decisions
    remember: list[str] = Field(default_factory=list)
    # true when the guide wants to see the tools' results before the person speaks again
    then_continue: bool = False
