const { app, BrowserWindow, ipcMain, globalShortcut, shell, protocol, powerMonitor, Menu } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// Windows taskbar / jump list: must match electron-builder appId or the default Electron icon shows
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.tracker.electron');
  } catch (_) {
    /* ignore */
  }
}

const isDev = process.argv.includes('--dev') || !app.isPackaged;

// Separate profile in --dev so GPU/disk cache is not locked by an installed TimeFlow
if (isDev) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'Mechlin_TimeFlow_Dev'));
  } catch (_) {
    /* ignore */
  }
}

let mainWindow = null;
let overlayWindow = null;
let isTracking = false;
let systemActivityMonitor = null;
let oauthCallbackServer = null;
const OAUTH_CALLBACK_PORT = 5174; // Different port from your website

function isDevToolsShortcut(input) {
  const key = String(input.key || '').toLowerCase();
  if (input.key === 'F12') return true;
  if (input.control && input.shift && ['i', 'j', 'c', 'k'].includes(key)) return true;
  if (input.meta && input.alt && ['i', 'j', 'c'].includes(key)) return true;
  if ((input.control || input.meta) && key === 'u') return true;
  return false;
}

/** Always notify the main renderer so it can warn, log, and capture evidence. */
function notifyDevToolsBlocked(payload) {
  if (isDev) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('devtools-blocked', payload || { trigger: 'blocked' });
    }
  } catch (_) {
    /* ignore */
  }
}

function attachDevToolsGuard(win) {
  if (isDev) return;
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.__devtoolsGuardAttached) return;
  contents.__devtoolsGuardAttached = true;

  contents.on('before-input-event', (event, input) => {
    if (!isDevToolsShortcut(input)) return;
    event.preventDefault();
    notifyDevToolsBlocked({
      trigger: 'keyboard_shortcut',
      key: input.key,
      control: Boolean(input.control),
      shift: Boolean(input.shift),
      alt: Boolean(input.alt),
      meta: Boolean(input.meta),
    });
  });

  contents.on('devtools-opened', () => {
    try {
      contents.closeDevTools();
    } catch (_) {
      /* ignore */
    }
    notifyDevToolsBlocked({ trigger: 'devtools_opened' });
  });
}

function createMainWindow() {
  // Don't create duplicate windows
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  // App icon from assets/timeflowicon.svg (converted; assets/ ships in the package)
  const iconCandidates = [
    path.join(__dirname, 'assets', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'assets', 'icon-256.png'),
    path.join(__dirname, 'build', 'icon-256.png'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'assets', 'timeflowicon.svg'),
  ];
  const iconPath = iconCandidates.find((p) => fs.existsSync(p));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false, // Hide title bar and window controls
    autoHideMenuBar: true, // Hide menu bar (File, Edit, View, etc.)
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: isDev,
    }
  });

  if (iconPath && process.platform === 'win32') {
    try {
      mainWindow.setIcon(iconPath);
    } catch (_) {
      /* ignore */
    }
  }
  mainWindow.loadFile('index.html');
  attachDevToolsGuard(mainWindow);

  if (isDev) {
    // Docked right so Console is visible immediately (detach can open off-screen / behind)
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        if (!mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.openDevTools({ mode: 'right' });
        }
        console.log('[main] DevTools enabled (isDev). Use View → Toggle Developer Tools or F12.');
      } catch (err) {
        console.error('[main] openDevTools failed', err);
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Forward renderer console.* to the terminal (npm run dev) — Chromium levels: 0..3
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (!isDev) return;
    // Electron 28+: either positional args or event details object
    const details =
      event && typeof event === 'object' && event.message != null
        ? event
        : { level, message, lineNumber: line, sourceId };
    const lvl = Number(details.level);
    const tag = ['verbose', 'info', 'warning', 'error'][lvl] || 'info';
    const msg = details.message != null ? details.message : message;
    const src = details.sourceId || sourceId || '';
    const ln = details.lineNumber != null ? details.lineNumber : line;
    console.log(`[renderer:${tag}] ${msg}${src ? ` (${src}:${ln})` : ''}`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[main] did-fail-load', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] render-process-gone', details);
  });

  // Handle window ready - process any pending callback
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingCallbackUrl) {

      setTimeout(() => {
        handleOAuthCallback(pendingCallbackUrl);
        pendingCallbackUrl = null;
      }, 500);
    }
  });
}

