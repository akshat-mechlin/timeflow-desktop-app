/**
 * Preload bridge — contextIsolation: true, nodeIntegration: false (H-02).
 * Node APIs stay in this privileged script; renderer uses window.timeflow only.
 */
const { contextBridge, ipcRenderer } = require('electron')
const { shell } = require('electron')
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const screenshot = require('screenshot-desktop')

require('dotenv').config({ path: path.join(__dirname, '.env') })
// Also try process.cwd() for npm run from project root
require('dotenv').config({ path: path.join(process.cwd(), '.env') })

const DEFAULT_CONFIG_URL = 'https://timeflow.mechlintech.com/desktop-config.json'

function envConfig() {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const supabasePublishableKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim()
  if (supabaseUrl && supabasePublishableKey) {
    return { supabaseUrl, supabasePublishableKey, source: 'env' }
  }
  return null
}

async function fetchRemoteConfig() {
  const configUrl =
    process.env.DESKTOP_CONFIG_URL ||
    process.env.VITE_DESKTOP_CONFIG_URL ||
    DEFAULT_CONFIG_URL

  const controller = new AbortController()
  const timeoutMs = 12000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(configUrl, { cache: 'no-store', signal: controller.signal })
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))
    throw new Error(
      aborted
        ? `Desktop config timed out after ${timeoutMs}ms from ${configUrl}`
        : `Desktop config fetch failed from ${configUrl}: ${err.message || err}`
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`Desktop config HTTP ${res.status} from ${configUrl}`)
  }
  const data = await res.json()
  const supabaseUrl = data.supabaseUrl || data.url || ''
  const supabasePublishableKey =
    data.supabasePublishableKey || data.supabaseAnonKey || data.anonKey || ''
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('Desktop config JSON missing supabaseUrl / supabasePublishableKey')
  }
  return { supabaseUrl, supabasePublishableKey, source: 'remote', configUrl }
}

/**
 * Local dev: use .env if present.
 * Packaged / no env: fetch publishable config from the web host (not embedded in the .exe).
 */
async function getSupabaseConfig() {
  try {
    const fromEnv = envConfig()
    // Prefer remote when explicitly requested, or when no local env (typical packaged app)
    const forceRemote = String(process.env.DESKTOP_CONFIG_FORCE_REMOTE || '').toLowerCase() === 'true'
    if (fromEnv && !forceRemote) {
      return fromEnv
    }
    return await fetchRemoteConfig()
  } catch (err) {
    console.error('[preload] getSupabaseConfig failed', err)
    throw err
  }
}

let sharp = null
try {
  sharp = require('sharp')
} catch (e) {

}

let appVersion = '0.0.0'
try {
  const pkg = require(path.join(__dirname, 'package.json'))
  if (pkg?.version) appVersion = String(pkg.version).trim()
} catch (_) {
  /* ignore */
}

// Match main.js: --dev flag OR unpackaged electron . / npm run start
let isDev = process.argv.includes('--dev')
try {
  const { app } = require('electron')
  if (!app.isPackaged) isDev = true
} catch (_) {
  /* ignore */
}

const ALLOWED_INVOKE = new Set([
  'get-is-tracking',
  'minimize-window',
  'close-window',
  'get-system-idle-time',
  'set-is-tracking',
  'get-desktop-sources',
  'check-screen-off',
  'show-overlay',
  'hide-overlay',
  'close-overlay',
  'open-azure-sso-window',
])

const ALLOWED_SEND = new Set(['overlay-continue', 'overlay-stop'])

const ALLOWED_ON = new Set([
  'oauth-callback',
  'overlay-continue',
  'overlay-stop',
  'power-resume',
  'power-suspend',
  'auth-keepalive',
  'system-activity-detected',
  'system-event',
  'azure-sso-callback',
  'update-overlay',
  'devtools-blocked',
])

