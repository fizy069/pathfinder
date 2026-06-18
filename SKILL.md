---
name: tutorial-generator
description: >-
  Generate a step-by-step, screenshot-based PDF tutorial for a web task (e.g.
  "how to add an article to Wikipedia"). Uses subagents to explore a live site
  via the Playwright MCP server, builds a checkpointed/validated JSON click-path,
  then renders an annotated PDF (relevant buttons circled). Flows can be authored
  as a composable graph (branches + reusable fragments such as a shared login)
  and rendered into a portable artifact (screenshots bundled alongside the JSON).
  USE FOR: authoring a new tutorial, extracting/reusing a shared fragment,
  updating an existing tutorial's JSON when a site changes, re-verifying that a
  tutorial still resolves on the live site. DO NOT USE FOR: generic browsing
  questions, non-tutorial scraping, or tasks with no Playwright MCP server
  available.
---

# Tutorial Generator Skill

Build and maintain visual, step-by-step web tutorials. The deliverable is a
**validated JSON config** (committable to the repo) plus a rendered **annotated
PDF** with the relevant button circled on each screenshot.

The JSON config IS the source of truth and the checkpoint. Steps are appended
one at a time, validated against the schema, and saved after each one so a run is
**resumable** and the config can be committed mid-flight.

## Config shape

A flow is a `graph` of `nodes` (id → node) with a `start` id and `next` edges.
A node is either a *step node* (one interaction) or a *fragment node* (`use`
another flow and bind its `params` via `with`). Use branches when the flow can
differ between runs (e.g. skip login if already signed in) and fragments to
reuse shared subgraphs.

Key ideas:

- **Fragments** (`kind: "fragment"`, under `fragments/`) are reusable subgraphs
  with declared `params`. They contain **no screenshots** — the same `login`
  fragment looks different on every site it is reused in, so screenshots belong
  to a rendered *artifact*, not the fragment.
- **Params & secrets** — fragments/tutorials declare `params` (`type`,
  `required`, `default`, `secret`). Callers bind them in a fragment node's
  `with`. Reference them in `value`/locator fields as `${param:NAME}` or
  `${env:NAME}`. Secrets are supplied at run time via a `secretRef`
  (`{"env": "VAR"}`) and are **never** written into committed JSON.
- **Branches** — a node's `next` may be a list of `{ to, when }` edges. The
  first edge whose `when` matches is taken; the edge with no `when` is the
  default. Conditions: `{visible: locator}`, `{exists: locator}`, or
  `{var: NAME, equals: VALUE}`.
- **Artifacts** — rendering with `--artifact <dir>` writes the captured PNGs to
  `<dir>/media/` plus a `<dir>/tutorial.json`, a self-contained bundle that can
  be **replayed into a PDF without a browser** (`--from-artifact <dir>`).

## Prerequisites (check first, stop if missing)

1. **Playwright MCP server** must be configured and its browser tools available
   to subagents (navigate, click, snapshot/accessibility tree, screenshot). If
   no Playwright MCP browser tools are available, STOP and tell the user to add a
   Playwright MCP server before continuing — do not guess selectors blindly.
2. **Python deps** installed once: `py -m pip install -r requirements.txt` then
   `py -m playwright install chromium` (only needed to render, not to explore).
3. Read [tutorial.schema.json](tutorial.schema.json) so every node you
   author conforms (`graph` nodes, fragment nodes, `params`, `next`/`when`,
   `secretRef`). Read
   [tutorial_generator.py](tutorial_generator.py) for how locators are resolved
   (`role`>`label`>`testId`>`text`>`css`), actions
   (`click`,`fill`,`press`,`hover`,`goto`,`select`), `${param:}`/`${env:}`
   substitution, branch evaluation, and the `--artifact`/`--from-artifact`
   flags. See [fragments/login.json](fragments/login.json) for a reusable
   fragment and [tutorials/github-create-repo.json](tutorials/github-create-repo.json)
   for a tutorial that composes it.

## Inputs to collect from the user

