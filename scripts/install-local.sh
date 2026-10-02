#!/bin/bash
# Builds this fork's Release app, signed with a local code-signing certificate, and installs it as
# /Applications/Netnyahoo.app for the owner's daily use (AGENTS.md).
#
#   scripts/install-local.sh [--install-only]
#
# - Signs with the self-signed certificate NN_SIGNING_IDENTITY (default "Netnyahoo Local", made in Keychain Access ›
#   Certificate Assistant › Create a Certificate…, type Code Signing). A certificate-signed build uses the login
#   keychain, so the installed profile's cookies and passwords stay readable; macOS asks once to allow it.
# - Drops SUFeedURL, so the official updater never replaces the fork's build.
# - Never quits the running app: it stops while /Applications/Netnyahoo.app is running.
# - Keeps the replaced copy as /Applications/Netnyahoo-<version>-<build>.app.bak.
# - NNCORE_FRAMEWORK: the engine framework when this Mac has no Chromium build (a copy out of an official release
#   whose engine matches main).
# --install-only installs the last build without rebuilding.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
identity="${NN_SIGNING_IDENTITY:-Netnyahoo Local}"
derived="$root/apps/browser/build-local"
built="$derived/Build/Products/Release/Netnyahoo.app"
dest=/Applications/Netnyahoo.app
die() { echo "error: $*" >&2; exit 1; }

security find-identity -p codesigning | grep -q "\"$identity\"" ||
  die "no code-signing identity \"$identity\" in the keychain (see the top of this script)"

if [ "${1:-}" != --install-only ]; then
  echo "==> Build (Release, signed by \"$identity\")"
  (cd "$root/apps/browser" && "$root/scripts/agent/locked" xcodebuild --wait 1500 -- xcodebuild \
    -workspace macos/Netnyahoo.xcworkspace -scheme Netnyahoo-macOS -derivedDataPath "$derived" \
    -destination 'platform=macOS,arch=arm64' -configuration Release -xcconfig macos/LocalSigning.xcconfig \
    NN_SIGNING_IDENTITY="$identity" build >"$derived.log" 2>&1) ||
    { grep -E "error:" "$derived.log" | head -20 >&2; die "build failed (log: $derived.log)"; }
fi
[ -d "$built" ] || die "no build at $built"

echo "==> Stage"
stage=$(mktemp -d)/Netnyahoo.app
ditto "$built" "$stage"
/usr/libexec/PlistBuddy -c "Delete :SUFeedURL" "$stage/Contents/Info.plist" 2>/dev/null || true
codesign --force --sign "$identity" "$stage"
codesign --verify --deep --strict "$stage"
signature=$(codesign -dvv "$stage" 2>&1)
grep -qx "Authority=$identity" <<<"$signature" || die "the staged app isn't signed by \"$identity\""

if pgrep -f "^$dest/Contents/MacOS/Netnyahoo" >/dev/null; then
  die "Netnyahoo is running: quit it (⌘Q), then run: scripts/install-local.sh --install-only"
fi

if [ -d "$dest" ]; then
  plist="$dest/Contents/Info.plist"
  version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist" 2>/dev/null || echo old)
  build=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$plist" 2>/dev/null || echo 0)
  backup="/Applications/Netnyahoo-$version-$build.app.bak"
  [ -e "$backup" ] && backup="/Applications/Netnyahoo-$version-$build-$(date +%Y%m%d%H%M%S).app.bak"
  echo "==> Keep the current app as $backup"
  mv "$dest" "$backup"
fi
echo "==> Install $dest"
ditto "$stage" "$dest"
rm -rf "$(dirname "$stage")"
echo "Installed. The first launch asks to allow \"Netnyahoo Safe Storage\": enter your password and choose Always Allow."
