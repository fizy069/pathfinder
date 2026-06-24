#!/usr/bin/env bash
# Install the tutorial-generator Agent Skill into a host tool's skills directory.
#
# Usage:
#   ./install.sh [target] [--deps]
#
# target (default: claude):
#   claude   -> ~/.claude/skills        (read by Claude Code AND Cursor)
#   cursor   -> ~/.cursor/skills
#   agents   -> ~/.agents/skills        (vendor-neutral standard)
#   project  -> ./.claude/skills        (current project, read by both)
#
#   --deps   also run `npm install` + `npx playwright install chromium`
#            in the installed skill folder.
#   --mcp    also configure a Playwright MCP server for the chosen tool
#            (Cursor mcp.json, Claude Code CLI, or project-level mcp files).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/.claude/skills/tutorial-generator"
SKILL_NAME="tutorial-generator"

# Merge a `playwright` entry into the `mcpServers` map of a JSON config file,
# preserving any existing servers. Idempotent. Uses node (already a dependency).
set_playwright_mcp() {
  local file="$1"
  mkdir -p "$(dirname "$file")"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    let json = {};
    if (fs.existsSync(file)) {
      try { json = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { console.error("Could not parse " + file + "; leaving it untouched."); process.exit(0); }
    }
    json.mcpServers = json.mcpServers || {};
    json.mcpServers.playwright = { command: "npx", args: ["@playwright/mcp@latest"] };
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log("Configured Playwright MCP in " + file);
  ' "$file"
}

TARGET="claude"
DEPS=0
MCP=0
for arg in "$@"; do
  case "$arg" in
    claude|cursor|agents|project) TARGET="$arg" ;;
    --deps) DEPS=1 ;;
    --mcp) MCP=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

case "$TARGET" in
  claude)  DEST_ROOT="$HOME/.claude/skills" ;;
  cursor)  DEST_ROOT="$HOME/.cursor/skills" ;;
  agents)  DEST_ROOT="$HOME/.agents/skills" ;;
  project) DEST_ROOT="$(pwd)/.claude/skills" ;;
esac

DEST="$DEST_ROOT/$SKILL_NAME"
echo "Installing $SKILL_NAME -> $DEST"
mkdir -p "$DEST_ROOT"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
# Don't carry stale dependency tree or generated output into the install.
rm -rf "$DEST/node_modules" "$DEST/test-results"
find "$DEST" -name '*.pdf' -delete 2>/dev/null || true

if [ "$DEPS" -eq 1 ]; then
  echo "Installing generator dependencies..."
  ( cd "$DEST" && npm install && npx playwright install chromium )
else
  echo "Next: cd \"$DEST\" && npm install && npx playwright install chromium"
fi

if [ "$MCP" -eq 1 ]; then
  echo "Configuring Playwright MCP server..."
  case "$TARGET" in
    claude)
      if command -v claude >/dev/null 2>&1; then
        claude mcp add playwright -- npx @playwright/mcp@latest
      else
        echo "Claude CLI not found. Add manually: claude mcp add playwright -- npx @playwright/mcp@latest" >&2
      fi
      ;;
    cursor)  set_playwright_mcp "$HOME/.cursor/mcp.json" ;;
    agents)  echo "No standard MCP config location for 'agents'; configure your tool manually." >&2 ;;
    project) # Cover both tools at the project level.
      set_playwright_mcp "$(pwd)/.mcp.json"        # Claude Code
      set_playwright_mcp "$(pwd)/.cursor/mcp.json" # Cursor
      ;;
  esac
else
  echo "Tip: add --mcp to auto-configure the Playwright MCP server."
fi
echo "Done."
