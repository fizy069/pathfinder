#!/usr/bin/env python3
"""Automated tutorial doc maintainer.

Given a JSON config describing a navigation path (a sequence of clicks),
this script drives a web page with Playwright, captures a screenshot before
each click, draws a red circle around the element the user should click, and
compiles all annotated screenshots into a single PDF tutorial.

Usage:
    python tutorial_generator.py tutorials/wikipedia-search.json

The config is validated against tutorial.schema.json on load. Each step targets
an element with a robust ``locator`` object (preferred) or a legacy ``selector``
CSS string. Locator strategies (provide one): ``role`` (+ ``name``), ``label``,
``testId``, ``text``, or ``css``.

Config format (JSON):
    {
        "name": "How to search on Wikipedia",
        "start_url": "https://www.wikipedia.org",
        "output": "tutorial.pdf",
        "viewport": {"width": 1280, "height": 800},
        "headless": true,
        "steps": [
            {
                "description": "Click the search box",
                "action": "click",
                "locator": {"role": "searchbox", "name": "Search Wikipedia"},
                "highlight": true,
                "status": "verified"
            },
            {
                "description": "Type your query",
                "action": "fill",
                "locator": {"role": "searchbox", "name": "Search Wikipedia"},
                "value": "Playwright"
            }
        ]
    }

Supported actions: "click" (default), "fill", "press", "hover", "goto".
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Locator, Page, sync_playwright

SCHEMA_PATH = Path(__file__).with_name("tutorial.schema.json")

# --- Annotation styling -------------------------------------------------------

CIRCLE_COLOR = (220, 30, 30)          # red
CIRCLE_WIDTH = 6                       # outline thickness in px
CIRCLE_PADDING = 14                    # extra px around the element
CAPTION_BG = (33, 33, 33)              # dark caption banner
CAPTION_FG = (255, 255, 255)           # white caption text
CAPTION_HEIGHT = 70                    # px


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Try a few common fonts, falling back to PIL's default."""
    for name in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf", "Helvetica.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def annotate_screenshot(
    image_bytes: bytes,
    box: dict[str, float] | None,
    caption: str,
    step_number: int,
) -> Image.Image:
    """Draw a red highlight circle and a caption banner on a screenshot."""
    from io import BytesIO

    shot = Image.open(BytesIO(image_bytes)).convert("RGB")

    # Draw the red highlight circle/ellipse hugging the target element.
    if box is not None:
        draw = ImageDraw.Draw(shot)
        left = box["x"] - CIRCLE_PADDING
        top = box["y"] - CIRCLE_PADDING
        right = box["x"] + box["width"] + CIRCLE_PADDING
        bottom = box["y"] + box["height"] + CIRCLE_PADDING
        draw.ellipse(
            [left, top, right, bottom],
            outline=CIRCLE_COLOR,
            width=CIRCLE_WIDTH,
        )

    # Add a caption banner at the top so each page reads like a tutorial step.
    canvas = Image.new("RGB", (shot.width, shot.height + CAPTION_HEIGHT), CAPTION_BG)
    canvas.paste(shot, (0, CAPTION_HEIGHT))

    draw = ImageDraw.Draw(canvas)
    font = _load_font(26)
    text = f"Step {step_number}: {caption}" if caption else f"Step {step_number}"
    draw.text((20, CAPTION_HEIGHT // 2), text, fill=CAPTION_FG, font=font, anchor="lm")
    return canvas


# --- Locator resolution -------------------------------------------------------

def resolve_locator(page: Page, step: dict[str, Any]) -> Locator:
    """Build a Playwright Locator from a step's robust ``locator`` object.

    Falls back to a legacy ``selector`` string (treated as CSS) for backward
    compatibility. Strategy preference mirrors the schema: role > label >
    testId > text > css.
    """
    loc = step.get("locator")
    if loc is None:
        selector = step.get("selector")
        if not selector:
            raise ValueError(
                f"Step {step.get('description')!r} has no 'locator' or 'selector'."
            )
        return page.locator(selector)

    if "role" in loc:
        name = loc.get("name")
        if name is not None:
            return page.get_by_role(loc["role"], name=name)
        return page.get_by_role(loc["role"])
    if "label" in loc:
        return page.get_by_label(loc["label"])
    if "testId" in loc:
        return page.get_by_test_id(loc["testId"])
    if "text" in loc:
        return page.get_by_text(loc["text"])
    if "css" in loc:
        return page.locator(loc["css"])

    raise ValueError(f"Unrecognized locator object: {loc!r}")


# --- Playwright actions -------------------------------------------------------

def perform_action(page: Page, step: dict[str, Any]) -> None:
    """Execute the configured action for a step after the screenshot is taken."""
    action = step.get("action", "click")

    if action == "goto":
        page.goto(step["value"], wait_until="domcontentloaded")
        return

    locator = resolve_locator(page, step).first
    if action == "click":
        locator.click()
    elif action == "fill":
        locator.fill(step.get("value", ""))
    elif action == "press":
        locator.press(step.get("value", "Enter"))
    elif action == "hover":
        locator.hover()
    elif action == "select":
        locator.select_option(step.get("value", ""))
    else:
        raise ValueError(f"Unsupported action: {action!r}")

    # Let the page settle after the interaction.
    page.wait_for_load_state("domcontentloaded")


def capture_step(page: Page, step: dict[str, Any], step_number: int) -> Image.Image:
    """Highlight the target element, screenshot the viewport, then annotate it."""
    box: dict[str, float] | None = None
    has_target = step.get("locator") is not None or step.get("selector")

    if (
        has_target
        and step.get("action", "click") != "goto"
        and step.get("highlight", True)
    ):
        locator: Locator = resolve_locator(page, step).first
        locator.scroll_into_view_if_needed()
        page.wait_for_timeout(250)  # allow scroll/animation to settle
        box = locator.bounding_box()

    image_bytes = page.screenshot(full_page=False)
    return annotate_screenshot(
        image_bytes,
        box,
        step.get("description", ""),
        step_number,
    )


# --- Validation ---------------------------------------------------------------

def validate_config(config: dict[str, Any]) -> None:
    """Validate a config against the JSON schema, raising on the first error."""
    try:
        import jsonschema
    except ImportError:
        print(
            "jsonschema not installed; skipping validation. "
            "Run 'py -m pip install -r requirements.txt' to enable it.",
            file=sys.stderr,
        )
        return

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = jsonschema.Draft7Validator(schema)
    errors = sorted(validator.iter_errors(config), key=lambda e: e.path)
    if errors:
        lines = ["Config failed schema validation:"]
        for err in errors:
            location = "/".join(str(p) for p in err.path) or "<root>"
            lines.append(f"  - at {location}: {err.message}")
        raise ValueError("\n".join(lines))


# --- Orchestration ------------------------------------------------------------

def generate(config: dict[str, Any]) -> Path:
    output = Path(config.get("output", "tutorial.pdf"))
    viewport = config.get("viewport", {"width": 1280, "height": 800})
    headless = config.get("headless", True)
    pages: list[Image.Image] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(viewport=viewport, device_scale_factor=1)
        page = context.new_page()

        print(f"Navigating to {config['start_url']}", flush=True)
        page.goto(config["start_url"], wait_until="domcontentloaded")

        for i, step in enumerate(config["steps"], start=1):
            desc = step.get("description", step.get("selector", ""))
            print(f"  Step {i}: {desc}", flush=True)
            annotated = capture_step(page, step, i)
            pages.append(annotated)
            perform_action(page, step)

        browser.close()

    if not pages:
        raise SystemExit("No steps produced any screenshots; nothing to write.")

    output.parent.mkdir(parents=True, exist_ok=True)
    pages[0].save(
        output,
        "PDF",
        save_all=True,
        append_images=pages[1:],
        resolution=100.0,
    )
    print(f"Wrote {len(pages)} page(s) to {output.resolve()}")
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a screenshot tutorial PDF.")
    parser.add_argument("config", type=Path, help="Path to the JSON steps config.")
    args = parser.parse_args(argv)

    if not args.config.exists():
        print(f"Config not found: {args.config}", file=sys.stderr)
        return 1

    config = json.loads(args.config.read_text(encoding="utf-8"))
    try:
        validate_config(config)
        generate(config)
    except Exception:
        import traceback

        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
