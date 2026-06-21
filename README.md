# Automated Tutorial Generator

Generate **visual, step-by-step PDF tutorials** for web apps — "how to do X on
this website" as a series of annotated screenshots with the relevant button
**circled** on each page. Each tutorial is a **replayable Playwright TypeScript
spec**, so the exact flow can also be re-run with `npx playwright test`.

Instead of hand-writing fragile CSS selectors, an **AI skill drives a real
browser** (via a Playwright MCP server), discovers a robust click-path, and
saves it as a **checkpointed `.spec.ts`** you can commit, replay, and update. A
small TypeScript renderer parses that spec to produce the PDF.

## How it works

```
Task description ──▶ SKILL.md (subagents + Playwright MCP)
                         │  explore live site, harden locators
                         ▼
              tutorials/<slug>.spec.ts   ◀── the source of truth
                         │  (checkpoint: committable, resumable, replayable)
                         ├─▶ npx playwright test … (replay the flow)
                         ▼
              tutorial_generator.ts ──▶ <slug>.pdf (circled, captioned)
```

1. **[SKILL.md](SKILL.md)** orchestrates the authoring:
   - A **discovery subagent** walks the task on the live site with Playwright
     MCP and records each step from the accessibility tree.
   - **Selector-hardening subagents** pick the most robust locator per element
     (`getByRole` > `getByLabel` > `getByTestId` > `getByText` > `locator`).
   - The orchestrator appends steps **one at a time** and **saves after each** —
     so runs are resumable and the spec is committable mid-flight (the
     *checkpoint*).
2. **[tutorial_generator.ts](tutorial_generator.ts)** parses the spec, drives
   Chromium, screenshots each step, draws a red highlight circle around the
   target, adds a caption banner, and compiles a **PDF**. The same spec runs
   directly under `@playwright/test`.

## Repo layout

| Path | Purpose |
| --- | --- |
| [SKILL.md](SKILL.md) | The agent workflow: subagents + Playwright MCP + checkpoints |
| [tutorial_generator.ts](tutorial_generator.ts) | Parser + renderer: navigate, screenshot, annotate, build PDF |
| `tutorials/` | Committed tutorials (one `.spec.ts` per tutorial — the source of truth) |
| [package.json](package.json) | `@playwright/test`, `pdf-lib`, `tsx` |

## Setup

```powershell
npm install
npx playwright install chromium
```

To author tutorials with the skill you also need a **Playwright MCP server**
configured so subagents can drive a live browser.

## Authoring a tutorial (with the skill)

Ask the agent something like *"generate a tutorial for how to search on
Wikipedia"*. It follows [SKILL.md](SKILL.md): explores the site, writes
`tutorials/<slug>.spec.ts` checkpoint-by-checkpoint, then renders the PDF.

## Rendering a tutorial (manually)

```powershell
npx tsx tutorial_generator.ts tutorials/wikipedia-search.spec.ts
```

This parses the spec and writes the PDF named by the header's `// PDF output:`
line (defaulting to the spec filename). PDFs are git-ignored.

Validate a spec without launching a browser:

```powershell
npx tsx tutorial_generator.ts tutorials/wikipedia-search.spec.ts --check
```

Drift-check a spec against the live site (replays headless, no PDF, exits
non-zero if any step is stale) — useful for spotting tutorials that have gone
stale:

```powershell
npx tsx tutorial_generator.ts tutorials/wikipedia-search.spec.ts --verify
```

Replay the flow with Playwright Test:

```powershell
npx playwright test tutorials/wikipedia-search.spec.ts
```

## Spec format

The `.spec.ts` is plain `@playwright/test` code; tutorial metadata lives in
comments so the file stays valid TypeScript:

```ts
// Tutorial: How to search on Wikipedia
// PDF output: wikipedia-search.pdf       // optional; defaults to the spec name
// Headless: false                         // optional; render headed
// Run with: npx playwright test wikipedia-search.spec.ts

import { test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 } });

test('How to search on Wikipedia', async ({ page }) => {
  // Open the starting page.            ← first goto is the start URL, not a step
  await page.goto('https://www.wikipedia.org');

  // Step 1: Click the search box [verified]
  await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().click();

  // Step 2: Type your query [no-highlight]
  await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().fill('Playwright');
});
```

- The **`// Step N:`** comment is the screenshot caption. Append `[no-highlight]`
  to skip the red circle and `[verified]`/`[draft]` for the checkpoint state
  (default `draft`).
- Each step is **one awaited statement**. Supported actions: `click` (default),
  `fill`, `press`, `hover`, `selectOption`, and `goto`.

Locator strategies (pick one, in order of preference):

| Strategy | Example |
| --- | --- |
| `getByRole` (+ name) | `page.getByRole('button', { name: 'Publish' })` |
| `getByLabel` | `page.getByLabel('Email address')` |
| `getByTestId` | `page.getByTestId('submit-btn')` |
| `getByText` | `page.getByText('Sign in')` |
| `locator` (CSS) | `page.locator('input#searchInput')` |

## Checkpointing

The `.spec.ts` on disk is the single source of truth and the checkpoint:

- Steps are appended and **saved one at a time** during authoring.
- Each step carries a tag: `[draft]` (default) until it resolves on the live
  site, then `[verified]`.
- A run can stop and resume; the committed spec reflects exactly the verified
  progress so far.

## Future work

- CI drift detection: re-run a tutorial on a schedule, open a PR when a step
  breaks or a screenshot changes.
- Record-mode helper (Playwright codegen-style) to bootstrap specs.
- Numbered badges on circles; HTML/Markdown output alongside PDF.
