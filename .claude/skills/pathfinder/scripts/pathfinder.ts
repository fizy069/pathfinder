#!/usr/bin/env node
/**
 * Automated tutorial doc maintainer.
 *
 * The **source of truth for a tutorial is a replayable Playwright TypeScript
 * spec** (`tutorials/<slug>.spec.ts`). This script parses that spec, drives the
 * same flow with Playwright, captures a screenshot before each step, draws a red
 * circle around the element the user should interact with, and compiles all
 * annotated screenshots into a single PDF tutorial.
 *
 * Because the spec is plain `@playwright/test` code, it can be run directly with
 * `npx playwright test tutorials/<slug>.spec.ts` to replay the flow.
 *
 * Usage:
 *     npx tsx pathfinder.ts tutorials/wikipedia-search.spec.ts
 *     npx tsx pathfinder.ts tutorials/wikipedia-search.spec.ts --check
 *     npx tsx pathfinder.ts tutorials/wikipedia-search.spec.ts --verify
 *     npx tsx pathfinder.ts tutorials/my-app-flow.spec.ts --login  # auth-gated apps
 *     npx tsx pathfinder.ts --migrate tutorials/legacy.json   # one-off
 *
 * Spec format (authored by hand or by the skill):
 *
 *     // Tutorial: How to search on Wikipedia
 *     // PDF output: wikipedia-search.pdf
 *     // Run with: npx playwright test wikipedia-search.spec.ts
 *
 *     import { test } from '@playwright/test';
 *
 *     test.use({ viewport: { width: 1280, height: 800 } });
 *
 *     test('How to search on Wikipedia', async ({ page }) => {
 *       // Open the starting page.
 *       await page.goto('https://www.wikipedia.org');
 *
 *       // Step 1: Click the search box [verified]
 *       await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().click();
 *
 *       // Step 2: Type your query [no-highlight]
 *       await page.getByRole('searchbox', { name: 'Search Wikipedia' }).first().fill('Playwright');
 *     });
 *
 * Metadata is carried in comments: header lines (`// PDF output:`,
 * `// Headless: false`, `// Storage state:`) and per-step tags appended to the `// Step N:` comment
 * (`[no-highlight]` to skip the circle, `[verified]`/`[draft]` checkpoint state).
 * Locator strategies map to Playwright builders: `getByRole` (+ name),
 * `getByLabel`, `getByTestId`, `getByText`, `locator` (CSS). Supported actions:
 * `click` (default), `fill`, `press`, `hover`, `selectOption`, and `goto`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Browser,
  type Locator,
  type Page,
} from 'playwright';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

// --- Annotation styling -------------------------------------------------------

const CIRCLE_COLOR = rgb(220 / 255, 30 / 255, 30 / 255); // red
const CIRCLE_WIDTH = 6; // outline thickness in px
const CIRCLE_PADDING = 14; // extra px around the element
const CAPTION_BG = rgb(33 / 255, 33 / 255, 33 / 255); // dark caption banner
const CAPTION_FG = rgb(1, 1, 1); // white caption text
const CAPTION_HEIGHT = 70; // px
const CAPTION_FONT_SIZE = 26;

// Framing: the screenshot sits on a padded page with a light background and a
// thin border, so it reads as a framed card rather than an edge-to-edge image.
const PAGE_MARGIN = 24; // px of padding around the framed screenshot
const PAGE_BG = rgb(244 / 255, 244 / 255, 245 / 255); // light gray page backdrop
const FRAME_BORDER = rgb(212 / 255, 212 / 255, 216 / 255); // subtle screenshot border
const FRAME_BORDER_WIDTH = 1; // px

// Caption banner: a red step-number badge followed by the caption text.
const BADGE_COLOR = CIRCLE_COLOR; // reuse the red accent
const BADGE_FG = rgb(1, 1, 1); // white badge number
const BADGE_SIZE = 40; // px square badge
const BADGE_PADDING = 16; // px between badge edge and banner edge / text
const BADGE_FONT_SIZE = 22;

// Dynamic pages can detach/re-render elements between highlight and action.
const LOCATOR_RETRY_COUNT = 3;
const LOCATOR_RETRY_DELAY_MS = 350;

// --- Types --------------------------------------------------------------------

interface LocatorSpec {
  role?: string;
  name?: string;
  label?: string;
  testId?: string;
  text?: string;
  css?: string;
}

interface Step {
  description?: string;
  action?: string;
  value?: string;
  highlight?: boolean;
  status?: string;
  locator?: LocatorSpec;
  selector?: string;
}

interface Viewport {
  width: number;
  height: number;
}

interface Config {
  name: string;
  start_url: string;
  viewport: Viewport;
  headless: boolean;
  steps: Step[];
  output?: string;
  /**
   * Path to a Playwright storageState JSON holding a logged-in session, so
   * tutorials for auth-gated apps render the real workflow instead of the login
   * page. Captured once by hand with `--login`; never contains credentials the
   * spec itself has to carry.
   */
  storage_state?: string;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// --- Annotation (drawn directly onto the PDF page) ----------------------------

