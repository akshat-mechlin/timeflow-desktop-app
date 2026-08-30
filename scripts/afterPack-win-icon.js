/**
 * electron-builder afterPack — embed TimeFlow icon into Windows .exe.
 * Needed because win.signAndEditExecutable must stay false on machines
 * without symlink privilege (winCodeSign extract fails on Darwin dylibs).
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const projectDir = context.packager.projectDir
  const productName = context.packager.appInfo.productFilename || 'TimeFlow'
  const exePath = path.join(context.appOutDir, `${productName}.exe`)
  const iconPath = path.join(projectDir, 'build', 'icon.ico')

  if (!fs.existsSync(exePath)) {
    console.warn('[afterPack-win-icon] exe not found:', exePath)
    return
  }
  if (!fs.existsSync(iconPath)) {
    console.warn('[afterPack-win-icon] icon not found:', iconPath)
    return
  }

  const isIa32 = String(context.arch) === '0' || context.arch === 0 || /ia32/i.test(String(context.appOutDir))
  const rceditName = isIa32 ? 'rcedit-ia32.exe' : 'rcedit-x64.exe'
  const rceditPath = path.join(projectDir, 'scripts', 'win-tools', rceditName)
  const rceditFallback = path.join(projectDir, 'scripts', 'win-tools', 'rcedit-x64.exe')
  const tool = fs.existsSync(rceditPath) ? rceditPath : rceditFallback

  if (!fs.existsSync(tool)) {
    console.warn('[afterPack-win-icon] rcedit missing at', tool)
    return
  }

  console.log('[afterPack-win-icon] embedding icon into', exePath)
  execFileSync(tool, [exePath, '--set-icon', iconPath], { stdio: 'inherit' })
}
