# Pathfinder

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
     scripts/pathfinder.ts ──▶ <slug>.pdf (circled, captioned)
```

1. **[SKILL.md](.claude/skills/pathfinder/SKILL.md)** orchestrates the authoring:
   - A **discovery subagent** walks the task on the live site with Playwright
     MCP and records each step from the accessibility tree.
   - **Selector-hardening subagents** pick the most robust locator per element
     (`getByRole` > `getByLabel` > `getByTestId` > `getByText` > `locator`).
   - The orchestrator appends steps **one at a time** and **saves after each** —
     so runs are resumable and the spec is committable mid-flight (the
     *checkpoint*).
2. **[scripts/pathfinder.ts](.claude/skills/pathfinder/scripts/pathfinder.ts)** parses the spec, drives
   Chromium, screenshots each step, draws a red highlight circle around the
   target, adds a caption banner, and compiles a **PDF**. The same spec runs
   directly under `@playwright/test`.

## Repo layout

| Path | Purpose |
| --- | --- |
| [.claude/skills/pathfinder/](.claude/skills/pathfinder/) | The self-contained Agent Skill (the distributable unit) |
| [SKILL.md](.claude/skills/pathfinder/SKILL.md) | The agent workflow: subagents + Playwright MCP + checkpoints |
| [scripts/pathfinder.ts](.claude/skills/pathfinder/scripts/pathfinder.ts) | Parser + renderer: navigate, screenshot, annotate, build PDF |
| [examples/](.claude/skills/pathfinder/examples/) | Committed reference specs |
| [package.json](.claude/skills/pathfinder/package.json) | `@playwright/test`, `pdf-lib`, `tsx` |
| `tutorials/` | Where the skill writes *your* tutorials (git-ignored output) |
| [install.sh](install.sh) / [install.ps1](install.ps1) | Copy the skill into a tool's skills directory |
| [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json) | Claude Code plugin marketplace manifest |

## Install the skill

The skill is an [Agent Skills](https://agentskills.io) package — a folder with a
`SKILL.md`. The same folder works in **Claude Code**, **Cursor**, and **VS Code
Copilot**. Pick whichever install path suits you.

### 1. Install script (copy into a skills directory)

```bash
# macOS / Linux
./install.sh claude               # -> ~/.claude/skills (read by Claude Code AND Cursor)
./install.sh cursor               # -> ~/.cursor/skills
./install.sh project              # -> ./.claude/skills (current project)
./install.sh claude --deps --mcp  # also install deps + configure Playwright MCP
```

```powershell
# Windows PowerShell
./install.ps1 claude
./install.ps1 cursor
./install.ps1 project
./install.ps1 claude -Deps -Mcp   # also install deps + configure Playwright MCP
```

The two prerequisites can be installed automatically:

- `--deps` / `-Deps` runs `npm install` + `npx playwright install chromium` in
  the installed skill folder.
- `--mcp` / `-Mcp` configures the **Playwright MCP server** — for `cursor` it
  writes `~/.cursor/mcp.json`; for `claude` it runs `claude mcp add` (falls back
  to a printed command if the Claude CLI isn't found); for `project` it writes
  both `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor). Existing
  servers in those files are preserved.

> If PowerShell blocks the script (`running scripts is disabled on this system`),
> run it with a one-time bypass:
> `powershell -ExecutionPolicy Bypass -File ./install.ps1 claude`. The same
> applies to `npx` — use `npx.cmd` if `npx` is blocked.

### 2. Copy the folder manually

Copy `.claude/skills/pathfinder/` into any skills location your tool
discovers:

| Tool | Project | Global |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Cursor | `.cursor/skills/`, `.agents/skills/`, or `.claude/skills/` | `~/.cursor/skills/`, `~/.agents/skills/` |
| VS Code Copilot | opening this repo exposes `.claude/skills/pathfinder/` | — |

### 3. Claude Code plugin marketplace

```text
/plugin marketplace add <this-repo-url>
/plugin install pathfinder@pathfinder-marketplace
```

### 4. Cursor — import from GitHub

In **Cursor Settings → Rules → Add Rule → Remote Rule (GitHub)**, paste this
repo's URL. Cursor scans it for `SKILL.md` and imports the skill.

After installing, run once inside the skill folder:

```bash
npm install
npx playwright install chromium
```

You also need a **Playwright MCP server** so the skill can drive a live browser.
The install script can set this up for you (`--mcp` / `-Mcp`, above); otherwise
see [SKILL.md](.claude/skills/pathfinder/SKILL.md) for per-tool MCP setup.

## Authoring a tutorial (with the skill)

Ask the agent something like *"generate a tutorial for how to search on
Wikipedia"*. It follows [SKILL.md](.claude/skills/pathfinder/SKILL.md):
explores the site, writes `tutorials/<slug>.spec.ts` in your project
checkpoint-by-checkpoint, then renders the PDF next to the spec.

## Rendering a tutorial (manually)

Run the generator from the skill folder, passing the path to your spec. The PDF
is written next to the spec.

```bash
cd .claude/skills/pathfinder
npx tsx scripts/pathfinder.ts examples/wikipedia-search.spec.ts
```

Validate a spec without launching a browser:

```bash
npx tsx scripts/pathfinder.ts examples/wikipedia-search.spec.ts --check
```

Drift-check a spec against the live site (replays headless, no PDF, exits
non-zero if any step is stale) — useful for spotting tutorials that have gone
stale:

```bash
npx tsx scripts/pathfinder.ts examples/wikipedia-search.spec.ts --verify
```

Replay the flow with Playwright Test:

```bash
npx playwright test examples/wikipedia-search.spec.ts
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
