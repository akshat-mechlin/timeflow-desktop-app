#!/bin/bash
# Convert icon.png to icon.icns for macOS
# This script must be run on macOS

ICON_SOURCE="build/icon.png"
ICONSET_DIR="build/icon.iconset"
ICNS_OUTPUT="build/icon.icns"

# Check if on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ Error: This script can only be run on macOS"
    echo "iconutil is a macOS-only tool"
    exit 1
fi

# Check if source icon exists
if [ ! -f "$ICON_SOURCE" ]; then
    echo "❌ Error: $ICON_SOURCE not found"
    echo "Please run 'npm run convert-icon' first to create icon.png"
    exit 1
fi

echo "🖼️  Converting $ICON_SOURCE to $ICNS_OUTPUT..."

# Create iconset directory
mkdir -p "$ICONSET_DIR"

# Generate all required sizes for macOS icon
echo "Generating icon sizes..."
sips -z 16 16 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_16x16.png" > /dev/null 2>&1
sips -z 32 32 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_16x16@2x.png" > /dev/null 2>&1
sips -z 32 32 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_32x32.png" > /dev/null 2>&1
sips -z 64 64 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_32x32@2x.png" > /dev/null 2>&1
sips -z 128 128 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_128x128.png" > /dev/null 2>&1
sips -z 256 256 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_128x128@2x.png" > /dev/null 2>&1
sips -z 256 256 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_256x256.png" > /dev/null 2>&1
sips -z 512 512 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_256x256@2x.png" > /dev/null 2>&1
sips -z 512 512 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_512x512.png" > /dev/null 2>&1
sips -z 1024 1024 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_512x512@2x.png" > /dev/null 2>&1

# Convert to .icns
echo "Converting to .icns format..."
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_OUTPUT"

# Cleanup
rm -rf "$ICONSET_DIR"

if [ -f "$ICNS_OUTPUT" ]; then
    echo "✅ Successfully created $ICNS_OUTPUT"
    echo "You can now run 'npm run build:mac' to build for macOS"
else
    echo "❌ Error: Failed to create $ICNS_OUTPUT"
    exit 1
fi