function createOverlayWindow() {
  try {
    overlayWindow = new BrowserWindow({
      width: 450,
      height: 300,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      transparent: true,
      show: false, // Don't show until ready
      webPreferences: {
        preload: path.join(__dirname, 'preload-overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        devTools: false,
      }
    });

    overlayWindow.loadFile('overlay.html');
    attachDevToolsGuard(overlayWindow);
    
    overlayWindow.once('ready-to-show', () => {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      overlayWindow.center();
      overlayWindow.show();
      overlayWindow.focus();

    });

    overlayWindow.on('closed', () => {
      overlayWindow = null;
    });

    overlayWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {

    });
  } catch (error) {

  }
}

// Register custom protocol handler for OAuth callback
const PROTOCOL_NAME = 'tracker';

// Filter out protocol URLs from command line arguments to prevent Electron from trying to open them as files
// This must be done BEFORE app.whenReady()
if (process.platform === 'win32' || process.platform === 'linux') {
  const protocolArgs = process.argv.filter(arg => arg && arg.startsWith(`${PROTOCOL_NAME}://`));
  if (protocolArgs.length > 0) {
    // Store the protocol URL for later processing
    process.trackerProtocolUrl = protocolArgs[0];
    // Remove protocol URLs from argv to prevent Electron from trying to open them as files
    process.argv = process.argv.filter(arg => !arg || !arg.startsWith(`${PROTOCOL_NAME}://`));
  }
}

// Only set as default protocol client if not already set (prevents errors in development)
if (!app.isDefaultProtocolClient(PROTOCOL_NAME)) {
  app.setAsDefaultProtocolClient(PROTOCOL_NAME);
}

// Handle protocol on Windows/Linux (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleOAuthCallback(url);
});

// Handle protocol on macOS (before app is ready)
app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleOAuthCallback(url);
  });
});

app.whenReady().then(() => {
  // Production: strip menu (hides View → Developer Tools).
  // Dev: keep a minimal menu so Toggle DevTools / Reload always work.
  try {
    if (isDev) {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'forceReload' },
              { type: 'separator' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
            ],
          },
        ])
      );
    } else {
      Menu.setApplicationMenu(null);
    }
  } catch (_) {
    /* ignore */
  }

  // Harden every webContents that gets created (force-close DevTools if opened) — production only
  if (!isDev) {
    app.on('web-contents-created', (_event, contents) => {
      contents.on('devtools-opened', () => {
        try {
          contents.closeDevTools();
        } catch (_) {
          /* ignore */
        }
        notifyDevToolsBlocked({ trigger: 'devtools_opened' });
      });
    });

    app.on('browser-window-created', (_event, win) => {
      attachDevToolsGuard(win);
    });
  }

  createMainWindow();
  
  // Handle protocol on Windows/Linux (after app is ready)
  // This handles the case where the app is launched via the protocol URL
  if (process.platform === 'win32' || process.platform === 'linux') {
    // Check if we stored a protocol URL earlier
    if (process.trackerProtocolUrl) {
      const protocolUrl = process.trackerProtocolUrl;
      delete process.trackerProtocolUrl;
      // Delay to ensure main window is created first
      setTimeout(() => {
        handleOAuthCallback(protocolUrl);
      }, 1000);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  // Setup powerMonitor event listeners for automatic tracking stop
  setupPowerMonitorListeners();
  
  // Setup user switch detection (Windows)
  if (process.platform === 'win32') {
    setupUserSwitchDetection();
  }
});

app.on('window-all-closed', () => {
  stopSystemActivityMonitoring();
  stopOAuthCallbackServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopOAuthCallbackServer();
  // Notify renderer that app is quitting
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('system-event', { type: 'app-quitting' });
  }
});

// IPC handlers
ipcMain.handle('get-is-tracking', () => {
  return isTracking;
});