- **Task**: what tutorial to produce (e.g. "how to create a new article on
  Wikipedia").
- **Start URL**.
- **Output path** for the config, default `tutorials/<slug>.json`.
- **Credentials / auth**: if the flow needs login, ask how to authenticate.
  Never hardcode secrets into the JSON — declare a `secret` param and bind it
  from an env var via `secretRef`/`${env:NAME}`. Tell the user which env vars to
  export before a live run. Prefer **reusing** an existing login fragment (e.g.
  [fragments/login.json](fragments/login.json)) over re-authoring login steps.

## Workflow

### Phase 0 — Setup
1. Confirm prerequisites above.
2. Slugify the task into `tutorials/<slug>.json`. If that file already exists,
   load it and treat existing `verified` nodes as a checkpoint to resume from /
   re-verify rather than redoing them.
3. Initialize (or keep) the config skeleton:
   `{ "name", "start_url", "output": "<slug>.pdf", "viewport": {"width":1280,"height":800}, "headless": true, "graph": { "start": "", "nodes": {} } }`
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
- Note any **branch points**: places where the flow can differ between runs
  (e.g. "already signed in → skip the login form", a cookie banner that may or
  may not appear). For each, record the observable signal (an element that is
  visible only in one branch) so it can become a `when` condition.
- If the task needs login and a reusable fragment already exists, note that the
  login portion should be a **fragment node** rather than re-discovered steps.
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

Author the graph node by node, saving after each:
1. Give each node a stable id; set `start` to the entry node.
2. Build each step node with a single `locator` strategy, `action`, optional
   `value`, `highlight`, and `status: "draft"`.
3. Wire `next` as a string for linear hops, or a `{ to, when }` list at branch
   points (default edge = the one with no `when`).
4. For reused login/setup, add a **fragment node**: `use` the fragment path and
   bind its params in `with`, passing secrets as `{ "env": "VAR" }`.
5. Reference params in `value`/locator fields as `${param:NAME}`/`${env:NAME}`.
6. Validate the WHOLE config against the schema (see "Validate" below) and
   **save the file** after each node. This is the checkpoint — never batch all
   nodes then save once.
7. Mark a node `"status": "verified"` only after it actually resolved/ran on the
   live site during discovery; otherwise leave it `"draft"`.

### Phase 4 — Render
Run the generator to produce the annotated PDF:

```powershell
py tutorial_generator.py tutorials/<slug>.json
```

For a flow that uses secrets, export the env vars first (PowerShell):
`$env:GITHUB_PASSWORD = "..."`. To produce a **portable artifact** (screenshots
bundled with the JSON) at the same time:

```powershell
py tutorial_generator.py tutorials/<slug>.json --artifact tutorials/<slug>
```

That writes `tutorials/<slug>/media/*.png` and `tutorials/<slug>/tutorial.json`.
Rebuild the PDF later with no browser (and no secrets) via:

```powershell
py tutorial_generator.py --from-artifact tutorials/<slug>
```

If a step fails to resolve at render time, the locator drifted — go back to
Phase 1/2 for that step, fix the `locator`, re-save (checkpoint), re-render.

### Phase 5 — Verify & report
- Confirm the PDF was written and has one page per step.
- Spot-check that captions match actions and the circled element is the intended
  target.
- Report: config path, PDF path, number of `verified` vs `draft` steps, and any
  steps that need human attention.

## Authoring & reusing fragments

A fragment is a `kind: "fragment"` flow under `fragments/` — a reusable subgraph
like login that many tutorials share.

1. **Extract** the shared steps (e.g. the login flow) into
   `fragments/<name>.json` with a `graph`. Declare every external input as a
   `param`; mark sensitive ones `"secret": true`.
2. Reference params inside the fragment as `${param:NAME}`. The fragment carries
   **no screenshots and no `start_url` assumption** beyond its own `goto`.
3. Add **branch awareness** where useful: e.g. the login fragment's first node
   `goto`s the login URL, then branches on whether the username field is
   `visible` — if it is not (already signed in), the fragment simply ends and
   control returns to the caller.
4. **Compose** it from a tutorial with a fragment node:
   `{ "use": "../fragments/<name>.json", "with": { ... }, "next": "<next-id>" }`.
   After the fragment finishes, traversal continues at the node's `next`.
5. Verify the fragment once on the live site; thereafter tutorials reuse it
   without re-deriving its selectors.

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
- Never commit secrets. Declare them as `secret` params and bind via
  `secretRef`/`${env:NAME}`; the value is resolved at run time only. Artifacts
  store screenshots and captions, not secret values.
- Do not fabricate roles/names/selectors — they must come from a real
  accessibility snapshot.
- Prefer reusing a verified fragment over re-authoring shared flows like login.
- Every `next`/edge `to` and `start` must reference an existing node id; the
  renderer aborts on unknown ids and on graphs that exceed the cycle guard.
- Keep each node's `description` user-facing and imperative ("Click Publish").
- Save after every step/node. The JSON on disk is always the latest checkpoint.