/** Add an annotated page (red highlight circle + caption banner) to the PDF. */
async function addAnnotatedPage(
  pdf: PDFDocument,
  font: PDFFont,
  boldFont: PDFFont,
  imageBytes: Buffer,
  box: BoundingBox | null,
  caption: string,
  stepNumber: number,
): Promise<void> {
  const png = await pdf.embedPng(imageBytes);
  const { width, height } = png;

  // The screenshot is framed inside a padded page: margins on every side and a
  // caption banner above it. PDF origin is bottom-left.
  const pageWidth = width + PAGE_MARGIN * 2;
  const pageHeight = height + CAPTION_HEIGHT + PAGE_MARGIN * 2;
  const imageX = PAGE_MARGIN;
  const imageY = PAGE_MARGIN;
  const bannerY = imageY + height;

  const page = pdf.addPage([pageWidth, pageHeight]);

  // Light backdrop behind the framed screenshot.
  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: PAGE_BG });

  // Screenshot, with a subtle border so it reads as a framed card.
  page.drawImage(png, { x: imageX, y: imageY, width, height });
  page.drawRectangle({
    x: imageX,
    y: imageY,
    width,
    height,
    borderColor: FRAME_BORDER,
    borderWidth: FRAME_BORDER_WIDTH,
  });

  // Caption banner above the screenshot, aligned to the framed width.
  page.drawRectangle({
    x: imageX,
    y: bannerY,
    width,
    height: CAPTION_HEIGHT,
    color: CAPTION_BG,
  });

  // Red step-number badge on the left of the banner.
  const badgeX = imageX + BADGE_PADDING;
  const badgeY = bannerY + (CAPTION_HEIGHT - BADGE_SIZE) / 2;
  page.drawRectangle({
    x: badgeX,
    y: badgeY,
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    color: BADGE_COLOR,
  });
  const badgeText = String(stepNumber);
  const badgeTextWidth = boldFont.widthOfTextAtSize(badgeText, BADGE_FONT_SIZE);
  page.drawText(badgeText, {
    x: badgeX + (BADGE_SIZE - badgeTextWidth) / 2,
    y: badgeY + (BADGE_SIZE - BADGE_FONT_SIZE) / 2 + BADGE_FONT_SIZE * 0.12,
    size: BADGE_FONT_SIZE,
    font: boldFont,
    color: BADGE_FG,
  });

  // Caption text to the right of the badge.
  const text = caption || `Step ${stepNumber}`;
  page.drawText(text, {
    x: badgeX + BADGE_SIZE + BADGE_PADDING,
    y: bannerY + CAPTION_HEIGHT / 2 - CAPTION_FONT_SIZE * 0.35,
    size: CAPTION_FONT_SIZE,
    font,
    color: CAPTION_FG,
  });

  // Draw the red highlight ellipse hugging the target element. Screenshot pixel
  // coordinates (origin top-left) map to PDF coordinates via y -> height - y,
  // then offset by the page margins that inset the screenshot.
  if (box !== null) {
    const left = box.x - CIRCLE_PADDING;
    const top = box.y - CIRCLE_PADDING;
    const right = box.x + box.width + CIRCLE_PADDING;
    const bottom = box.y + box.height + CIRCLE_PADDING;
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    page.drawEllipse({
      x: imageX + centerX,
      y: imageY + height - centerY,
      xScale: (right - left) / 2,
      yScale: (bottom - top) / 2,
      borderColor: CIRCLE_COLOR,
      borderWidth: CIRCLE_WIDTH,
    });
  }
}

// --- Locator resolution -------------------------------------------------------

/**
 * Build a Playwright Locator from a step's robust `locator` object.
 *
 * Falls back to a legacy `selector` string (treated as CSS) for backward
 * compatibility. Strategy preference mirrors the schema: role > label > testId >
 * text > css.
 */
