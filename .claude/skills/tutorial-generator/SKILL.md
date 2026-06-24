---
name: tutorial-generator
description: >-
  Generate a step-by-step, screenshot-based PDF tutorial for a web task (e.g.
  "how to add an article to Wikipedia"). Uses subagents to explore a live site
  via the Playwright MCP server, builds a checkpointed replayable Playwright
  TypeScript spec (`<slug>.spec.ts`), then renders an annotated PDF (relevant
  buttons circled) from that spec. USE FOR: authoring a new tutorial, updating an
  existing tutorial's spec when a site changes, re-verifying that a tutorial
  still resolves on the live site. DO NOT USE FOR: generic browsing questions,
  non-tutorial scraping, or tasks with no Playwright MCP server available.
---

# Tutorial Generator Skill

Build and maintain visual, step-by-step web tutorials. The deliverable is a
**replayable Playwright TypeScript spec** (`tutorials/<slug>.spec.ts`) — the
single source of truth — plus a rendered **annotated PDF** with the relevant
button circled on each screenshot.

The `.spec.ts` IS the source of truth and the checkpoint. It is plain
`@playwright/test` code, so it can be replayed with
`npx playwright test tutorials/<slug>.spec.ts`. Steps are appended one at a time
and the file is saved after each, so a run is **resumable** and the spec can be
committed mid-flight. The TypeScript renderer parses the spec to draw the PDF.

All generator commands below run **from this skill's folder** (the directory
containing this `SKILL.md`). The generator is bundled at
[scripts/tutorial_generator.ts](scripts/tutorial_generator.ts) and is invoked
with a path to the user's spec; the rendered PDF is written **next to the spec**
in the user's project, not in this skill folder.

## Prerequisites (check first, stop if missing)

1. **Playwright MCP server** must be configured and its browser tools available
   to subagents (navigate, click, snapshot/accessibility tree, screenshot). If
   no Playwright MCP browser tools are available, STOP and tell the user to add a
   Playwright MCP server before continuing — do not guess selectors blindly.
   Add one per host tool:
   - **Claude Code**: `claude mcp add playwright npx @playwright/mcp@latest`
   - **Cursor**: add to `.cursor/mcp.json` →
     `{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }`
   - **VS Code**: add to `.vscode/mcp.json` →
     `{ "servers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }`
2. **Generator deps installed once** in this skill folder (see Phase 0). Only
   needed to render/verify, not to explore.
3. Read [scripts/tutorial_generator.ts](scripts/tutorial_generator.ts) for the
   exact spec format the parser accepts, how locators map to Playwright builders
   (`getByRole`>`getByLabel`>`getByTestId`>`getByText`>`locator`), and the
   supported actions (`click`,`fill`,`press`,`hover`,`selectOption`,`goto`). See
   [examples/](examples/) for committed reference specs.

## Spec format (what you author)

```ts
// Tutorial: How to search on Wikipedia
// PDF output: wikipedia-search.pdf
// Run with: npx playwright test wikipedia-search.spec.ts

import { test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 } });

test('How to search on Wikipedia', async ({ page }) => {
  // Open the starting page.
  await page.goto('https://www.wikipedia.org');

  // Step 1: Click the search box [verified]
  await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().click();

  // Step 2: Type your query [no-highlight]
  await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().fill('Playwright');
});
```

Metadata lives in comments so the file stays valid TypeScript:
- **Header**: `// PDF output: <path>` sets the rendered PDF name (defaults to the
  spec filename). `// Headless: false` runs the render headed.
- **First `await page.goto(...)`** is the tutorial's start URL (not a step).
- **Per-step `// Step N: <caption>`** comment is the screenshot caption. Append
  tags: `[no-highlight]` to skip the red circle, `[verified]`/`[draft]` for the
  checkpoint state (default `draft`).
- **Action line**: one awaited Playwright statement. The locator builder maps to
  the strategy preference `getByRole(+name) > getByLabel > getByTestId >
  getByText > locator(css)`.

## Inputs to collect from the user

