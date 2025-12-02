# Build Assets

This directory contains build assets for the Electron application.

## Required Files

### Icons

You need to add icon files for the application:

1. **Windows Icon**: `icon.ico`
   - Size: 256x256 pixels (or multiple sizes: 16x16, 32x32, 48x48, 256x256)
   - Format: ICO
   - Place it at: `build/icon.ico`

2. **macOS Icon**: `icon.icns`
   - Size: 512x512 pixels (or 1024x1024)
   - Format: ICNS
   - Place it at: `build/icon.icns`

### Creating Icons

#### Windows (.ico)
- Use an online converter or tool like ImageMagick
- Start with a 256x256 PNG image
- Convert to ICO format with multiple sizes

#### macOS (.icns)
- Use `iconutil` command on macOS:
  ```bash
  # Create iconset directory
  mkdir icon.iconset
  
  # Add PNG files at different sizes
  # icon_16x16.png, icon_16x16@2x.png, icon_32x32.png, etc.
  
  # Convert to ICNS
  iconutil -c icns icon.iconset
  ```

Or use an online converter or tool like Image2icon.

## Optional: Custom Icons

If you don't have custom icons, electron-builder will use default icons. However, it's recommended to create custom icons for a professional look.