function resolveLocator(page: Page, step: Step): Locator {
  const loc = step.locator;
  if (loc === undefined) {
    const selector = step.selector;
    if (!selector) {
      throw new Error(
        `Step ${JSON.stringify(step.description)} has no 'locator' or 'selector'.`,
      );
    }
    return page.locator(selector);
  }

  if (loc.role !== undefined) {
    if (loc.name !== undefined) {
      return page.getByRole(loc.role as Parameters<Page['getByRole']>[0], {
        name: loc.name,
      });
    }
    return page.getByRole(loc.role as Parameters<Page['getByRole']>[0]);
  }
  if (loc.label !== undefined) {
    return page.getByLabel(loc.label);
  }
  if (loc.testId !== undefined) {
    return page.getByTestId(loc.testId);
  }
  if (loc.text !== undefined) {
    return page.getByText(loc.text);
  }
  if (loc.css !== undefined) {
    return page.locator(loc.css);
  }

  throw new Error(`Unrecognized locator object: ${JSON.stringify(loc)}`);
}

// --- Replayable TypeScript emitter --------------------------------------------

/** Render a string as a single-quoted TypeScript string literal. */
function tsString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `'${escaped}'`;
}

/**
 * Build the Playwright TS locator expression for a step.
 *
 * Mirrors resolveLocator: role > label > testId > text > css, with a legacy
 * `selector` string treated as CSS.
 */
function locatorToTs(step: Step): string {
  const loc = step.locator;
  if (loc === undefined) {
    const selector = step.selector;
    if (!selector) {
      throw new Error(
        `Step ${JSON.stringify(step.description)} has no 'locator' or 'selector'.`,
      );
    }
    return `page.locator(${tsString(selector)})`;
  }

  if (loc.role !== undefined) {
    if (loc.name !== undefined) {
      return `page.getByRole(${tsString(loc.role)}, { name: ${tsString(loc.name)} })`;
    }
    return `page.getByRole(${tsString(loc.role)})`;
  }
  if (loc.label !== undefined) {
    return `page.getByLabel(${tsString(loc.label)})`;
  }
  if (loc.testId !== undefined) {
    return `page.getByTestId(${tsString(loc.testId)})`;
  }
  if (loc.text !== undefined) {
    return `page.getByText(${tsString(loc.text)})`;
  }
  if (loc.css !== undefined) {
    return `page.locator(${tsString(loc.css)})`;
  }

  throw new Error(`Unrecognized locator object: ${JSON.stringify(loc)}`);
}

/** Render a single step as an awaited Playwright TS statement. */
function actionToTs(step: Step): string {
  const action = step.action ?? 'click';

  if (action === 'goto') {
    return `await page.goto(${tsString(step.value ?? '')});`;
  }

  const target = `${locatorToTs(step)}.first()`;
  if (action === 'click') {
    return `await ${target}.click();`;
  }
  if (action === 'fill') {
    return `await ${target}.fill(${tsString(step.value ?? '')});`;
  }
  if (action === 'press') {
    return `await ${target}.press(${tsString(step.value ?? 'Enter')});`;
  }
  if (action === 'hover') {
    return `await ${target}.hover();`;
  }
  if (action === 'select') {
    return `await ${target}.selectOption(${tsString(step.value ?? '')});`;
  }

  throw new Error(`Unsupported action: ${JSON.stringify(action)}`);
}

/** Render the trailing `[no-highlight] [verified]` tags for a step comment. */
function stepTags(step: Step): string {
  const tags: string[] = [];
  if (step.highlight === false) {
    tags.push('[no-highlight]');
  }
  if (step.status === 'verified') {
    tags.push('[verified]');
  }
  return tags.length ? ' ' + tags.join(' ') : '';
}

/** Generate a replayable Playwright `@playwright/test` spec for a config. */
function toTypescript(config: Config, specFilename?: string): string {
  const name = config.name ?? 'Tutorial';
  const viewport = config.viewport ?? { width: 1280, height: 800 };
  const specStem = specFilename ?? 'tutorial.spec.ts';
  const output =
    config.output ?? specStem.replace(/\.spec\.ts$/, '') + '.pdf';

  const header = [
    '// Replayable Playwright tutorial — source of truth for this tutorial.',
    `// Tutorial: ${name}`,
    `// PDF output: ${output}`,
  ];
  if (config.storage_state) {
    header.push(`// Storage state: ${config.storage_state}`);
  }
  if (!(config.headless ?? true)) {
    header.push('// Headless: false');
  }
  header.push(`// Run with: npx playwright test ${specStem}`);

  const lines: string[] = [];
  lines.push(...header);
  lines.push('');
  lines.push("import { test } from '@playwright/test';");
  lines.push('');
  lines.push(
    `test.use({ viewport: { width: ${Math.trunc(viewport.width)}, ` +
      `height: ${Math.trunc(viewport.height)} } });`,
  );
  lines.push('');
  lines.push(`test(${tsString(name)}, async ({ page }) => {`);
  lines.push('  // Open the starting page.');
  lines.push(`  await page.goto(${tsString(config.start_url)});`);

  config.steps.forEach((step, idx) => {
    const desc = step.description ?? step.selector ?? '';
    lines.push('');
    lines.push(`  // Step ${idx + 1}: ${desc}${stepTags(step)}`);
    lines.push(`  ${actionToTs(step)}`);
  });

  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

/** Write the replayable TS spec to `tsPath`. */
async function writeTypescript(config: Config, tsPath: string): Promise<string> {
  await fs.mkdir(path.dirname(tsPath), { recursive: true });
  await fs.writeFile(tsPath, toTypescript(config, path.basename(tsPath)), 'utf-8');
  return tsPath;
}

// --- Replayable TypeScript parser (spec is the source of truth) ---------------

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) {
    i += 1;
  }
  return i;
}

