# Builds the Windows installer: lint, test, build, package, then print checksums.
# Run on Windows:  npm run deploy:win            (or: pwsh scripts/deploy-win.ps1)
# Add -Release to also upload the installer to a GitHub release (needs `gh`, logged in).
param(
  [switch]$Release,
  [switch]$SkipChecks,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($name, [scriptblock]$body) {
  Write-Host "`n==> $name" -ForegroundColor Cyan
  & $body
  if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)" }
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'Run this on Windows; use deploy-mac.sh on macOS.' }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "EnvVault $version for Windows"

if ($Release) {
  if (git status --porcelain) { throw 'Working tree is not clean; commit or stash before releasing.' }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh is required for -Release.' }
}

if ($Clean) {
  Remove-Item -Recurse -Force dist, out -ErrorAction SilentlyContinue
}

# Mirrors CI. --ignore-scripts is not used here: postinstall fetches the Electron binary.
Step 'Install dependencies' { npm ci }
if (-not $SkipChecks) {
  Step 'Lint' { npm run lint }
  Step 'Test' { npm test }
}
# build:win runs typecheck, the app build and the CLI build, then electron-builder --win.
Step 'Build and package' { npm run build:win }

$installer = Join-Path dist "envvault-$version-setup.exe"
if (-not (Test-Path $installer)) { throw "Expected $installer was not produced." }

$hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $installer -Leaf)" | Set-Content -Encoding ascii "$installer.sha256"
Write-Host "`nInstaller: $installer"
Write-Host "SHA-256:   $hash"
Write-Host 'Unsigned build: Windows SmartScreen will warn on first run.'

if ($Release) {
  $tag = "v$version"
  Step "Upload to GitHub release $tag" {
    gh release view $tag *> $null
    if ($LASTEXITCODE -ne 0) { gh release create $tag --title $tag --notes "EnvVault $version" --draft }
    gh release upload $tag $installer "$installer.sha256" --clobber
  }
}
