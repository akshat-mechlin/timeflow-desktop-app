# Build Instructions

This guide explains how to build the Time Tracker application for Windows and macOS.

## Prerequisites

1. **Node.js** (v16 or higher) and npm installed
2. **All dependencies** installed:
   ```bash
   npm install
   ```

## Building

### Build for Current Platform

Build for the platform you're currently on:
```bash
npm run build
```

### Build for Windows

Build Windows installer and portable version:
```bash
npm run build:win
```

This will create:
- `dist/Time Tracker Setup x.x.x.exe` - NSIS installer (x64 and ia32)
- `dist/Time Tracker x.x.x.exe` - Portable version (x64)

### Build for macOS

**⚠️ Important:** macOS builds can ONLY be created on a macOS machine (MacBook, iMac, etc.). You cannot build macOS applications on Windows or Linux.

**Prerequisites:**
1. Must be running on macOS
2. Xcode Command Line Tools installed: `xcode-select --install`
3. macOS icon file: `build/icon.icns` (see below)

**Prepare the icon:**
```bash
# First, create PNG icon if not exists
npm run convert-icon

# Then convert to .icns (macOS only)
chmod +x scripts/convert-icon-mac.sh
./scripts/convert-icon-mac.sh
```

**Build macOS DMG and ZIP:**
```bash
npm run build:mac
```

This will create:
- `release/Mechlin TimeFlow-1.2.0-x64.dmg` - DMG installer for Intel Macs
- `release/Mechlin TimeFlow-1.2.0-arm64.dmg` - DMG installer for Apple Silicon Macs
- `release/Mechlin TimeFlow-1.2.0-x64-mac.zip` - ZIP archive for Intel Macs
- `release/Mechlin TimeFlow-1.2.0-arm64-mac.zip` - ZIP archive for Apple Silicon Macs

**For detailed macOS build instructions, see [MACOS_BUILD_GUIDE.md](./MACOS_BUILD_GUIDE.md)**

### Build for All Platforms

Build for both Windows and macOS:
```bash
npm run build:all
```

**Note**: This requires running on macOS to build macOS versions.

## Build Output

All build artifacts will be in the `dist/` directory.

## Icons (Optional)

To add custom icons:

1. **Windows**: Place `icon.ico` in the `build/` directory
2. **macOS**: Place `icon.icns` in the `build/` directory

If icons are not provided, electron-builder will use default icons.

See `build/README.md` for detailed icon creation instructions.

## Environment Variables

The `.env` file is excluded from builds for security. Users will need to create their own `.env` file with:

```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Code Signing (macOS)

For distribution outside the Mac App Store, you may need to:
1. Get an Apple Developer certificate
2. Configure code signing in `package.json`

For development/testing, the current configuration should work without signing.

## Troubleshooting

### Windows Build Issues
- Ensure you have all dependencies installed
- Check that Node.js version is compatible
- Try cleaning and rebuilding: `rm -rf dist node_modules && npm install && npm run build:win`

### macOS Build Issues
- macOS builds must be done on macOS
- Ensure Xcode Command Line Tools are installed: `xcode-select --install`
- For code signing issues, see electron-builder documentation

## Distribution

After building:
1. Test the installer/application on the target platform
2. Distribute the files from the `dist/` directory
3. Users will need to configure their `.env` file with their Supabase credentials



