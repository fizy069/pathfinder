# Automated Tutorial Generator

Generate **visual, step-by-step PDF tutorials** for web apps — "how to do X on
this website" as a series of annotated screenshots with the relevant button
**circled** on each page.

Instead of hand-writing fragile CSS selectors, an **AI skill drives a real
browser** (via a Playwright MCP server), discovers a robust click-path, and
saves it as a **validated, checkpointed JSON config** you can commit and update.
A small Python renderer turns that JSON into the PDF.

## How it works

```
Task description ──▶ SKILL.md (subagents + Playwright MCP)
                         │  explore live site, harden locators
                         ▼
              tutorials/<slug>.json  ◀── validated against tutorial.schema.json
                         │  (the checkpoint: committable, resumable)
                         ▼
              tutorial_generator.py ──▶ tutorial.pdf (circled, captioned)
```

1. **[SKILL.md](SKILL.md)** orchestrates the authoring:
   - A **discovery subagent** walks the task on the live site with Playwright
     MCP and records each step from the accessibility tree.
   - **Selector-hardening subagents** pick the most robust locator per element
     (`role` > `label` > `testId` > `text` > `css`).
   - The orchestrator appends steps **one at a time**, validates against the
     schema, and **saves after each** — so runs are resumable and the JSON is
     committable mid-flight (the *checkpoint*).
2. **[tutorial_generator.py](tutorial_generator.py)** validates the config,
   drives Chromium, screenshots each step, draws a red highlight circle around
   the target, adds a caption banner, and compiles a **PDF**.

## Repo layout

| Path | Purpose |
| --- | --- |
| [SKILL.md](SKILL.md) | The agent workflow: subagents + Playwright MCP + checkpoints |
| [tutorial.schema.json](tutorial.schema.json) | JSON Schema the configs are validated against |
| [tutorial_generator.py](tutorial_generator.py) | Renderer: navigate, screenshot, annotate, build PDF |
| `tutorials/` | Committed tutorial configs (one JSON per tutorial) |
| [requirements.txt](requirements.txt) | `playwright`, `Pillow`, `jsonschema` |

## Setup

```powershell
py -m pip install -r requirements.txt
py -m playwright install chromium
```

To author tutorials with the skill you also need a **Playwright MCP server**
configured so subagents can drive a live browser.

## Authoring a tutorial (with the skill)

Ask the agent something like *"generate a tutorial for how to search on
Wikipedia"*. It follows [SKILL.md](SKILL.md): explores the site, writes
`tutorials/<slug>.json` checkpoint-by-checkpoint, then renders the PDF.

## Rendering a tutorial (manually)

```powershell
py tutorial_generator.py tutorials/wikipedia-search.json
```

This validates the config against the schema, then writes the PDF named by the
config's `output` field (default `tutorial.pdf`). PDFs are git-ignored.

## Config format

A config has top-level `name`, `start_url`, optional `output`, `viewport`,
`headless`, and an ordered `steps` array. Each step targets an element with a
robust **`locator`** object (provide one strategy):

```jsonc
{
  "description": "Submit the search",   // caption shown on the screenshot
  "action": "click",                    // click | fill | press | hover | goto
  "locator": { "role": "button", "name": "Search" },
  "value": "Playwright",                // for fill / press / goto
  "highlight": true,                     // draw the red circle (default true)
  "status": "verified"                  // draft | verified (checkpoint state)
}
```

Locator strategies (pick one, in order of preference):

| Strategy | Example |
| --- | --- |
| `role` (+ `name`) | `{ "role": "button", "name": "Publish" }` |
| `label` | `{ "label": "Email address" }` |
| `testId` | `{ "testId": "submit-btn" }` |
| `text` | `{ "text": "Sign in" }` |
| `css` | `{ "css": "input#searchInput" }` |

A legacy `"selector": "<css>"` string is still accepted and treated as
`{ "css": ... }`.

Validate a config manually:

```powershell
py -c "import json,jsonschema; s=json.load(open('tutorial.schema.json')); c=json.load(open('tutorials/wikipedia-search.json')); jsonschema.Draft7Validator(s).validate(c); print('valid')"
```

## Checkpointing

The JSON file on disk is the single source of truth and the checkpoint:

- Steps are appended and **saved one at a time** during authoring.
- Each step carries a `status`: `draft` until it resolves on the live site,
  then `verified`.
- A run can stop and resume; the committed JSON reflects exactly the verified
  progress so far.

## Future work

- CI drift detection: re-run a tutorial on a schedule, open a PR when a step
  breaks or a screenshot changes.
- Record-mode helper (Playwright codegen-style) to bootstrap configs.
- Numbered badges on circles; HTML/Markdown output alongside PDF.