// Handle window minimize request
ipcMain.handle('minimize-window', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

// Handle window close request
ipcMain.handle('close-window', () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

// PowerShell: run hidden to avoid windows and reduce RAM/CPU (packaged app)
const PS_HIDDEN = 'powershell -WindowStyle Hidden -NoProfile -NonInteractive';
const EXEC_OPTS = { timeout: 2000, maxBuffer: 64 * 1024, windowsHide: true };

// Handler to get current system idle time (cross-platform via Electron; no PowerShell dependency)
ipcMain.handle('get-system-idle-time', () => {
  try {
    const idleSeconds = powerMonitor.getSystemIdleTime();
    return typeof idleSeconds === 'number' && idleSeconds >= 0 ? idleSeconds : null;
  } catch (e) {

    return null;
  }
});

ipcMain.handle('set-is-tracking', (event, value) => {
  isTracking = value;
  if (value) {
    startSystemActivityMonitoring();
  } else {
    stopSystemActivityMonitoring();
  }
});

// Handler to get desktop sources for screenshot capture fallback
ipcMain.handle('get-desktop-sources', async (event, options) => {
  try {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
      types: options.types || ['screen'],
      thumbnailSize: options.thumbnailSize || { width: 1920, height: 1080 }
    });
    return sources;
  } catch (error) {

    return [];
  }
});

// Handler to check if screen is off (Windows)
ipcMain.handle('check-screen-off', async () => {
  if (process.platform !== 'win32') {
    return false; // Not Windows, assume screen is on
  }

  try {
    const { exec } = require('child_process');
    const psCommand = `${PS_HIDDEN} -Command "$monitors = Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBasicDisplayParams; foreach ($monitor in $monitors) { if ($monitor.Active -eq $false) { Write-Output 'OFF'; exit } }; Write-Output 'ON'"`;
    return new Promise((resolve) => {
      exec(psCommand, EXEC_OPTS, (error, stdout, stderr) => {
        if (error || stderr) {
          // If we can't determine, assume screen is on (safer)
          resolve(false);
          return;
        }
        const result = stdout.trim().toUpperCase();
        resolve(result === 'OFF');
      });
    });
  } catch (error) {

    return false; // Assume screen is on if we can't determine
  }
});

// System-wide activity monitoring (cross-platform via Electron powerMonitor; works when app is minimized)
function startSystemActivityMonitoring() {
  if (systemActivityMonitor) {
    return; // Already monitoring
  }



  let lastIdleTime = 0;
  let consecutiveActiveChecks = 0;
  let checkCount = 0;
  const ACTIVITY_CHECK_MS = 10000; // 10s – balance between responsiveness and CPU

  systemActivityMonitor = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      if (typeof idleSeconds !== 'number' || idleSeconds < 0) return;

      // Same activity logic as before: idle < 20s = active; or idle decreasing = recent input
      const isActive = idleSeconds < 20 ||
        (lastIdleTime > 0 && idleSeconds < lastIdleTime - 0.05) ||
        (idleSeconds < 10 && lastIdleTime < 10) ||
        (lastIdleTime > 0 && idleSeconds < lastIdleTime);

      if (checkCount % 30 === 0) {

      }

      if (isActive) {
        consecutiveActiveChecks++;
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('system-activity-detected', idleSeconds);
            if (consecutiveActiveChecks % 10 === 0) {

            }
          }
        } catch (sendError) {

        }
      } else {
        if (consecutiveActiveChecks > 0) {

        }
        consecutiveActiveChecks = 0;
      }

      lastIdleTime = idleSeconds;
    } catch (e) {

    }
  }, ACTIVITY_CHECK_MS);
}

function stopSystemActivityMonitoring() {
  if (systemActivityMonitor) {
    clearInterval(systemActivityMonitor);
    systemActivityMonitor = null;
  }
}

ipcMain.handle('show-overlay', (event, options = {}) => {
  try {
    const { title, message, icon, isStopped = false } = options;

    
    const sendUpdateMessage = () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        if (title || message || icon !== undefined || isStopped !== undefined) {
          // Small delay to ensure window is ready
          setTimeout(() => {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send('update-overlay', { title, message, icon, isStopped });
            }
          }, 100);
        }
      }
    };
    
    if (!overlayWindow) {

      createOverlayWindow();
      // Wait for window to be ready before sending message
      overlayWindow.webContents.once('did-finish-load', () => {
        sendUpdateMessage();
      });
    } else {
      // Window already exists, update it and show
      sendUpdateMessage();
      overlayWindow.show();
      overlayWindow.focus();

    }
  } catch (error) {

  }
});

