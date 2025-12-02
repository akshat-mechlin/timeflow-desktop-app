# macOS Build Guide

This guide explains how to build Mechlin TimeFlow for macOS.

## Important Notes

⚠️ **macOS builds can ONLY be created on a macOS machine** (MacBook, iMac, Mac Mini, etc.). You cannot build macOS applications on Windows or Linux due to code signing and platform-specific requirements.

## Prerequisites

### 1. macOS System Requirements
- macOS 10.13 (High Sierra) or later
- Xcode Command Line Tools installed
- Node.js (v16 or higher) and npm

### 2. Install Xcode Command Line Tools

If not already installed, run:
```bash
xcode-select --install
```

### 3. Install Dependencies

```bash
npm install
```

## Preparing the macOS Icon

Before building, you need to create a `.icns` icon file from your existing icon.

### Option 1: Using iconutil (Recommended - macOS only)

1. **Create an iconset directory:**
   ```bash
   mkdir -p build/icon.iconset
   ```

2. **Convert your PNG icon to multiple sizes:**
   
   If you have `build/icon.png` (or `assets/icon.svg`), you can use `sips` (built into macOS) or ImageMagick:
   
   ```bash
   # Using sips (built into macOS)
   cd build
   sips -z 16 16 icon.png --out icon.iconset/icon_16x16.png
   sips -z 32 32 icon.png --out icon.iconset/icon_16x16@2x.png
   sips -z 32 32 icon.png --out icon.iconset/icon_32x32.png
   sips -z 64 64 icon.png --out icon.iconset/icon_32x32@2x.png
   sips -z 128 128 icon.png --out icon.iconset/icon_128x128.png
   sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png
   sips -z 256 256 icon.png --out icon.iconset/icon_256x256.png
   sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png
   sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png
   sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
   ```

3. **Convert iconset to .icns:**
   ```bash
   iconutil -c icns icon.iconset
   ```

4. **Move the icon to the build directory:**
   ```bash
   mv icon.icns build/icon.icns
   rm -rf icon.iconset
   ```

### Option 2: Using Online Converter

