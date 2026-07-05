#Requires -Version 5.0
[CmdletBinding()]
param(
    [Parameter(Position=0)] [string]$Target = "claude",
    [switch]$Deps,
    [switch]$Mcp
)

$ErrorActionPreference = "Stop"

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "pathfinder-install-$([guid]::NewGuid().ToString().Substring(0,8))"
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    Write-Host "Downloading Pathfinder repository..." -ForegroundColor Cyan
    $ZipPath = Join-Path $TempDir "main.zip"
    Invoke-WebRequest -Uri "https://github.com/fizy069/pathfinder/archive/refs/heads/main.zip" -OutFile $ZipPath
    Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force
    
    $RepoDir = Join-Path $TempDir "pathfinder-main"
    $InstallScript = Join-Path $RepoDir "install.ps1"
    
    Write-Host "Running installation..." -ForegroundColor Cyan
    $argsArray = @($Target)
    if ($Deps) { $argsArray += "-Deps" }
    if ($Mcp) { $argsArray += "-Mcp" }
    
    & $InstallScript @argsArray
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force
    }
}