/** Read a single-quoted JS string literal at `s[i]`; return [value, next]. */
function readString(s: string, i: number): [string, number] {
  if (i >= s.length || s[i] !== "'") {
    throw new Error(`Expected string literal at offset ${i} in ${JSON.stringify(s)}`);
  }
  i += 1;
  const out: string[] = [];
  const escapes: Record<string, string> = {
    n: '\n',
    r: '\r',
    t: '\t',
    '\\': '\\',
    "'": "'",
    '"': '"',
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      out.push(escapes[s[i + 1]] ?? s[i + 1]);
      i += 2;
    } else if (c === "'") {
      return [out.join(''), i + 1];
    } else {
      out.push(c);
      i += 1;
    }
  }
  throw new Error(`Unterminated string literal in ${JSON.stringify(s)}`);
}

/** Given `s[i] === '('`, return [inner, indexAfterClose], string-aware. */
function readBalanced(s: string, i: number): [string, number] {
  if (s[i] !== '(') {
    throw new Error(`Expected '(' at offset ${i} in ${JSON.stringify(s)}`);
  }
  let depth = 0;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      [, i] = readString(s, i);
      continue;
    }
    if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        return [s.slice(start + 1, i), i + 1];
      }
    }
    i += 1;
  }
  throw new Error(`Unbalanced parentheses in ${JSON.stringify(s)}`);
}

/** Split `page.getByRole(...).first().click()` into [[method, args], ...]. */
function splitChain(expr: string): Array<[string, string]> {
  expr = expr.trim();
  if (!expr.startsWith('page')) {
    throw new Error(`Statement does not start with 'page': ${JSON.stringify(expr)}`);
  }
  let i = 'page'.length;
  const calls: Array<[string, string]> = [];
  while (i < expr.length) {
    if (expr[i] !== '.') {
      break;
    }
    let j = i + 1;
    while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) {
      j += 1;
    }
    const method = expr.slice(i + 1, j);
    if (j >= expr.length || expr[j] !== '(') {
      throw new Error(`Expected '(' after .${method} in ${JSON.stringify(expr)}`);
    }
    const [args, k] = readBalanced(expr, j);
    calls.push([method, args]);
    i = k;
  }
  return calls;
}

/** Map a Playwright locator builder call back to a locator object. */
function locatorFromCall(method: string, args: string): LocatorSpec {
  if (method === 'getByRole') {
    const [role, i] = readString(args, skipWs(args, 0));
    const loc: LocatorSpec = { role };
    const m = /name\s*:/.exec(args.slice(i));
    if (m) {
      const rest = args.slice(i + m.index + m[0].length);
      const [name] = readString(rest, skipWs(rest, 0));
      loc.name = name;
    }
    return loc;
  }
  const single: Record<string, keyof LocatorSpec> = {
    getByLabel: 'label',
    getByTestId: 'testId',
    getByText: 'text',
    locator: 'css',
  };
  if (method in single) {
    const [value] = readString(args, skipWs(args, 0));
    return { [single[method]]: value } as LocatorSpec;
  }
  throw new Error(`Unrecognized locator builder: ${JSON.stringify(method)}`);
}