contextBridge.exposeInMainWorld('timeflow', {
  dirname: __dirname,
  appVersion,
  isDev,
  env: {
    // Intentionally empty for packaged builds — use getSupabaseConfig() instead.
    // Local .env still available via getSupabaseConfig source:'env'.
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SCREENSHOT_STORAGE_SERVER_URL: process.env.SCREENSHOT_STORAGE_SERVER_URL || '',
    DESKTOP_CONFIG_URL:
      process.env.DESKTOP_CONFIG_URL ||
      process.env.VITE_DESKTOP_CONFIG_URL ||
      DEFAULT_CONFIG_URL,
  },
  getSupabaseConfig,
  createClient,
  openExternal: (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url)
    }
    return Promise.reject(new Error('Invalid external URL'))
  },
  fs: {
    writeFileSync: (filePath, data, options) => {
      const payload =
        typeof data === 'string' || data instanceof Uint8Array
          ? data
          : Buffer.from(data)
      return fs.writeFileSync(filePath, payload, options)
    },
    readFileSync: (filePath, options) => {
      const data = fs.readFileSync(filePath, options)
      if (typeof data === 'string') return data
      // contextBridge cannot reliably clone Node Buffers — return Uint8Array
      return new Uint8Array(data)
    },
    existsSync: (...args) => fs.existsSync(...args),
    unlinkSync: (...args) => fs.unlinkSync(...args),
    mkdirSync: (...args) => fs.mkdirSync(...args),
    readdirSync: (...args) => fs.readdirSync(...args),
    // Only return plain fields — fs.Stats is not cloneable across contextBridge
    statSync: (filePath) => {
      const s = fs.statSync(filePath)
      return {
        size: s.size,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        mtimeMs: s.mtimeMs,
      }
    },
  },
  path: {
    join: (...args) => path.join(...args),
    basename: (...args) => path.basename(...args),
    dirname: (...args) => path.dirname(...args),
    extname: (...args) => path.extname(...args),
  },
  os: {
    platform: () => os.platform(),
    tmpdir: () => os.tmpdir(),
    homedir: () => os.homedir(),
  },
  crypto: {
    randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
    createHash: (alg) => crypto.createHash(alg),
  },
  Buffer: {
    from: (data, enc) => {
      const buf = Buffer.from(data, enc)
      return new Uint8Array(buf)
    },
    isBuffer: (v) => Buffer.isBuffer(v) || v instanceof Uint8Array,
  },
  // Return Uint8Array so contextBridge can clone screenshot bytes into the renderer
  screenshot: async (opts) => {
    const buf = await screenshot(opts)
    if (!buf) return null
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  },
  listDisplays: async () => {
    if (typeof screenshot.listDisplays !== 'function') return []
    return screenshot.listDisplays()
  },
  sharpAvailable: Boolean(sharp),
  async imageContentHash(buffer, taskbarHeightPx, compareResizeWidth) {
    if (!sharp || !buffer || buffer.length === 0) return null
    try {
      const input = buffer instanceof Uint8Array ? Buffer.from(buffer) : buffer
      const image = sharp(input)
      const meta = await image.metadata()
      const w = meta.width || 0
      const h = meta.height || 0
      if (w < 10 || h <= taskbarHeightPx) return null
      const contentHeight = Math.max(10, h - taskbarHeightPx)
      const raw = await image
        .extract({ left: 0, top: 0, width: w, height: contentHeight })
        .resize(compareResizeWidth, null, { withoutEnlargement: true })
        .grayscale()
        .raw()
        .toBuffer()
      return crypto.createHash('sha256').update(raw).digest('hex')
    } catch (err) {

      return null
    }
  },
  async imageIsBlackScreen(buffer) {
    if (!sharp || !buffer || buffer.length === 0) return false
    try {
      const input = buffer instanceof Uint8Array ? Buffer.from(buffer) : buffer
      const { data: raw, info } = await sharp(input)
        .resize(100, 100, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true })
      const channels = info.channels || 3
      let darkCount = 0
      const pixelCount = Math.floor(raw.length / channels)
      for (let i = 0; i < raw.length; i += channels) {
        const r = raw[i]
        const g = raw[i + 1] ?? r
        const b = raw[i + 2] ?? r
        if (r < 16 && g < 16 && b < 16) darkCount++
      }
      return pixelCount > 0 && darkCount / pixelCount > 0.92
    } catch (err) {

      return false
    }
  },
  ipc: {
    invoke: (channel, ...args) => {
      if (!ALLOWED_INVOKE.has(channel)) {
        return Promise.reject(new Error(`IPC invoke blocked: ${channel}`))
      }
      return ipcRenderer.invoke(channel, ...args)
    },
    send: (channel, ...args) => {
      if (!ALLOWED_SEND.has(channel)) {
        throw new Error(`IPC send blocked: ${channel}`)
      }
      ipcRenderer.send(channel, ...args)
    },
    on: (channel, listener) => {
      if (!ALLOWED_ON.has(channel)) {
        throw new Error(`IPC on blocked: ${channel}`)
      }
      const wrapped = (event, ...args) => listener(event, ...args)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    },
  },
})
