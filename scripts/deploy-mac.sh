#!/usr/bin/env bash
# Builds the macOS dmg: lint, test, build, package, then print checksums.
# Run on macOS:  npm run deploy:mac            (or: bash scripts/deploy-mac.sh)
# Flags: --release     also upload the dmg to a GitHub draft release (needs `gh`, logged in)
#        --skip-checks skip lint and tests
#        --clean       remove dist/ and out/ first
set -euo pipefail

release=0 skip_checks=0 clean=0
for arg in "$@"; do
  case "$arg" in
    --release) release=1 ;;
    --skip-checks) skip_checks=1 ;;
    --clean) clean=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

[ "$(uname -s)" = "Darwin" ] || { echo "Run this on macOS; use deploy-win.ps1 on Windows." >&2; exit 1; }

step() { printf '\n==> %s\n' "$1"; }

version=$(node -p "require('./package.json').version")
echo "EnvVault $version for macOS ($(uname -m))"

if [ "$release" = 1 ]; then
  [ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean; commit or stash before releasing." >&2; exit 1; }
  command -v gh >/dev/null || { echo "gh is required for --release." >&2; exit 1; }
fi

[ "$clean" = 0 ] || rm -rf dist out

step "Install dependencies"
npm ci
if [ "$skip_checks" = 0 ]; then
  step "Lint"; npm run lint
  step "Test"; npm test
fi
# build:mac runs typecheck, the app build and the CLI build, then electron-builder --mac.
step "Build and package"
npm run build:mac

dmg="dist/envvault-$version.dmg"
[ -f "$dmg" ] || { echo "Expected $dmg was not produced." >&2; exit 1; }

(cd dist && shasum -a 256 "envvault-$version.dmg" > "envvault-$version.dmg.sha256")
echo
echo "Disk image: $dmg"
echo "SHA-256:    $(cut -d' ' -f1 "$dmg.sha256")"
echo "Unsigned, not notarized: Gatekeeper will block first launch (right-click > Open)."

if [ "$release" = 1 ]; then
  tag="v$version"
  step "Upload to GitHub release $tag"
  gh release view "$tag" >/dev/null 2>&1 || gh release create "$tag" --title "$tag" --notes-file docs/release-notes.md --draft
  gh release upload "$tag" "$dmg" "$dmg.sha256" --clobber
fi
