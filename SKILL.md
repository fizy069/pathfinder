---
name: tutorial-generator
description: >-
  Generate a step-by-step, screenshot-based PDF tutorial for a web task (e.g.
  "how to add an article to Wikipedia"). Uses subagents to explore a live site
  via the Playwright MCP server, builds a checkpointed/validated JSON click-path,
  then renders an annotated PDF (relevant buttons circled). USE FOR: authoring a
  new tutorial, updating an existing tutorial's JSON when a site changes,
  re-verifying that a tutorial still resolves on the live site. DO NOT USE FOR:
  generic browsing questions, non-tutorial scraping, or tasks with no Playwright
  MCP server available.
---

# Tutorial Generator Skill

Build and maintain visual, step-by-step web tutorials. The deliverable is a
**validated JSON config** (committable to the repo) plus a rendered **annotated
PDF** with the relevant button circled on each screenshot.

The JSON config IS the source of truth and the checkpoint. Steps are appended
one at a time, validated against the schema, and saved after each one so a run is
**resumable** and the config can be committed mid-flight.

## Prerequisites (check first, stop if missing)

1. **Playwright MCP server** must be configured and its browser tools available
   to subagents (navigate, click, snapshot/accessibility tree, screenshot). If
   no Playwright MCP browser tools are available, STOP and tell the user to add a
   Playwright MCP server before continuing — do not guess selectors blindly.
2. **Python deps** installed once: `py -m pip install -r requirements.txt` then
   `py -m playwright install chromium` (only needed to render, not to explore).
3. Read [tutorial.schema.json](tutorial.schema.json) so every step you author
   conforms. Read [tutorial_generator.py](tutorial_generator.py) for how
   locators are resolved (`role`>`label`>`testId`>`text`>`css`) and actions
   (`click`,`fill`,`press`,`hover`,`goto`).

## Inputs to collect from the user

- **Task**: what tutorial to produce (e.g. "how to create a new article on
  Wikipedia").
- **Start URL**.
- **Output path** for the config, default `tutorials/<slug>.json`.
- **Credentials / auth**: if the flow needs login, ask how to authenticate. Never
  hardcode secrets into the JSON; note auth as a manual prerequisite step.

## Workflow

### Phase 0 — Setup
1. Confirm prerequisites above.
2. Slugify the task into `tutorials/<slug>.json`. If that file already exists,
   load it and treat existing `verified` steps as a checkpoint to resume from /
   re-verify rather than redoing them.
3. Initialize (or keep) the config skeleton:
   `{ "name", "start_url", "output": "<slug>.pdf", "viewport": {"width":1280,"height":800}, "headless": true, "steps": [] }`
   and save it immediately.

### Phase 1 — Discovery (one subagent, drives the live browser)
Dispatch a single subagent (so one browser session keeps page state across the
whole flow). Instruct it to:
- Navigate to `start_url` using Playwright MCP.
- Perform the task end to end, one interaction at a time.
- After **each** interaction, capture an **accessibility snapshot** and record a
  raw step: the human-readable `description`, the `action`, any typed `value`,
  and **candidate identifiers** for the target element (ARIA role + accessible
  name, associated label, `data-testid`, visible text, and a CSS fallback), plus
  whether this element should be circled (`highlight`).
- Return the ordered raw step list. It should NOT write the JSON itself — it
  returns structured findings.

Tell the subagent explicitly: report exact role/name/label/testId/text strings
as seen in the accessibility tree; do not invent selectors.

### Phase 2 — Selector hardening (parallel subagents, optional)
For any step whose best identifier is ambiguous or only has a brittle CSS
fallback, dispatch parallel read-only subagents (one per ambiguous element) to
pick the most robust unique locator using the preference order
`role(+name) > label > testId > text > css`. Each returns the chosen `locator`
object and a one-line justification.

### Phase 3 — Checkpointed authoring (you, the orchestrator)
For each discovered step, in order:
1. Build a schema-conformant step with a single `locator` strategy, `action`,
   optional `value`, `highlight`, and `status: "draft"`.
2. Validate the WHOLE config against the schema (see "Validate" below).
3. Append the step and **save the file**. This is the checkpoint — never batch
   all steps then save once.
4. Mark a step `"status": "verified"` only after it actually resolved/ran on the
   live site during discovery; otherwise leave it `"draft"`.

### Phase 4 — Render
Run the generator to produce the annotated PDF:

```powershell
py tutorial_generator.py tutorials/<slug>.json
```

If a step fails to resolve at render time, the locator drifted — go back to
Phase 1/2 for that step, fix the `locator`, re-save (checkpoint), re-render.

### Phase 5 — Verify & report
- Confirm the PDF was written and has one page per step.
- Spot-check that captions match actions and the circled element is the intended
  target.
- Report: config path, PDF path, number of `verified` vs `draft` steps, and any
  steps that need human attention.

## Validate (run after every checkpoint)

```powershell
py -c "import json,jsonschema; s=json.load(open('tutorial.schema.json')); c=json.load(open('tutorials/<slug>.json')); jsonschema.Draft7Validator(s).validate(c); print('valid')"
```

The renderer also validates on load and prints precise, path-qualified errors.

## Updating / drift-checking an existing tutorial

1. Load the existing `tutorials/<slug>.json`.
2. Phase 1 subagent re-walks the flow; for each step compare the recorded
   `locator` against what now resolves on the live site.
3. For drifted steps, update the `locator`, set `status: "draft"` until
   re-verified, save (checkpoint) after each change.
4. Re-render and report what changed.

## Guardrails

- One discovery subagent owns the browser session; hardening subagents are
  read-only and must not navigate destructively.
- Never commit secrets. Auth is a manual prerequisite, not a JSON step.
- Do not fabricate roles/names/selectors — they must come from a real
  accessibility snapshot.
- Keep each step's `description` user-facing and imperative ("Click Publish").
- Save after every step. The JSON on disk is always the latest checkpoint.
