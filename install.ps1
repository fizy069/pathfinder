<#
.SYNOPSIS
  Install the tutorial-generator Agent Skill into a host tool's skills directory.

.DESCRIPTION
  Copies .claude/skills/tutorial-generator into the chosen skills location so
  Claude Code, Cursor, or any Agent Skills-compatible tool can discover it.

.PARAMETER Target
  claude   -> ~/.claude/skills   (read by Claude Code AND Cursor)
  cursor   -> ~/.cursor/skills
  agents   -> ~/.agents/skills   (vendor-neutral standard)
  project  -> ./.claude/skills   (current project, read by both)

.PARAMETER Deps
  Also run `npm install` + `npx playwright install chromium` in the installed folder.

.PARAMETER Mcp
  Also configure a Playwright MCP server for the chosen tool (Cursor mcp.json,
  Claude Code CLI, or project-level mcp files).

.EXAMPLE
  ./install.ps1 claude -Deps -Mcp
#>
param(
  [ValidateSet('claude', 'cursor', 'agents', 'project')]
  [string]$Target = 'claude',
  [switch]$Deps,
  [switch]$Mcp
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$Src = Join-Path $ScriptDir '.claude/skills/tutorial-generator'
$SkillName = 'tutorial-generator'

# Merge a `playwright` entry into the `mcpServers` map of a JSON config file,
# preserving any existing servers. Idempotent.
function Set-PlaywrightMcp([string]$File) {
  $servers = @{}
  if (Test-Path $File) {
    try {
      $existing = Get-Content $File -Raw | ConvertFrom-Json
      if ($existing -and ($existing.PSObject.Properties.Name -contains 'mcpServers') -and $existing.mcpServers) {
        foreach ($p in $existing.mcpServers.PSObject.Properties) { $servers[$p.Name] = $p.Value }
      }
    } catch {
      Write-Warning "Could not parse existing $File; leaving it untouched."
      return
    }
  }
  $servers['playwright'] = @{ command = 'npx'; args = @('@playwright/mcp@latest') }
  $dir = Split-Path -Parent $File
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  @{ mcpServers = $servers } | ConvertTo-Json -Depth 12 | Set-Content -Path $File -Encoding UTF8
  Write-Host "Configured Playwright MCP in $File"
}

switch ($Target) {
  'claude'  { $DestRoot = Join-Path $HOME '.claude/skills' }
  'cursor'  { $DestRoot = Join-Path $HOME '.cursor/skills' }
  'agents'  { $DestRoot = Join-Path $HOME '.agents/skills' }
  'project' { $DestRoot = Join-Path (Get-Location) '.claude/skills' }
}

$Dest = Join-Path $DestRoot $SkillName
Write-Host "Installing $SkillName -> $Dest"
New-Item -ItemType Directory -Force -Path $DestRoot | Out-Null
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
Copy-Item -Recurse $Src $Dest
# Don't carry stale dependency tree or generated output into the install.
foreach ($junk in 'node_modules', 'test-results') {
  $p = Join-Path $Dest $junk
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
Get-ChildItem -Recurse $Dest -Filter *.pdf | Remove-Item -Force -ErrorAction SilentlyContinue

if ($Deps) {
  Write-Host 'Installing generator dependencies...'
  Push-Location $Dest
  try {
    npm install
    npx playwright install chromium
  } finally {
    Pop-Location
  }
} else {
  Write-Host "Next: cd `"$Dest`"; npm install; npx playwright install chromium"
}

if ($Mcp) {
  Write-Host 'Configuring Playwright MCP server...'
  switch ($Target) {
    'claude' {
      if (Get-Command claude -ErrorAction SilentlyContinue) {
        claude mcp add playwright -- npx '@playwright/mcp@latest'
      } else {
        Write-Warning 'Claude CLI not found. Add manually: claude mcp add playwright -- npx @playwright/mcp@latest'
      }
    }
    'cursor'  { Set-PlaywrightMcp (Join-Path $HOME '.cursor/mcp.json') }
    'agents'  { Write-Warning "No standard MCP config location for 'agents'; configure your tool manually." }
    'project' {
      # Cover both tools at the project level.
      Set-PlaywrightMcp (Join-Path (Get-Location) '.mcp.json')        # Claude Code
      Set-PlaywrightMcp (Join-Path (Get-Location) '.cursor/mcp.json') # Cursor
    }
  }
} else {
  Write-Host 'Tip: add -Mcp to auto-configure the Playwright MCP server.'
}
Write-Host 'Done.'
