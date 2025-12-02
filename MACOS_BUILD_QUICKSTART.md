# macOS Build Quick Start

## ⚠️ Important
**You MUST be on a macOS machine to build for macOS.** This cannot be done on Windows or Linux.

## Quick Steps

### 1. Prerequisites
```bash
# Install Xcode Command Line Tools (if not already installed)
xcode-select --install

# Install dependencies
npm install
```

### 2. Prepare Icon
```bash
# Create PNG icon
npm run convert-icon

# Convert to .icns (macOS only)
chmod +x scripts/convert-icon-mac.sh
./scripts/convert-icon-mac.sh
```

### 3. Build
```bash
npm run build:mac
```

### 4. Output
Check the `release/` directory for:
- `Mechlin TimeFlow-1.2.0-x64.dmg` (Intel Macs)
- `Mechlin TimeFlow-1.2.0-arm64.dmg` (Apple Silicon Macs)
- `Mechlin TimeFlow-1.2.0-x64-mac.zip` (Intel Macs)
- `Mechlin TimeFlow-1.2.0-arm64-mac.zip` (Apple Silicon Macs)

## Troubleshooting

**"Cannot build macOS on Windows"** → You need a Mac

**"Icon not found"** → Run the icon conversion script first

**"App won't open"** → Remove quarantine: `xattr -cr "/path/to/Mechlin TimeFlow.app"`

## Full Documentation
See [MACOS_BUILD_GUIDE.md](./MACOS_BUILD_GUIDE.md) for detailed instructions.


