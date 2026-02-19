#!/bin/bash
# Sovereign Tax — Finish macOS build (sign, DMG, notarize)
# Run this in Terminal: bash finish-build.sh
set -e

SIGN_ID="Developer ID Application: Joshua Himmelspach (4K84Q4TST4)"
PROFILE="SovereignTax"
APP_NAME="Sovereign Tax"
DMG_NAME="SovereignTax-macOS.dmg"
CLEAN_APP="/tmp/clean-app/$APP_NAME.app"
OUTPUT_DIR="/Users/joshuahimmelspach/Desktop/Sovereign Tax Final/cloudflare-package/downloads"
BUILDS_DIR="/Users/joshuahimmelspach/Desktop/Sovereign Tax Final/builds"

echo ""
echo "================================================"
echo "  Sovereign Tax — Finish Build (Sign + Notarize)"
echo "================================================"
echo ""

# Verify the clean signed .app exists
if [ ! -d "$CLEAN_APP" ]; then
    echo "[ERROR] Signed .app not found at $CLEAN_APP"
    exit 1
fi
echo "[✓] Signed .app found"

# Verify signature
codesign --verify --deep --strict "$CLEAN_APP"
echo "[✓] Signature valid"
echo ""

# Create DMG
echo "[1/3] Creating DMG..."
STAGING=/tmp/dmg-staging
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$CLEAN_APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
rm -f /tmp/$DMG_NAME
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -ov -format UDZO /tmp/$DMG_NAME
rm -rf "$STAGING"
echo "  ✓ DMG created"
echo ""

# Notarize
echo "[2/3] Submitting to Apple for notarization..."
xcrun notarytool submit /tmp/$DMG_NAME --keychain-profile "$PROFILE" --wait
echo ""

# Staple
echo "[3/3] Stapling notarization ticket..."
xcrun stapler staple /tmp/$DMG_NAME
echo "  ✓ Stapled"
echo ""

# Copy to output
echo "Copying to output folders..."
cp /tmp/$DMG_NAME "$OUTPUT_DIR/$DMG_NAME"
echo "  → $OUTPUT_DIR/$DMG_NAME"

VERSION=$(date +%Y-%m-%d_%H%M)
mkdir -p "$BUILDS_DIR/$VERSION"
cp /tmp/$DMG_NAME "$BUILDS_DIR/$VERSION/$DMG_NAME"
echo "  → $BUILDS_DIR/$VERSION/$DMG_NAME"

echo ""
echo "================================================"
echo "  ✓ Done! Signed & notarized DMG ready."
echo "  Deploy cloudflare-package to go live."
echo "================================================"
