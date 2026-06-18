# Automated Tutorial Generator

Generate **visual, step-by-step PDF tutorials** for web apps — "how to do X on
this website" as a series of annotated screenshots with the relevant button
**circled** on each page.

Instead of hand-writing fragile CSS selectors, an **AI skill drives a real
browser** (via a Playwright MCP server), discovers a robust click-path, and
saves it as a **validated, checkpointed JSON config** you can commit and update.
A small Python renderer turns that JSON into the PDF.

A flow is a **composable graph** with **branches** (e.g. skip login when already
signed in) and **reusable fragments** (author a `login` once, reuse it across
many tutorials). A render can also emit a **portable artifact** — the
screenshots bundled alongside the JSON — that rebuilds the PDF later without
re-driving the site.

## How it works

```
Task description ──▶ SKILL.md (subagents + Playwright MCP)
                         │  explore live site, harden locators, spot branches
                         ▼
              tutorials/<slug>.json ──▶ use ──▶ fragments/<name>.json
                         │   ◀── validated against tutorial.schema.json
                         │   (the checkpoint: committable, resumable)
                         ▼
       tutorial_generator.py ──▶ tutorial.pdf (circled, captioned)
                         │  --artifact ▼            ▲ --from-artifact (no browser)
                         └─▶ tutorials/<slug>/{media/*.png, tutorial.json}
```

1. **[SKILL.md](SKILL.md)** orchestrates the authoring:
   - A **discovery subagent** walks the task on the live site with Playwright
     MCP, records each step from the accessibility tree, and notes **branch
     points** and any **login to reuse as a fragment**.
   - **Selector-hardening subagents** pick the most robust locator per element
     (`role` > `label` > `testId` > `text` > `css`).
   - The orchestrator appends steps/nodes **one at a time**, validates against
     the schema, and **saves after each** — so runs are resumable and the JSON
     is committable mid-flight (the *checkpoint*).
2. **[tutorial_generator.py](tutorial_generator.py)** validates the config,
   drives Chromium, traverses the graph (inlining fragments, following `when`
   branches, resolving `${param:}`/`${env:}` and secrets), screenshots each
   step, draws a red highlight circle, adds a caption banner, and compiles a
   **PDF** — optionally bundling a replayable artifact.

## Repo layout

| Path | Purpose |
| --- | --- |
| [SKILL.md](SKILL.md) | The agent workflow: subagents + Playwright MCP + checkpoints |
| [tutorial.schema.json](tutorial.schema.json) | JSON Schema the configs are validated against |
| [tutorial_generator.py](tutorial_generator.py) | Renderer: traverse graph, screenshot, annotate, build PDF |
| `tutorials/` | Committed tutorial configs (one JSON per tutorial) |
| `fragments/` | Reusable subgraphs (e.g. login) included by tutorials |
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

For flows that use secrets, export the env vars first, e.g.
`$env:GITHUB_PASSWORD = "..."`.

### Portable artifacts (screenshots bundled with the JSON)

Render live and bundle the captured screenshots into a self-contained directory:

```powershell
py tutorial_generator.py tutorials/<slug>.json --artifact tutorials/<slug>
```

This writes `tutorials/<slug>/media/*.png` and a `tutorials/<slug>/tutorial.json`
that references them. Rebuild the PDF later **without a browser** (and without
any secrets) from that bundle:

```powershell
py tutorial_generator.py --from-artifact tutorials/<slug>
```

## Config format

A config has top-level `name`, optional `start_url`, `output`, `viewport`,
`headless`, optional `params`, and a **`graph`**: a map of `nodes` (id → node)
with a `start` id; each node follows its `next` edge(s) until a node has none.
A node is either a *step node* (one interaction) or a *fragment node* (`use`
another flow and bind its `params` via `with`).

```jsonc
{
  "name": "How to create a new GitHub repository",
  "graph": {
    "start": "login",
    "nodes": {
      "login": {                              // fragment node: reuse shared login
        "use": "../fragments/login.json",
        "with": {                             // bind the fragment's params
          "username": { "env": "GITHUB_USERNAME" },
          "password": { "env": "GITHUB_PASSWORD" }   // secret, never committed
        },
        "next": "open-new"
      },
      "open-new": { "description": "Open New repository", "action": "goto",
                    "value": "https://github.com/new", "next": "name" },
      "name": { "description": "Name the repo", "action": "fill",
                "locator": { "label": "Repository name" }, "value": "my-new-repo",
                "next": "create" },
      "create": { "description": "Click Create repository", "action": "click",
                  "locator": { "role": "button", "name": "Create repository" } }
    }
  }
}
```

A **step node** carries `description` (caption), `action`
(`click` | `fill` | `press` | `hover` | `goto` | `select`), a `locator`,
optional `value`, `highlight` (default true), `status` (`draft` | `verified`),
and `next`.

**Branches** — a node's `next` may be a list; the first edge whose `when` matches
wins, with the `when`-less edge as default:

```jsonc
"next": [
  { "to": "submit", "when": { "visible": { "role": "button", "name": "Search" } } },
  { "to": "retry" }   // default
]
```

Conditions: `{ "visible": locator }`, `{ "exists": locator }`, or
`{ "var": "name", "equals": value }`.

**Fragments & params** — a `fragments/<name>.json` file (`kind: "fragment"`)
declares typed `params` and a `graph`, and carries no screenshots. Tutorials
include it with a fragment node (`use` + `with`). Reference params inside any
`value`/locator string as `${param:NAME}` or `${env:NAME}`. Secrets are declared
`"secret": true` and bound via a `secretRef` (`{ "env": "VAR" }`) — they are
resolved at run time and never written to committed JSON.

Locator strategies (pick one, in order of preference):

| Strategy | Example |
| --- | --- |
| `role` (+ `name`) | `{ "role": "button", "name": "Publish" }` |
| `label` | `{ "label": "Email address" }` |
| `testId` | `{ "testId": "submit-btn" }` |
| `text` | `{ "text": "Sign in" }` |
| `css` | `{ "css": "input#searchInput" }` |

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
- Richer branch conditions (boolean combinations) beyond visible/exists/var.