/** Parse one `page....` statement into [action, locator, value]. */
function parseStatement(
  stmt: string,
): [string, LocatorSpec | null, string | null] {
  const calls = splitChain(stmt);
  if (calls.length === 0) {
    throw new Error(`No calls found in statement: ${JSON.stringify(stmt)}`);
  }

  if (calls[0][0] === 'goto') {
    const [url] = readString(calls[0][1], skipWs(calls[0][1], 0));
    return ['goto', null, url];
  }

  const locator = locatorFromCall(calls[0][0], calls[0][1]);
  const [actionMethod, actionArgs] = calls[calls.length - 1];
  const actionMap: Record<string, string> = {
    click: 'click',
    fill: 'fill',
    press: 'press',
    hover: 'hover',
    selectOption: 'select',
  };
  if (!(actionMethod in actionMap)) {
    throw new Error(
      `Unsupported action call: .${actionMethod}() in ${JSON.stringify(stmt)}`,
    );
  }
  const action = actionMap[actionMethod];

  let value: string | null = null;
  if (action === 'fill' || action === 'press' || action === 'select') {
    [value] = readString(actionArgs, skipWs(actionArgs, 0));
  }
  return [action, locator, value];
}

/** Strip trailing `[no-highlight]`/`[verified]` tags from a step caption. */
function splitTags(text: string): [string, boolean, string] {
  let highlight = true;
  let status = 'draft';
  while (true) {
    const m = /\s*\[([^\]]+)\]\s*$/.exec(text);
    if (!m) {
      break;
    }
    const token = m[1].trim().toLowerCase();
    if (token === 'no-highlight') {
      highlight = false;
    } else if (token === 'verified' || token === 'draft') {
      status = token;
    } else {
      break; // unknown bracket content belongs to the caption
    }
    text = text.slice(0, m.index);
  }
  return [text.trim(), highlight, status];
}

/** Parse a replayable spec into the internal tutorial config object. */
function parseTypescript(text: string): Config {
  const nameMatch = /test\(\s*'((?:[^'\\]|\\.)*)'/.exec(text);
  const name = nameMatch ? readString("'" + nameMatch[1] + "'", 0)[0] : 'Tutorial';

  let viewport: Viewport = { width: 1280, height: 800 };
  const vp = /viewport:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/.exec(text);
  if (vp) {
    viewport = { width: parseInt(vp[1], 10), height: parseInt(vp[2], 10) };
  }

  const outputMatch = /^\/\/\s*PDF output:\s*(.+)$/m.exec(text);
  const output = outputMatch ? outputMatch[1].trim() : undefined;
  const headless = /^\/\/\s*Headless:\s*false\s*$/m.exec(text) === null;
  const storageMatch = /^\/\/\s*Storage state:\s*(.+)$/m.exec(text);
  const storageState = storageMatch ? storageMatch[1].trim() : undefined;

  let startUrl: string | null = null;
  const steps: Step[] = [];
  let pending: { description: string; highlight: boolean; status: string } | null =
    null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const stepComment = /^\/\/\s*Step\s+\d+:\s*(.*)$/.exec(line);
    if (stepComment) {
      const [desc, highlight, status] = splitTags(stepComment[1]);
      pending = { description: desc, highlight, status };
      continue;
    }
    if (!line.startsWith('await ')) {
      continue;
    }

    const stmt = line.slice('await '.length).trim().replace(/;$/, '').trim();
    const [action, locator, value] = parseStatement(stmt);

    if (action === 'goto' && startUrl === null && pending === null) {
      startUrl = value;
      continue;
    }

    const step: Step = {
      description: pending?.description ?? '',
      action,
      highlight: pending?.highlight ?? true,
      status: pending?.status ?? 'draft',
    };
    if (locator !== null) {
      step.locator = locator;
    }
    if (value !== null) {
      step.value = value;
    }
    steps.push(step);
    pending = null;
  }

  if (startUrl === null) {
    throw new Error(
      "No start URL found (expected an initial 'await page.goto(...)').",
    );
  }

  const config: Config = {
    name,
    start_url: startUrl,
    viewport,
    headless,
    steps,
  };
  if (output) {
    config.output = output;
  }
  if (storageState) {
    config.storage_state = storageState;
  }
  return config;
}

// --- Playwright actions -------------------------------------------------------

/** True when a locator likely failed due to transient page re-rendering. */
function isTransientLocatorError(exc: unknown): boolean {
  const message = String(exc instanceof Error ? exc.message : exc).toLowerCase();
  return (
    message.includes('not attached') ||
    message.includes('not stable') ||
    message.includes('timeout')
  );
}