ipcMain.handle('hide-overlay', () => {
  if (overlayWindow) {
    overlayWindow.hide();
  }
});

ipcMain.handle('close-overlay', () => {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
});

// Handle overlay button clicks
ipcMain.on('overlay-continue', () => {
  if (mainWindow) {
    mainWindow.webContents.send('overlay-continue');
  }
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
});

ipcMain.on('overlay-stop', () => {
  if (mainWindow) {
    mainWindow.webContents.send('overlay-stop');
  }
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
});

// Start local HTTP server to receive OAuth callback
function startOAuthCallbackServer() {
  if (oauthCallbackServer) {
    return; // Server already running
  }

  oauthCallbackServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${OAUTH_CALLBACK_PORT}`);
    






    
    // Only handle /callback path
    if (url.pathname === '/callback') {
      let accessToken = null;
      let refreshToken = null;
      
      // Extract tokens from query params
      accessToken = url.searchParams.get('access_token');
      refreshToken = url.searchParams.get('refresh_token');
      



      
      // Send response to browser
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (accessToken && refreshToken) {
        res.end(`
          <html>
            <head><title>Login Successful</title></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
              <h1 style="color: green;">Login Successful!</h1>
              <p>You can close this window and return to the Time Flow app.</p>
              <script>setTimeout(() => window.close(), 2000);</script>
            </body>
          </html>
        `);
        

        // Send tokens to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          const callbackData = {
            access_token: accessToken,
            refresh_token: refreshToken,
            success: true
          };

          mainWindow.webContents.send('azure-sso-callback', callbackData);

        } else {

        }
      } else {

        res.end(`
          <html>
            <head><title>Login Failed</title></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
              <h1 style="color: red;">✗ Login Failed</h1>
              <p>No tokens received. Please try again.</p>
              <p style="font-size: 12px; color: #666;">Check the Electron app console for details.</p>
            </body>
          </html>
        `);
        
        // Send error to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('azure-sso-callback', {
            error: 'No tokens received in callback'
          });
        }
      }
    } else {

      res.writeHead(404);
      res.end('Not Found');
    }
  });

  oauthCallbackServer.listen(OAUTH_CALLBACK_PORT, 'localhost', () => {

  });

  oauthCallbackServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {

    } else {

    }
  });
}

// Stop OAuth callback server
function stopOAuthCallbackServer() {
  if (oauthCallbackServer) {
    oauthCallbackServer.close();
    oauthCallbackServer = null;

  }
}

// Azure SSO OAuth handler - opens system browser
ipcMain.handle('open-azure-sso-window', async (event, options) => {
  try {
    // Start the callback server
    startOAuthCallbackServer();
    
    const { redirectUrl } = options;
    const callbackUrl = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
    



    
    // Open the OAuth URL in the system browser (not Electron window)
    // The website should redirect to the callbackUrl after successful login
    // Pass the callback URL as a query parameter
    const urlWithCallback = `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}callback=${encodeURIComponent(callbackUrl)}`;
    await shell.openExternal(urlWithCallback);
    
    return { success: true, callbackUrl: callbackUrl };
  } catch (error) {

    return { error: error.message };
  }
});

// Store callback URL if received before window is ready
let pendingCallbackUrl = null;

// Handle OAuth callback from custom protocol
function handleOAuthCallback(url) {
  try {

    
    // Ensure main window exists
    if (!mainWindow || mainWindow.isDestroyed()) {

      pendingCallbackUrl = url;
      // Try to create window if app is ready
      if (app.isReady()) {
        createMainWindow();
      }
      return;
    }
    
    // Parse the callback URL
    // Expected format: tracker://callback?access_token=...&refresh_token=...
    // or tracker://callback#access_token=...&refresh_token=...
    
    let accessToken = null;
    let refreshToken = null;
    
    try {
      const urlObj = new URL(url);
      
      // Check hash fragment first (Supabase OAuth uses hash)
      if (urlObj.hash) {
        const hash = urlObj.hash.substring(1); // Remove #
        const params = new URLSearchParams(hash);
        accessToken = params.get('access_token');
        refreshToken = params.get('refresh_token');
      }
      
      // If not in hash, check query params
      if (!accessToken) {
        accessToken = urlObj.searchParams.get('access_token');
        refreshToken = urlObj.searchParams.get('refresh_token');
      }
    } catch (parseError) {
      // If URL parsing fails, try manual parsing

      const tokenMatch = url.match(/[?&#]access_token=([^&?#]+)/);
      const refreshMatch = url.match(/[?&#]refresh_token=([^&?#]+)/);
      if (tokenMatch) accessToken = decodeURIComponent(tokenMatch[1]);
      if (refreshMatch) refreshToken = decodeURIComponent(refreshMatch[1]);
    }
    
    // Send callback to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('azure-sso-callback', {
        access_token: accessToken,
        refresh_token: refreshToken,
        url: url,
        success: !!accessToken && !!refreshToken
      });
    }
  } catch (error) {

    
    // Send error to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('azure-sso-callback', {
        error: error.message
      });
    }
  }
}

let authKeepaliveInterval = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Setup powerMonitor event listeners for automatic tracking stop
function setupPowerMonitorListeners() {
  // Screen lock detection (Windows + L or system lock)
  powerMonitor.on('lock-screen', () => {

    if (isTracking) {
      sendToRenderer('system-event', {
        type: 'screen-locked',
        reason: 'Screen was locked (Windows + L or system lock)'
      });
    }
  });

  // Screen unlock — refresh auth (renderer timers were often throttled while locked)
  powerMonitor.on('unlock-screen', () => {
    sendToRenderer('power-resume', { reason: 'unlock-screen' });
  });

  // Sleep mode detection
  powerMonitor.on('suspend', () => {
    sendToRenderer('power-suspend', { reason: 'system-sleep' });
    if (isTracking) {
      sendToRenderer('system-event', {
        type: 'system-sleep',
        reason: 'PC entered sleep mode'
      });
    }
  });

  // System resume from sleep — force session refresh so midnight/day-cycle sync can auth
  powerMonitor.on('resume', () => {
    sendToRenderer('power-resume', { reason: 'system-resume' });
  });

  // Shutdown detection
  powerMonitor.on('shutdown', () => {

    if (isTracking) {
      sendToRenderer('system-event', {
        type: 'system-shutdown',
        reason: 'PC is shutting down'
      });
    }
  });

  // Renderer setInterval is heavily throttled when hidden overnight; main process is not.
  // Ping every 4 minutes so supabase-js can refresh the JWT before it expires (~1h).
  if (authKeepaliveInterval) {
    clearInterval(authKeepaliveInterval);
  }
  authKeepaliveInterval = setInterval(() => {
    sendToRenderer('auth-keepalive', { ts: Date.now() });
  }, 3 * 60 * 1000); // every 3 min — stay ahead of ~1h JWT expiry when window is hidden
}

// Setup user switch detection for Windows
function setupUserSwitchDetection() {
  if (process.platform !== 'win32') {
    return; // Only for Windows
  }

  const { exec } = require('child_process');
  let lastSessionId = null;
  
  // Get initial session ID
  getCurrentSessionId().then(sessionId => {
    lastSessionId = sessionId;

  });

  // Check for user switch every 2 seconds
  setInterval(() => {
    getCurrentSessionId().then(sessionId => {
      if (lastSessionId !== null && sessionId !== lastSessionId) {

        if (mainWindow && !mainWindow.isDestroyed() && isTracking) {
          mainWindow.webContents.send('system-event', { type: 'user-switched', reason: 'Windows user was switched' });
        }
        lastSessionId = sessionId;
      }
    }).catch(() => {});
  }, 30000); // 30s – user switch rare; fewer PowerShell spawns
}

// Get current Windows session ID
function getCurrentSessionId() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Not Windows'));
      return;
    }

    const { exec } = require('child_process');
    const psCommand = `${PS_HIDDEN} -Command "Get-Process -Id $PID | Select-Object -ExpandProperty SessionId"`;
    exec(psCommand, { ...EXEC_OPTS, timeout: 1000, maxBuffer: 4096 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr) {
        reject(new Error(stderr));
        return;
      }
      const sessionId = parseInt(stdout.trim());
      if (isNaN(sessionId)) {
        reject(new Error('Invalid session ID'));
        return;
      }
      resolve(sessionId);
    });
  });
}


