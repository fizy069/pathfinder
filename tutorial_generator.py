#!/usr/bin/env python3
"""Automated tutorial doc maintainer.

Given a JSON config describing a navigation path, this script drives a web page
with Playwright, captures a screenshot before each interaction, draws a red
circle around the element the user should click, and compiles all annotated
screenshots into a single PDF tutorial.

A config is a composable ``graph`` (validated against tutorial.schema.json): a
map of ``nodes`` with ``next`` edges (which may branch on ``when`` conditions)
plus reusable *fragment* nodes that inline another flow via ``use`` and bind its
``params`` via ``with``. This lets a shared subgraph (e.g. login) be reused
across many tutorials. Values support ``${param:NAME}`` / ``${env:NAME}``
substitution, and secrets are supplied at run time via ``secretRef``/env and
never committed.

Usage:
    # Render a tutorial graph to its PDF.
    python tutorial_generator.py tutorials/github-create-repo.json

    # Render live AND write a portable artifact (screenshots + JSON) you can
    # re-render later or share without re-driving the site.
    python tutorial_generator.py tutorials/some-flow.json --artifact out/some-flow

    # Rebuild the PDF from a stored artifact, no browser required.
    python tutorial_generator.py --from-artifact out/some-flow

Each step targets an element with a robust ``locator`` object. Locator
strategies (provide one): ``role`` (+ ``name``), ``label``, ``testId``,
``text``, or ``css``.

Supported actions: "click" (default), "fill", "press", "hover", "goto",
"select".
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Locator, Page, sync_playwright

SCHEMA_PATH = Path(__file__).with_name("tutorial.schema.json")

# Maximum number of nodes a single traversal may visit before we assume the
# graph contains an unintended cycle and abort.
MAX_NODES = 500

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


# --- Parameter / secret substitution -----------------------------------------

_SUBST_RE = re.compile(r"\$\{(param|env):([^}]+)\}")


def substitute(text: str, scope: dict[str, Any]) -> str:
    """Replace ``${param:NAME}`` and ``${env:NAME}`` references in ``text``.

    ``param`` references read from the current variable ``scope``; ``env``
    references read from the process environment. Missing references raise so a
    misconfigured flow fails loudly rather than silently typing the literal.
    """

    def _repl(match: re.Match[str]) -> str:
        kind, name = match.group(1), match.group(2)
        if kind == "param":
            if name not in scope or scope[name] is None:
                raise ValueError(f"Unbound parameter referenced: ${{param:{name}}}")
            return str(scope[name])
        value = os.environ.get(name)
        if value is None:
            raise ValueError(f"Environment variable not set: ${{env:{name}}}")
        return value

    return _SUBST_RE.sub(_repl, text)


def resolve_secret_ref(ref: dict[str, Any]) -> str:
    """Resolve a ``secretRef`` (currently only ``{ "env": NAME }``)."""
    if "env" in ref:
        value = os.environ.get(ref["env"])
        if value is None:
            raise ValueError(f"Secret env var not set: {ref['env']}")
        return value
    raise ValueError(f"Unrecognized secretRef: {ref!r}")


def resolve_binding(raw: Any, parent_scope: dict[str, Any]) -> Any:
    """Resolve a fragment ``with`` binding value against the caller's scope."""
    if isinstance(raw, dict):
        return resolve_secret_ref(raw)
    if isinstance(raw, str):
        return substitute(raw, parent_scope)
    return raw  # number / bool literal


def resolve_node_value(node: dict[str, Any], scope: dict[str, Any]) -> str | None:
    """Resolve a step's effective value, honoring ``secretRef`` over ``value``."""
    ref = node.get("secretRef")
    if ref is not None:
        return resolve_secret_ref(ref)
    value = node.get("value")
    if value is None:
        return None
    return substitute(value, scope)


def resolve_locator_object(node: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any] | None:
    """Return the step's ``locator`` with any ``${...}`` references resolved."""
    loc = node.get("locator")
    if loc is None:
        return None
    return {k: (substitute(v, scope) if isinstance(v, str) else v) for k, v in loc.items()}


# --- Locator resolution -------------------------------------------------------

def build_locator(page: Page, loc: dict[str, Any] | None, description: str) -> Locator:
    """Build a Playwright Locator from a resolved ``locator`` dict.

    Strategy preference mirrors the schema: role > label > testId > text > css.
    """
    if loc is None:
        raise ValueError(f"Step {description!r} has no 'locator'.")

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


def resolve_locator(page: Page, node: dict[str, Any], scope: dict[str, Any]) -> Locator:
    """Resolve a step node's target element against the current variable scope."""
    loc = resolve_locator_object(node, scope)
    return build_locator(page, loc, node.get("description", ""))


# --- Playwright actions -------------------------------------------------------