/** Execute the configured action for a step after the screenshot is taken. */
async function performAction(page: Page, step: Step): Promise<void> {
  const action = step.action ?? 'click';

  if (action === 'goto') {
    await page.goto(step.value ?? '', { waitUntil: 'domcontentloaded' });
    return;
  }

  for (let attempt = 1; attempt <= LOCATOR_RETRY_COUNT; attempt += 1) {
    const locator = resolveLocator(page, step).first();
    try {
      if (action === 'click') {
        await locator.click();
      } else if (action === 'fill') {
        await locator.fill(step.value ?? '');
      } else if (action === 'press') {
        await locator.press(step.value ?? 'Enter');
      } else if (action === 'hover') {
        await locator.hover();
      } else if (action === 'select') {
        await locator.selectOption(step.value ?? '');
      } else {
        throw new Error(`Unsupported action: ${JSON.stringify(action)}`);
      }
      break;
    } catch (exc) {
      if (attempt === LOCATOR_RETRY_COUNT || !isTransientLocatorError(exc)) {
        throw exc;
      }
      await page.waitForTimeout(LOCATOR_RETRY_DELAY_MS);
    }
  }

  // Let the page settle after the interaction.
  await page.waitForLoadState('domcontentloaded');
}

/** Highlight the target element, screenshot the viewport, then collect the box. */
async function captureStep(
  page: Page,
  step: Step,
  stepNumber: number,
): Promise<{ imageBytes: Buffer; box: BoundingBox | null }> {
  let box: BoundingBox | null = null;
  const hasTarget = step.locator !== undefined || Boolean(step.selector);

  if (hasTarget && (step.action ?? 'click') !== 'goto' && step.highlight !== false) {
    for (let attempt = 1; attempt <= LOCATOR_RETRY_COUNT; attempt += 1) {
      const locator = resolveLocator(page, step).first();
      try {
        await locator.waitFor({ state: 'attached', timeout: 5000 });
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250); // allow scroll/animation to settle
        box = await locator.boundingBox();
        break;
      } catch (exc) {
        if (!isTransientLocatorError(exc)) {
          throw exc;
        }
        if (attempt === LOCATOR_RETRY_COUNT) {
          console.error(
            `Warning: highlight skipped for step ${stepNumber} ` +
              'due to transient locator instability.',
          );
        } else {
          await page.waitForTimeout(LOCATOR_RETRY_DELAY_MS);
        }
      }
    }
  }

  const imageBytes = await page.screenshot({ fullPage: false });
  return { imageBytes, box };
}

// --- Validation ---------------------------------------------------------------

const ALLOWED_ACTIONS = new Set([
  'click',
  'fill',
  'press',
  'hover',
  'select',
  'goto',
]);

/** Structurally validate a parsed tutorial config, throwing on the first error. */
function validateConfig(config: Config): void {
  const errors: string[] = [];

  if (typeof config.name !== 'string' || !config.name.trim()) {
    errors.push("<root>: 'name' must be a non-empty string.");
  }
  if (typeof config.start_url !== 'string' || !config.start_url.trim()) {
    errors.push("<root>: 'start_url' must be a non-empty string.");
  }
  let steps = config.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push("<root>: 'steps' must be a non-empty list.");
    steps = [];
  }

  steps.forEach((step, idx) => {
    const where = `step ${idx + 1}`;
    if (typeof step.description !== 'string' || !step.description.trim()) {
      errors.push(`${where}: 'description' must be a non-empty string.`);
    }
    const action = step.action ?? 'click';
    if (!ALLOWED_ACTIONS.has(action)) {
      errors.push(`${where}: unsupported action ${JSON.stringify(action)}.`);
    }
    if (action !== 'goto' && step.locator === undefined) {
      errors.push(`${where}: non-goto step requires a 'locator'.`);
    }
    if ((action === 'goto' || action === 'fill' || action === 'select') && !step.value) {
      errors.push(`${where}: action ${JSON.stringify(action)} requires a 'value'.`);
    }
  });

  if (errors.length) {
    throw new Error('Spec failed validation:\n  - ' + errors.join('\n  - '));
  }
}

// --- Orchestration ------------------------------------------------------------

/** Load a tutorial config from a `.spec.ts` (source) or legacy `.json`. */
async function loadConfig(filePath: string): Promise<Config> {
  const ext = path.extname(filePath);
  let config: Config;
  if (ext === '.ts') {
    config = parseTypescript(await fs.readFile(filePath, 'utf-8'));
  } else if (ext === '.json') {
    console.error(
      `Warning: ${path.basename(filePath)} is a legacy JSON config. The ` +
        "replayable '.spec.ts' is now the source of truth; migrate with --migrate.",
    );
    config = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Config;
  } else {
    throw new Error(`Unsupported source type: ${JSON.stringify(ext)} (expected .ts)`);
  }

  if (!config.output) {
    let base = path.basename(filePath);
    for (const suffix of ['.spec.ts', '.ts', '.json']) {
      if (base.endsWith(suffix)) {
        base = base.slice(0, base.length - suffix.length);
        break;
      }
    }
    config.output = base + '.pdf';
  }
  // Resolve the PDF output next to the spec file so it lands in the user's
  // project regardless of the current working directory (the skill runs the
  // generator from the skill folder, but the spec lives in the user's repo).
  if (!path.isAbsolute(config.output)) {
    config.output = path.join(path.dirname(path.resolve(filePath)), config.output);
  }
  // Same for the saved session: it lives beside the spec in the user's repo.
  if (config.storage_state && !path.isAbsolute(config.storage_state)) {
    config.storage_state = path.join(
      path.dirname(path.resolve(filePath)),
      config.storage_state,
    );
  }
  return config;
}

