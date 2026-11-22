# RepairMind X

A live video call with an AI mechanic, on phone, tablet or desktop. The user points the camera at the
broken thing and talks; the mechanic diagnoses by asking questions and running safe tests, then talks
them through the fix one checked step at a time.

```
Browser (phone / desktop)  ──WebRTC──>  LiveKit room  <──  Mechanic agent (Python, LiveKit Agents)
  camera + mic, captions,                                   Gemini Live: hears, sees ~1 fps, speaks
  checklist, freeze-frame arrows  <── data topics ──        Tools ─> safety rules + session gates
         │                                                        └> iFixit guide lookup
         └─ POST /api/token ─> token server (FastAPI)
```

## What's in Phase 1

| Part | Where | What it does |
|---|---|---|
| Safety rules | `agent/repairmind/safety.py` | Green, amber and red levels in plain code. Red jobs (microwave internals, mains wiring, gas, refrigerant, airbags, brakes, fuel, high-voltage or swollen batteries, CRTs, medical devices, bypassing interlocks, torsion springs) get no step-by-step instructions. Amber jobs need precautions seen on camera. Also detects irreversible actions and hazard words. |
| Session gates | `agent/repairmind/session.py` | Device identification, history questions, safe tests, hypotheses, a diagnosis that's refused until there's evidence and the top causes are clearly separated, confidence thresholds (0.75 green, 0.85 amber, 0.90 irreversible), sourced steps only, the 5-point irreversible-step check, step verification before the next step, hazard stop, escalation package, save and resume. |
| Mechanic agent | `agent/repairmind/agent.py` | LiveKit Agents worker with Gemini Live (voice and video in, voice out). Every repair step goes through a tool backed by the gates above. A transcript watcher stops the call on hazard words even if the model misses them. |
| Guide lookup | `agent/repairmind/sources.py` | iFixit search and guide steps. |
| Token server | `agent/repairmind/token_server.py` | Issues LiveKit join tokens, dispatches the mechanic, and lets a dropped call resume in the same room. |
| Web app | `web/` | React + LiveKit. Safety and privacy notice, rear camera by default, camera switch, mute, live captions, agent state, risk banner, diagnosis with confidence, precautions and step checklist, freeze-frame arrows, hazard and refusal alerts, resume last repair. Installable as a PWA. |

## Phase 2: grounded steps

| Part | Where | What it does |
|---|---|---|
| Second-model cross-check | `agent/repairmind/reviewer.py` | Before the first repair step and every amber or irreversible step, Claude (a different model from the Gemini voice) reviews the evidence, the step, its source excerpt and the latest camera frame. It answers approve, revise or escalate. If it disagrees, the step is blocked. If it can't run (no key, network, refusal), risky steps are blocked: it fails closed. |
| Speech guard | `agent/repairmind/speech_guard.py` | Reads every finished mechanic utterance. If it gave a hands-on instruction with no active step, an irreversible action without confirmation, or anything for a red-level job, the agent interrupts itself and corrects out loud. |
| Service manuals | `agent/repairmind/manuals.py`, `POST /api/manual` | Upload the device's PDF manual during the call ("Add manual" button). It is split into page-tagged passages and searched with BM25, so steps cite "manual p.N". |
| Full-resolution frames | `agent/repairmind/frames.py` | Keeps the newest full camera frame for the reviewer (and Phase 3 close-ups). |

## Phase 3: visual guidance

| Part | Where | What it does |
|---|---|---|
| Label reading | `read_label` tool, `agent/repairmind/vision.py` | Reads brand and exact model from the rating label on a full-resolution frame. If any character is uncertain it asks for a better shot rather than guessing. |
| Close-ups | `look_closer` tool | Answers detail questions ("is the ribbon cable fully seated?") from a full-resolution frame. |
| Precise markers | `point_at` tool | Locates the part on the newest full frame and sends that exact frame to the app with a box and arrow. Falls back to an approximate marker, clearly labelled, if precise location is unavailable. |
| Two-frame step checks | `check_step_on_camera` tool | Two frames about a second apart must both show the step done with at least 0.8 confidence and no problems seen. Required before amber or irreversible steps count as done. Unclear three times means hand off to a human. |

Vision uses the same Anthropic key as the cross-check (`RMX_VISION_MODEL`, default `claude-opus-5-5`). Without it, risky steps can't be verified on camera, so they are blocked.

## Run it

You need: a free LiveKit Cloud project (URL, API key, secret), a Google AI Studio API key, and an Anthropic API key for the cross-check.

```bash
# 1. Agent + token server
cd agent
cp .env.example .env            # fill in the keys
uv venv && uv pip install -e ".[dev]"
.venv/bin/python -m pytest
.venv/bin/python -m repairmind.agent dev          # terminal 1: the mechanic
.venv/bin/uvicorn repairmind.token_server:app --port 8000   # terminal 2

# 2. Web app
cd ../web
npm install
npm run dev                     # open the printed URL; on a phone use the network URL over HTTPS
```

Phones only allow camera access over HTTPS (or localhost). For phone testing, deploy the web app (any
static host) or use a tunnel such as `cloudflared tunnel --url http://localhost:5173`.

## Known limits of Phase 1

- **Not yet tested against live services.** The safety rules, gates and token server are covered by
  unit tests, and the web app builds. The end-to-end call needs the LiveKit and Gemini keys, and the
  iFixit lookup was not reachable from the build machine.
- **The speech guard acts after the sentence is spoken.** It interrupts and corrects within about a
  second, but the words were already heard. It also allows any instruction while a step is active.
- **Markers use freeze-frame.** The box is drawn on the exact frame that was analysed, not the moving
  live video. Live tracking of markers is not built yet.
- **iFixit licence.** Guides are CC BY-NC-SA. Fine for this prototype; a commercial launch needs
  iFixit's paid API plan, and their content may not be used to train models.
- **Safety keywords are English only** for now.
- **Manuals must have a text layer.** Scanned PDFs are rejected; OCR would come later.
- **The token server and agent share a disk** for uploaded manuals, so run them on the same machine
  (or point `RMX_SESSIONS_DIR` at shared storage).
