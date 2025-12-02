const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Use the icon.svg for taskbar icon (square format, better for icons)
const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
const buildDir = path.join(__dirname, '..', 'build');
const iconPngPath = path.join(buildDir, 'icon.png');
const icon256Path = path.join(buildDir, 'icon-256.png');

// Ensure build directory exists
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

async function convertIcon() {
  try {
    console.log('Converting SVG to PNG icons...');
    
    // Create 256x256 PNG (good for Windows taskbar)
    await sharp(svgPath)
      .resize(256, 256, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 } // Transparent background
      })
      .png()
      .toFile(icon256Path);
    
    console.log(`✓ Created ${icon256Path}`);
    
    // Also create a standard icon.png
    await sharp(svgPath)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(iconPngPath);
    
    console.log(`✓ Created ${iconPngPath}`);
    console.log('\nNote: For Windows .ico file, you may need to use an online converter');
    console.log('or install a tool like ImageMagick. The PNG will work for development.');
    
  } catch (error) {
    console.error('Error converting icon:', error);
    process.exit(1);
  }
}

convertIcon();