/**
 * Build the browser context options for a run, attaching a saved login session
 * when the spec declares one. Fails loudly rather than silently rendering a
 * login page, which is the failure mode this exists to prevent.
 */
async function contextOptions(
  config: Config,
  viewport: Viewport,
): Promise<{ viewport: Viewport; deviceScaleFactor: number; storageState?: string }> {
  const options = { viewport, deviceScaleFactor: 1 };
  if (!config.storage_state) {
    return options;
  }
  if (!(await fileExists(config.storage_state))) {
    throw new Error(
      `Saved session not found: ${config.storage_state}\n` +
        'Capture it once (a real browser opens; log in by hand, then press Enter):\n' +
        `  npx tsx scripts/pathfinder.ts <spec> --login`,
    );
  }
  return { ...options, storageState: config.storage_state };
}

async function generate(config: Config): Promise<string> {
  const output = config.output ?? 'tutorial.pdf';
  const viewport = config.viewport ?? { width: 1280, height: 800 };
  const headless = config.headless ?? true;
  const captures: Array<{
    imageBytes: Buffer;
    box: BoundingBox | null;
    caption: string;
    stepNumber: number;
  }> = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext(await contextOptions(config, viewport));
    const page = await context.newPage();

    console.log(`Navigating to ${config.start_url}`);
    await page.goto(config.start_url, { waitUntil: 'domcontentloaded' });

    for (let i = 0; i < config.steps.length; i += 1) {
      const step = config.steps[i];
      const desc = step.description ?? step.selector ?? '';
      console.log(`  Step ${i + 1}: ${desc}`);
      const { imageBytes, box } = await captureStep(page, step, i + 1);
      captures.push({ imageBytes, box, caption: desc, stepNumber: i + 1 });
      await performAction(page, step);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  if (captures.length === 0) {
    throw new Error('No steps produced any screenshots; nothing to write.');
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const c of captures) {
    await addAnnotatedPage(
      pdf,
      font,
      boldFont,
      c.imageBytes,
      c.box,
      c.caption,
      c.stepNumber,
    );
  }

  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const bytes = await pdf.save();
  await fs.writeFile(output, bytes);
  console.log(
    `Wrote ${captures.length} page(s) to ${path.resolve(output)}`,
  );
  return output;
}

// --- Drift verification (replay each step, report pass/fail, no PDF) ----------

type StepStatus = 'ok' | 'failed' | 'skipped';

interface StepResult {
  stepNumber: number;
  description: string;
  status: StepStatus;
  detail: string;
  error?: string;
}

/** Short, human-readable description of a step's action + locator. */
function describeStep(step: Step): string {
  const action = step.action ?? 'click';
  if (action === 'goto') {
    return `goto ${step.value ?? ''}`;
  }
  let target: string;
  try {
    target = locatorToTs(step);
  } catch {
    target = '<unresolved locator>';
  }
  const value = step.value !== undefined ? ` ${JSON.stringify(step.value)}` : '';
  return `${action}${value} -> ${target}`;
}

/**
 * Replay the tutorial step by step on the live site and report which steps still
 * resolve. Does not render a PDF. Returns the per-step results plus whether the
 * whole tutorial passed. Once a step fails, the page state can no longer advance,
 * so the remaining steps are reported as 'skipped'.
 */
async function verify(
  config: Config,
  timeoutMs = 6000,
): Promise<{ ok: boolean; results: StepResult[] }> {
  const viewport = config.viewport ?? { width: 1280, height: 800 };
  const headless = config.headless ?? true;
  const results: StepResult[] = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext(await contextOptions(config, viewport));
    const page = await context.newPage();
    // Fail fast on drifted locators instead of waiting the default 30s.
    page.setDefaultTimeout(timeoutMs);

    await page.goto(config.start_url, { waitUntil: 'domcontentloaded' });

    let broken = false;
    for (let i = 0; i < config.steps.length; i += 1) {
      const step = config.steps[i];
      const base: StepResult = {
        stepNumber: i + 1,
        description: step.description ?? step.selector ?? '',
        status: 'ok',
        detail: describeStep(step),
      };

      if (broken) {
        results.push({ ...base, status: 'skipped' });
        continue;
      }

      try {
        await performAction(page, step);
        results.push(base);
      } catch (exc) {
        broken = true;
        results.push({
          ...base,
          status: 'failed',
          error: (exc instanceof Error ? exc.message : String(exc))
            .split('\n')[0]
            .trim(),
        });
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  const ok = results.every((r) => r.status === 'ok');
  return { ok, results };
}

/** Print a verify report to the console; return the process exit code. */
function reportVerify(
  config: Config,
  results: StepResult[],
  ok: boolean,
): number {
  const label: Record<StepStatus, string> = {
    ok: 'OK  ',
    failed: 'FAIL',
    skipped: 'SKIP',
  };
  console.log(`Verifying: ${config.name}`);
  console.log(`  start: ${config.start_url}`);
  for (const r of results) {
    const line = `  Step ${r.stepNumber}: ${label[r.status]}  ${r.description}`;
    console.log(line);
    console.log(`           ${r.detail}`);
    if (r.status === 'failed' && r.error) {
      console.log(`           drift: ${r.error}`);
    }
  }
  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
  console.log(
    `${counts.ok} ok, ${counts.failed} failed, ${counts.skipped} skipped - ` +
      (ok ? 'up to date' : 'STALE'),
  );
  return ok ? 0 : 1;
}

/**
 * Open a real browser at the tutorial's start URL, let a human log in, then
 * persist the session to the spec's `// Storage state:` path. Runs headed and
 * waits on stdin, so it is driven by the user in their own terminal — no
 * credential ever passes through the spec, the agent, or the PDF.
 */
async function login(config: Config): Promise<number> {
  if (!config.storage_state) {
    console.error(
      'This spec has no saved session configured. Add a header line first:\n' +
        '  // Storage state: .auth/<app>.json',
    );
    return 1;
  }
  const viewport = config.viewport ?? { width: 1280, height: 800 };
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(config.start_url, { waitUntil: 'domcontentloaded' });

    console.log(`A browser window is open at ${config.start_url}`);
    console.log('Log in there, navigate to where the tutorial should start,');
    console.log('then come back here and press Enter to save the session.');
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once('data', () => {
        process.stdin.pause();
        resolve();
      });
    });

    await fs.mkdir(path.dirname(config.storage_state), { recursive: true });
    await context.storageState({ path: config.storage_state });
    console.log(`Saved session to ${config.storage_state}`);
    console.log('Keep this file out of version control — it grants account access.');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  return 0;
}

interface CliArgs {
  source: string;
  check: boolean;
  verify: boolean;
  migrate: boolean;
  login: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let source: string | undefined;
  let check = false;
  let verify = false;
  let migrate = false;
  let login = false;
  for (const arg of argv) {
    if (arg === '--check') {
      check = true;
    } else if (arg === '--verify') {
      verify = true;
    } else if (arg === '--migrate') {
      migrate = true;
    } else if (arg === '--login') {
      login = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (source === undefined) {
      source = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }
  if (source === undefined) {
    throw new Error(
      "Path to the tutorial '.spec.ts' (source of truth) is required.",
    );
  }
  return { source, check, verify, migrate, login };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    console.error(String(exc instanceof Error ? exc.message : exc));
    return 1;
  }

  if (!(await fileExists(args.source))) {
    console.error(`Source not found: ${args.source}`);
    return 1;
  }

  try {
    if (args.migrate) {
      if (path.extname(args.source) !== '.json') {
        console.error("--migrate expects a legacy '.json' config.");
        return 1;
      }
      const config = JSON.parse(
        await fs.readFile(args.source, 'utf-8'),
      ) as Config;
      const tsPath = args.source.replace(/\.json$/, '.spec.ts');
      await writeTypescript(config, tsPath);
      console.log(`Wrote replayable spec to ${path.resolve(tsPath)}`);
      return 0;
    }

    const config = await loadConfig(args.source);
    validateConfig(config);
    if (args.check) {
      console.log('valid');
      return 0;
    }
    if (args.login) {
      return await login(config);
    }
    if (args.verify) {
      const { ok, results } = await verify(config);
      return reportVerify(config, results, ok);
    }
    await generate(config);
  } catch (exc) {
    console.error(exc instanceof Error ? exc.stack ?? exc.message : String(exc));
    return 1;
  }
  return 0;
}

// Run when invoked directly (not when imported).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export {
  toTypescript,
  parseTypescript,
  validateConfig,
  loadConfig,
  resolveLocator,
  locatorToTs,
  actionToTs,
  verify,
  describeStep,
};
