const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Use the timeflowicon.svg for app / taskbar / installer icon
const svgPath = path.join(__dirname, '..', 'assets', 'timeflowicon.svg');
const buildDir = path.join(__dirname, '..', 'build');
const iconPngPath = path.join(buildDir, 'icon.png');
const icon256Path = path.join(buildDir, 'icon-256.png');
const iconIcoPath = path.join(buildDir, 'icon.ico');

if (!fs.existsSync(svgPath)) {
  console.error('Missing SVG:', svgPath);
  process.exit(1);
}

if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

async function renderPng(size, outPath) {
  await sharp(svgPath)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outPath);
}

async function convertIcon() {
  try {
    const pngToIco = (await import('png-to-ico')).default;
    console.log('Converting', svgPath);

    await renderPng(256, icon256Path);
    await renderPng(512, iconPngPath);

    // Multi-resolution ICO for Windows installer / exe
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const tempPngs = [];
    for (const size of icoSizes) {
      const tmp = path.join(buildDir, `icon-tmp-${size}.png`);
      await renderPng(size, tmp);
      tempPngs.push(tmp);
    }

    const icoBuffer = await pngToIco(tempPngs);
    fs.writeFileSync(iconIcoPath, icoBuffer);

    for (const tmp of tempPngs) {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {
        /* ignore */
      }
    }

    console.log('Wrote', icon256Path);
    console.log('Wrote', iconPngPath);
    console.log('Wrote', iconIcoPath);

    // Also ship copies under assets/ (packaged; build/ is excluded from asar)
    const assetsDir = path.join(__dirname, '..', 'assets');
    fs.copyFileSync(icon256Path, path.join(assetsDir, 'icon-256.png'));
    fs.copyFileSync(iconIcoPath, path.join(assetsDir, 'icon.ico'));
    console.log('Copied icon-256.png and icon.ico to assets/');
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

convertIcon();