def perform_action(page: Page, node: dict[str, Any], scope: dict[str, Any]) -> None:
    """Execute the configured action for a step after the screenshot is taken."""
    action = node.get("action", "click")

    if action == "goto":
        page.goto(resolve_node_value(node, scope) or "", wait_until="domcontentloaded")
        return

    locator = resolve_locator(page, node, scope).first
    if action == "click":
        locator.click()
    elif action == "fill":
        locator.fill(resolve_node_value(node, scope) or "")
    elif action == "press":
        locator.press(resolve_node_value(node, scope) or "Enter")
    elif action == "hover":
        locator.hover()
    elif action == "select":
        locator.select_option(resolve_node_value(node, scope) or "")
    else:
        raise ValueError(f"Unsupported action: {action!r}")

    # Let the page settle after the interaction.
    page.wait_for_load_state("domcontentloaded")


def capture_step(page: Page, node: dict[str, Any], step_number: int,
                 scope: dict[str, Any]) -> Image.Image:
    """Highlight the target element, screenshot the viewport, then annotate it."""
    box: dict[str, float] | None = None
    has_target = node.get("locator") is not None

    if (
        has_target
        and node.get("action", "click") != "goto"
        and node.get("highlight", True)
    ):
        locator: Locator = resolve_locator(page, node, scope).first
        locator.scroll_into_view_if_needed()
        page.wait_for_timeout(250)  # allow scroll/animation to settle
        box = locator.bounding_box()

    image_bytes = page.screenshot(full_page=False)
    return annotate_screenshot(
        image_bytes,
        box,
        node.get("description", ""),
        step_number,
    )


# --- Graph model --------------------------------------------------------------

def evaluate_condition(cond: dict[str, Any], page: Page, scope: dict[str, Any]) -> bool:
    """Evaluate a branch predicate against the live page / variable scope."""
    if "visible" in cond:
        loc = {k: (substitute(v, scope) if isinstance(v, str) else v)
               for k, v in cond["visible"].items()}
        return build_locator(page, loc, "when.visible").first.is_visible()
    if "exists" in cond:
        loc = {k: (substitute(v, scope) if isinstance(v, str) else v)
               for k, v in cond["exists"].items()}
        return build_locator(page, loc, "when.exists").count() > 0
    if "var" in cond:
        return scope.get(cond["var"]) == cond.get("equals")
    raise ValueError(f"Unrecognized condition: {cond!r}")


def choose_next(next_spec: Any, page: Page, scope: dict[str, Any]) -> str | None:
    """Pick the next node id from a ``next`` spec (string or branch list)."""
    if next_spec is None:
        return None
    if isinstance(next_spec, str):
        return next_spec

    default: str | None = None
    for edge in next_spec:
        cond = edge.get("when")
        if cond is None:
            default = edge["to"]
            continue
        if evaluate_condition(cond, page, scope):
            return edge["to"]
    return default


def build_scope(flow: dict[str, Any], with_bindings: dict[str, Any],
                parent_scope: dict[str, Any]) -> dict[str, Any]:
    """Build a flow's variable scope from its declared params and caller bindings."""
    scope: dict[str, Any] = {}
    for pname, spec in flow.get("params", {}).items():
        if pname in with_bindings:
            scope[pname] = resolve_binding(with_bindings[pname], parent_scope)
        elif "default" in spec:
            scope[pname] = spec["default"]
        elif spec.get("required"):
            raise ValueError(
                f"Required parameter {pname!r} of {flow.get('name', '<flow>')!r} "
                "was not provided."
            )
        else:
            scope[pname] = None
    return scope


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
    errors = sorted(validator.iter_errors(config), key=lambda e: list(map(str, e.path)))
    if errors:
        lines = ["Config failed schema validation:"]
        for err in errors:
            location = "/".join(str(p) for p in err.path) or "<root>"
            lines.append(f"  - at {location}: {err.message}")
        raise ValueError("\n".join(lines))


# --- Orchestration ------------------------------------------------------------

@dataclass
class RenderContext:
    """Mutable state shared across a traversal (including nested fragments)."""

    media_dir: Path | None = None
    pages: list[Image.Image] = field(default_factory=list)
    artifact_steps: list[dict[str, Any]] = field(default_factory=list)
    counter: int = 0
    visited: int = 0

    def guard(self) -> None:
        self.visited += 1
        if self.visited > MAX_NODES:
            raise RuntimeError(
                f"Traversal exceeded {MAX_NODES} nodes; the graph likely has a cycle."
            )


def load_flow(path: Path) -> tuple[dict[str, Any], Path]:
    """Load and validate a flow file, returning it with its base directory."""
    flow = json.loads(path.read_text(encoding="utf-8"))
    validate_config(flow)
    return flow, path.parent