1. Use an online tool like:
   - [CloudConvert](https://cloudconvert.com/png-to-icns)
   - [IconConverter](https://iconverticons.com/)
   - [Image2icon](https://www.img2icnsapp.com/) (macOS app)

2. Convert your `build/icon.png` to `build/icon.icns`

### Option 3: Using a Script

Create a script to automate the conversion:

```bash
#!/bin/bash
# convert-to-icns.sh

ICON_SOURCE="build/icon.png"
ICONSET_DIR="build/icon.iconset"
ICNS_OUTPUT="build/icon.icns"

# Create iconset directory
mkdir -p "$ICONSET_DIR"

# Generate all required sizes
sips -z 16 16 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_16x16.png"
sips -z 32 32 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_16x16@2x.png"
sips -z 32 32 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_32x32.png"
sips -z 64 64 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_32x32@2x.png"
sips -z 128 128 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_128x128.png"
sips -z 256 256 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_128x128@2x.png"
sips -z 256 256 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_256x256.png"
sips -z 512 512 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_256x256@2x.png"
sips -z 512 512 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_512x512.png"
sips -z 1024 1024 "$ICON_SOURCE" --out "${ICONSET_DIR}/icon_512x512@2x.png"

# Convert to .icns
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_OUTPUT"

# Cleanup
rm -rf "$ICONSET_DIR"

echo "✅ Icon created: $ICNS_OUTPUT"
```

Make it executable and run:
```bash
chmod +x convert-to-icns.sh
./convert-to-icns.sh
```

## Building for macOS

### Build DMG and ZIP

```bash
npm run build:mac
```

This will create:
- `release/Mechlin TimeFlow-1.2.0-x64.dmg` - DMG installer for Intel Macs
- `release/Mechlin TimeFlow-1.2.0-arm64.dmg` - DMG installer for Apple Silicon Macs
- `release/Mechlin TimeFlow-1.2.0-x64-mac.zip` - ZIP archive for Intel Macs
- `release/Mechlin TimeFlow-1.2.0-arm64-mac.zip` - ZIP archive for Apple Silicon Macs

### Build for Specific Architecture

**Intel Macs (x64) only:**
```bash
npx electron-builder --mac --x64
```

**Apple Silicon Macs (arm64) only:**
```bash
npx electron-builder --mac --arm64
```

**Universal Binary (both architectures):**
```bash
npx electron-builder --mac --x64 --arm64
```

## Build Output

All build artifacts will be in the `release/` directory:

- **DMG files**: Disk image installers (recommended for distribution)
- **ZIP files**: Compressed archives (alternative distribution method)

## Code Signing (Optional but Recommended)

### For Development/Testing

The current configuration works without code signing, but macOS will show a warning when users try to open the app.

### For Distribution

To distribute outside the Mac App Store without warnings:

1. **Get an Apple Developer Certificate:**
   - Sign up for [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
   - Create a Developer ID Application certificate in Xcode or Keychain Access

2. **Configure Code Signing in package.json:**

   Add to the `mac` section:
   ```json
   "mac": {
     "identity": "Developer ID Application: Your Name (TEAM_ID)",
     "hardenedRuntime": true,
     "gatekeeperAssess": false
   }
   ```

3. **Build with signing:**
   ```bash
   npm run build:mac
   ```

### Notarization (Required for Distribution)

For macOS 10.15+ (Catalina and later), you need to notarize your app:

1. **Configure notarization in package.json:**
   ```json
   "mac": {
     "notarize": {
       "teamId": "YOUR_TEAM_ID"
     }
   }
   ```

2. **Set environment variables:**
   ```bash
   export APPLE_ID="your@email.com"
   export APPLE_APP_SPECIFIC_PASSWORD="your-app-specific-password"
   ```

3. **Build and notarize:**
   ```bash
   npm run build:mac
   ```

## Testing the Build

### Test DMG Installation

1. Double-click the `.dmg` file
2. Drag the app to Applications folder
3. Open the app from Applications
4. If you see a security warning:
   - Go to System Preferences → Security & Privacy
   - Click "Open Anyway"

### Test ZIP Installation

1. Extract the `.zip` file
2. Move the app to Applications folder
3. Open the app
4. Handle security warnings as above

## Troubleshooting

### Issue: "Cannot build macOS on Windows/Linux"

**Solution:** macOS builds can only be created on macOS. Use a Mac or macOS virtual machine.

### Issue: "Xcode Command Line Tools not found"

**Solution:**
```bash
xcode-select --install
```

### Issue: "Icon not found" or "Invalid icon"

**Solution:**
- Ensure `build/icon.icns` exists
- Verify the icon file is valid: `file build/icon.icns`
- Recreate the icon using the steps above

### Issue: "Code signing failed"

**Solution:**
- For development, you can skip signing (current config)
- For distribution, ensure you have a valid Developer ID certificate
- Check certificate in Keychain Access

### Issue: "App won't open" or "App is damaged"

**Solution:**
1. Remove quarantine attribute:
   ```bash
   xattr -cr "/path/to/Mechlin TimeFlow.app"
   ```
2. Or allow in System Preferences → Security & Privacy

### Issue: "Hardened Runtime errors"

**Solution:**
- The `entitlements.mac.plist` file is already configured
- If you add new features, you may need to update entitlements
- See [Apple's documentation](https://developer.apple.com/documentation/security/hardened_runtime) for required entitlements

## Distribution

### DMG Distribution

1. **Test the DMG** on a clean macOS system
2. **Upload to your distribution platform:**
   - Your website
   - Cloud storage (OneDrive, Google Drive, Dropbox)
   - GitHub Releases
3. **Provide download link** to users

### ZIP Distribution

1. **Test the ZIP** extraction and app launch
2. **Upload** to distribution platform
3. **Provide instructions** for users to extract and install

## Build Scripts

You can create a build script for convenience:

```bash
#!/bin/bash
# build-mac.sh

echo "🔨 Building Mechlin TimeFlow for macOS..."

# Check if on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ Error: macOS builds can only be created on macOS"
    exit 1
fi

# Check if icon exists
if [ ! -f "build/icon.icns" ]; then
    echo "⚠️  Warning: build/icon.icns not found"
    echo "Creating icon from build/icon.png..."
    # Run icon conversion script here
fi

# Build
npm run build:mac

echo "✅ Build complete! Check the release/ directory"
```

Make it executable:
```bash
chmod +x build-mac.sh
./build-mac.sh
```

## Next Steps

After building:
1. Test the application on macOS
2. Test on both Intel and Apple Silicon Macs (if building universal)
3. Distribute via your preferred method
4. Update documentation with download links

---

**Note:** The application code is platform-agnostic, but the build process and distribution require macOS-specific tools and certificates.