- **Task**: what tutorial to produce (e.g. "how to create a new article on
  Wikipedia").
- **Start URL**.
- **Output path** for the spec, default `tutorials/<slug>.spec.ts`.
- **Credentials / auth**: if the flow needs login, ask how to authenticate. Never
  hardcode secrets into the spec; note auth as a manual prerequisite step.

## Workflow

### Phase 0 — Setup
1. Confirm prerequisites above. **On first use**, install the generator's
   dependencies once, from this skill folder:

   ```
   npm install
   npx playwright install chromium
   ```

   (On Windows PowerShell, if `npx` is blocked by execution policy, use `npx.cmd`.)
2. Slugify the task into `tutorials/<slug>.spec.ts` **in the user's project**. If
   that file already exists, load it and treat existing `[verified]` steps as a
   checkpoint to resume from / re-verify rather than redoing them.
3. Initialize (or keep) the spec skeleton — header comments, the
   `import { test }` line, `test.use({ viewport })`, the `test(...)` block with
   the initial `await page.goto(start_url)` and no steps yet — and save it
   immediately.

### Phase 1 — Discovery (one subagent, drives the live browser)
Dispatch a single subagent (so one browser session keeps page state across the
whole flow). Instruct it to:
- Navigate to `start_url` using Playwright MCP.
- Perform the task end to end, one interaction at a time.
- After **each** interaction, capture an **accessibility snapshot** and record a
  raw step: the human-readable caption, the action, any typed value, and
  **candidate identifiers** for the target element (ARIA role + accessible name,
  associated label, `data-testid`, visible text, and a CSS fallback), plus
  whether this element should be circled.
- Return the ordered raw step list. It should NOT write the spec itself — it
  returns structured findings.

Tell the subagent explicitly: report exact role/name/label/testId/text strings
as seen in the accessibility tree; do not invent selectors.

### Phase 2 — Selector hardening (parallel subagents, optional)
For any step whose best identifier is ambiguous or only has a brittle CSS
fallback, dispatch parallel read-only subagents (one per ambiguous element) to
pick the most robust unique locator using the preference order
`getByRole(+name) > getByLabel > getByTestId > getByText > locator(css)`. Each
returns the chosen locator and a one-line justification.

### Phase 3 — Checkpointed authoring (you, the orchestrator)
For each discovered step, in order:
1. Append a `// Step N: <caption>` comment (with `[verified]`/`[no-highlight]`
   tags as needed) and one awaited Playwright statement using a single locator
   strategy.
2. Validate the WHOLE spec (see "Validate" below).
3. **Save the file**. This is the checkpoint — never batch all steps then save
   once.
4. Tag a step `[verified]` only after it actually resolved/ran on the live site
   during discovery; otherwise leave it `[draft]` (the default).

### Phase 4 — Render
Run the generator from this skill folder, passing the path to the user's spec
(absolute, or relative to the user's project). The PDF is written next to the
spec.

```
npx tsx scripts/tutorial_generator.ts <path-to-user-spec>.spec.ts
```

This parses the spec and writes the annotated PDF (per the header's
`// PDF output:`, resolved next to the spec). The same spec replays directly
with `npx playwright test <path-to-user-spec>.spec.ts`.

If a step fails to resolve at render time, the locator drifted — go back to
Phase 1/2 for that step, fix the statement, re-save (checkpoint), re-render.

### Phase 5 — Verify & report
- Confirm the PDF was written and has one page per step.
- Optionally replay the spec with `npx playwright test tutorials/<slug>.spec.ts`
  to confirm it still passes.
- Spot-check that captions match actions and the circled element is the intended
  target.
- Report: spec path, PDF path, number of `[verified]` vs `[draft]` steps, and any
  steps that need human attention.

## Validate (run after every checkpoint)

```
npx tsx scripts/tutorial_generator.ts <path-to-user-spec>.spec.ts --check
```

This parses the spec and runs structural validation, printing precise,
step-qualified errors without launching a browser.

## Updating / drift-checking an existing tutorial

1. Load the existing `tutorials/<slug>.spec.ts`.
2. Run the fast drift check to see which steps still resolve on the live site
   (replays headless, no PDF, exits non-zero if any step is stale):

   ```
   npx tsx scripts/tutorial_generator.ts <path-to-user-spec>.spec.ts --verify
   ```

   It prints a per-step `OK`/`FAIL`/`SKIP` report; a `FAIL` line includes the
   drift reason, and steps after the first failure are `SKIP` (page state can no
   longer advance). A `--verify` run is the cheapest way to detect a stale doc.
3. For drifted steps, a Phase 1 subagent re-walks the flow on the live site to
   find the new locator; update the statement, set the step back to `[draft]`
   until re-verified, save (checkpoint) after each change.
4. Re-render and report what changed.

## Guardrails

- One discovery subagent owns the browser session; hardening subagents are
  read-only and must not navigate destructively.
- Never commit secrets. Auth is a manual prerequisite, not a step.
- Do not fabricate roles/names/selectors — they must come from a real
  accessibility snapshot.
- Keep each step's caption user-facing and imperative ("Click Publish").
- Keep each step on a single `await page....;` line so the parser can read it.
- Save after every step. The spec on disk is always the latest checkpoint.