def traverse(flow: dict[str, Any], scope: dict[str, Any], base_dir: Path,
             page: Page, ctx: RenderContext) -> None:
    """Walk a flow's graph, rendering step nodes and inlining fragment nodes."""
    graph = flow["graph"]
    nodes, node_id = graph["nodes"], graph["start"]

    while node_id is not None:
        if node_id not in nodes:
            raise ValueError(f"Edge points to unknown node id {node_id!r}.")
        node = nodes[node_id]
        ctx.guard()

        if "use" in node:
            child_path = (base_dir / node["use"]).resolve()
            child_flow, child_base = load_flow(child_path)
            child_scope = build_scope(child_flow, node.get("with", {}), scope)
            print(f"  -> entering fragment {node['use']}", flush=True)
            traverse(child_flow, child_scope, child_base, page, ctx)
        else:
            ctx.counter += 1
            n = ctx.counter
            print(f"  Step {n}: {node.get('description', '')}", flush=True)
            annotated = capture_step(page, node, n, scope)
            ctx.pages.append(annotated)
            rel_path: str | None = None
            if ctx.media_dir is not None:
                fname = f"step-{n}.png"
                annotated.save(ctx.media_dir / fname)
                rel_path = f"media/{fname}"
            ctx.artifact_steps.append({
                "step": n,
                "description": node.get("description", ""),
                "screenshot": rel_path,
            })
            perform_action(page, node, scope)

        node_id = choose_next(node.get("next"), page, scope)


def generate(config: dict[str, Any], config_path: Path,
             artifact_dir: Path | None = None) -> Path:
    output = Path(config.get("output", "tutorial.pdf"))
    viewport = config.get("viewport", {"width": 1280, "height": 800})
    headless = config.get("headless", True)
    base_dir = config_path.parent

    media_dir: Path | None = None
    if artifact_dir is not None:
        media_dir = artifact_dir / "media"
        media_dir.mkdir(parents=True, exist_ok=True)

    ctx = RenderContext(media_dir=media_dir)
    root_scope = build_scope(config, {}, {})

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(viewport=viewport, device_scale_factor=1)
        page = context.new_page()

        if config.get("start_url"):
            print(f"Navigating to {config['start_url']}", flush=True)
            page.goto(config["start_url"], wait_until="domcontentloaded")

        traverse(config, root_scope, base_dir, page, ctx)
        browser.close()

    if not ctx.pages:
        raise SystemExit("No steps produced any screenshots; nothing to write.")

    output.parent.mkdir(parents=True, exist_ok=True)
    ctx.pages[0].save(
        output,
        "PDF",
        save_all=True,
        append_images=ctx.pages[1:],
        resolution=100.0,
    )
    print(f"Wrote {len(ctx.pages)} page(s) to {output.resolve()}")

    if artifact_dir is not None:
        artifact = {
            "name": config.get("name", ""),
            "kind": "artifact",
            "source": config_path.name,
            "output": output.name,
            "generated_steps": ctx.artifact_steps,
        }
        artifact_path = artifact_dir / "tutorial.json"
        artifact_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
        print(f"Wrote portable artifact to {artifact_path.resolve()}")

    return output


def replay(artifact_dir: Path) -> Path:
    """Rebuild a PDF purely from a previously captured artifact (no browser)."""
    artifact_path = artifact_dir / "tutorial.json"
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))

    steps = artifact.get("generated_steps", [])
    pages: list[Image.Image] = []
    for step in steps:
        rel = step.get("screenshot")
        if not rel:
            print(f"  Skipping step {step.get('step')}: no screenshot stored.",
                  file=sys.stderr)
            continue
        pages.append(Image.open(artifact_dir / rel).convert("RGB"))

    if not pages:
        raise SystemExit("Artifact has no stored screenshots; nothing to replay.")

    output = artifact_dir / artifact.get("output", "tutorial.pdf")
    pages[0].save(
        output,
        "PDF",
        save_all=True,
        append_images=pages[1:],
        resolution=100.0,
    )
    print(f"Replayed {len(pages)} page(s) to {output.resolve()}")
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a screenshot tutorial PDF.")
    parser.add_argument("config", type=Path, nargs="?",
                        help="Path to the JSON tutorial/graph config.")
    parser.add_argument("--artifact", type=Path, metavar="DIR",
                        help="Also write a portable artifact (screenshots + JSON) "
                             "to this directory while rendering live.")
    parser.add_argument("--from-artifact", type=Path, metavar="DIR",
                        dest="from_artifact",
                        help="Rebuild the PDF from a stored artifact directory "
                             "without launching a browser.")
    args = parser.parse_args(argv)

    try:
        if args.from_artifact is not None:
            if not (args.from_artifact / "tutorial.json").exists():
                print(f"No artifact found in {args.from_artifact}", file=sys.stderr)
                return 1
            replay(args.from_artifact)
            return 0

        if args.config is None:
            parser.error("a config path is required unless --from-artifact is used")
        if not args.config.exists():
            print(f"Config not found: {args.config}", file=sys.stderr)
            return 1

        config = json.loads(args.config.read_text(encoding="utf-8"))
        validate_config(config)
        generate(config, args.config, artifact_dir=args.artifact)
    except Exception:
        import traceback

        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
