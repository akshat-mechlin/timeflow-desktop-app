const { app, BrowserWindow, ipcMain, globalShortcut, shell, protocol, powerMonitor, systemPreferences, desktopCapturer } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
// dotenv removed - credentials are hardcoded in renderer.js

let mainWindow = null;
let overlayWindow = null;
let isTracking = false;
let systemActivityMonitor = null;
let oauthCallbackServer = null;
const OAUTH_CALLBACK_PORT = 5174; // Different port from your website

function createMainWindow() {
  // Don't create duplicate windows
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  // Set icon path - try PNG first, fallback to SVG
  let iconPath = path.join(__dirname, 'build', 'icon-256.png');
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(__dirname, 'build', 'icon.png');
  }
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(__dirname, 'assets', 'timeflowicon.svg');
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false, // Hide title bar and window controls
    autoHideMenuBar: true, // Hide menu bar (File, Edit, View, etc.)
    icon: iconPath, // Set application icon
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true // Enable web security for Supabase
    }
  });

  mainWindow.loadFile('index.html');

  // DevTools disabled - uncomment the line below if you need to debug
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log console messages from renderer
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer ${level}]:`, message);
  });

  // Handle page errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Page failed to load:', errorCode, errorDescription, validatedURL);
  });

  // Handle window ready - process any pending callback
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingCallbackUrl) {
      console.log('Processing pending callback URL');
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
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    overlayWindow.loadFile('overlay.html');
    
    overlayWindow.once('ready-to-show', () => {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      overlayWindow.center();
      overlayWindow.show();
      overlayWindow.focus();
      console.log('Overlay window ready and shown');
    });

    overlayWindow.on('closed', () => {
      overlayWindow = null;
    });

    overlayWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('Overlay window failed to load:', errorCode, errorDescription);
    });
  } catch (error) {
    console.error('Error creating overlay window:', error);
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
    console.error('get-system-idle-time failed:', e.message);
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

// macOS: wallpaper-only screenshots mean Screen Recording is off; empty-buffer checks are not enough.
ipcMain.handle('get-screen-capture-access-status', () => {
  if (process.platform !== 'darwin') {
    return 'granted';
  }
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch (e) {
    console.error('get-screen-capture-access-status:', e.message);
    return 'unknown';
  }
});

// macOS: show system camera prompt when status is still "not-determined"
ipcMain.handle('ensure-macos-camera-access', async () => {
  if (process.platform !== 'darwin') {
    return { status: 'granted' };
  }
  try {
    let status = systemPreferences.getMediaAccessStatus('camera');
    if (status === 'not-determined') {
      await systemPreferences.askForMediaAccess('camera');
      status = systemPreferences.getMediaAccessStatus('camera');
    }
    return { status };
  } catch (e) {
    console.warn('ensure-macos-camera-access:', e.message);
    return { status: 'unknown' };
  }
});

// macOS: triggers the system Screen Recording prompt when status is still "not-determined"
ipcMain.handle('prompt-screen-capture-if-needed', async () => {
  if (process.platform !== 'darwin') {
    return 'granted';
  }
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 }
    });
  } catch (e) {
    console.warn('prompt-screen-capture-if-needed getSources:', e.message);
  }
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch (e) {
    return 'unknown';
  }
});

// Handler to get desktop sources for screenshot capture fallback
ipcMain.handle('get-desktop-sources', async (event, options) => {
  try {
    const sources = await desktopCapturer.getSources({
      types: options.types || ['screen'],
      thumbnailSize: options.thumbnailSize || { width: 1920, height: 1080 }
    });
    return sources;
  } catch (error) {
    console.error('Error getting desktop sources:', error);
    return [];
  }
});

// PNG snapshots from main process — avoids renderer getUserMedia desktop capture, which often hits
// "Timeout starting video source" on macOS (Chromium/Electron) even when Screen Recording is granted.
ipcMain.handle('capture-desktop-screens-png', async (event, options) => {
  const w = Math.min(options?.maxWidth || 3840, 3840);
  const h = Math.min(options?.maxHeight || 2160, 2160);
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h }
    });
    return sources.map((s) => ({
      name: s.name,
      png: s.thumbnail.toPNG()
    }));
  } catch (error) {
    console.error('capture-desktop-screens-png:', error.message || error);
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
    console.error('Error checking screen state:', error);
    return false; // Assume screen is on if we can't determine
  }
});

// System-wide activity monitoring (cross-platform via Electron powerMonitor; works when app is minimized)
function startSystemActivityMonitoring() {
  if (systemActivityMonitor) {
    return; // Already monitoring
  }

  console.log('Starting system-wide activity monitoring (all platforms)...');

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
        console.log(`System activity check #${checkCount}: idle=${idleSeconds.toFixed(1)}s, lastIdle=${lastIdleTime.toFixed(1)}s, active=${isActive}`);
      }

      if (isActive) {
        consecutiveActiveChecks++;
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('system-activity-detected', idleSeconds);
            if (consecutiveActiveChecks % 10 === 0) {
              console.log(`✓ System activity: idle=${idleSeconds.toFixed(1)}s (active for ${consecutiveActiveChecks} checks)`);
            }
          }
        } catch (sendError) {
          console.error('Error sending system-activity-detected:', sendError);
        }
      } else {
        if (consecutiveActiveChecks > 0) {
          console.log(`✗ System activity stopped: idle=${idleSeconds.toFixed(1)}s (was active for ${consecutiveActiveChecks} checks)`);
        }
        consecutiveActiveChecks = 0;
      }

      lastIdleTime = idleSeconds;
    } catch (e) {
      console.error('Error in system activity check:', e.message);
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
    console.log('show-overlay called', { title, message, icon, isStopped });
    
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
      console.log('Creating overlay window');
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
      console.log('Overlay window shown (existing)');
    }
  } catch (error) {
    console.error('Error in show-overlay handler:', error);
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
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('OAuth callback received on HTTP server');
    console.log('Full URL:', req.url);
    console.log('Pathname:', url.pathname);
    console.log('Query params:', url.search);
    console.log('═══════════════════════════════════════════════════════');
    
    // Only handle /callback path
    if (url.pathname === '/callback') {
      let accessToken = null;
      let refreshToken = null;
      
      // Extract tokens from query params
      accessToken = url.searchParams.get('access_token');
      refreshToken = url.searchParams.get('refresh_token');
      
      console.log('Extracted tokens:');
      console.log('  access_token:', accessToken ? `${accessToken.substring(0, 20)}...` : 'MISSING');
      console.log('  refresh_token:', refreshToken ? `${refreshToken.substring(0, 20)}...` : 'MISSING');
      
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
        
        console.log('Sending tokens to renderer process...');
        // Send tokens to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          const callbackData = {
            access_token: accessToken,
            refresh_token: refreshToken,
            success: true
          };
          console.log('Main window exists, sending callback data:', {
            has_access_token: !!callbackData.access_token,
            has_refresh_token: !!callbackData.refresh_token
          });
          mainWindow.webContents.send('azure-sso-callback', callbackData);
          console.log('Callback data sent to renderer');
        } else {
          console.error('ERROR: Main window is null or destroyed, cannot send callback!');
        }
      } else {
        console.error('ERROR: Missing tokens in callback!');
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
      console.log('404: Path not /callback, returning Not Found');
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  oauthCallbackServer.listen(OAUTH_CALLBACK_PORT, 'localhost', () => {
    console.log(`OAuth callback server listening on http://localhost:${OAUTH_CALLBACK_PORT}`);
  });

  oauthCallbackServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`Port ${OAUTH_CALLBACK_PORT} is already in use, OAuth callback server may already be running`);
    } else {
      console.error('OAuth callback server error:', error);
    }
  });
}

// Stop OAuth callback server
function stopOAuthCallbackServer() {
  if (oauthCallbackServer) {
    oauthCallbackServer.close();
    oauthCallbackServer = null;
    console.log('OAuth callback server stopped');
  }
}

// Azure SSO OAuth handler - opens system browser
ipcMain.handle('open-azure-sso-window', async (event, options) => {
  try {
    // Start the callback server
    startOAuthCallbackServer();
    
    const { redirectUrl } = options;
    const callbackUrl = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
    
    console.log('Opening Azure SSO in system browser...');
    console.log('Redirect URL:', redirectUrl);
    console.log('Callback URL:', callbackUrl);
    
    // Open the OAuth URL in the system browser (not Electron window)
    // The website should redirect to the callbackUrl after successful login
    // Pass the callback URL as a query parameter
    const urlWithCallback = `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}callback=${encodeURIComponent(callbackUrl)}`;
    await shell.openExternal(urlWithCallback);
    
    return { success: true, callbackUrl: callbackUrl };
  } catch (error) {
    console.error('Error opening Azure SSO in browser:', error);
    return { error: error.message };
  }
});

// Store callback URL if received before window is ready
let pendingCallbackUrl = null;

// Handle OAuth callback from custom protocol
function handleOAuthCallback(url) {
  try {
    console.log('OAuth callback received:', url);
    
    // Ensure main window exists
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.log('Main window not ready, storing callback URL');
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
      console.warn('URL parsing failed, trying manual parse:', parseError);
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
    console.error('Error handling OAuth callback:', error);
    
    // Send error to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('azure-sso-callback', {
        error: error.message
      });
    }
  }
}

// Setup powerMonitor event listeners for automatic tracking stop
function setupPowerMonitorListeners() {
  // Screen lock detection (Windows + L or system lock)
  powerMonitor.on('lock-screen', () => {
    console.log('🔒 Screen locked - stopping tracker');
    if (mainWindow && !mainWindow.isDestroyed() && isTracking) {
      mainWindow.webContents.send('system-event', { 
        type: 'screen-locked',
        reason: 'Screen was locked (Windows + L or system lock)'
      });
    }
  });

  // Screen unlock detection (for logging, but we don't auto-resume)
  powerMonitor.on('unlock-screen', () => {
    console.log('🔓 Screen unlocked');
    // We don't auto-resume tracking, user must manually start again
  });

  // Sleep mode detection
  powerMonitor.on('suspend', () => {
    console.log('😴 System entering sleep mode - stopping tracker');
    if (mainWindow && !mainWindow.isDestroyed() && isTracking) {
      mainWindow.webContents.send('system-event', { 
        type: 'system-sleep',
        reason: 'PC entered sleep mode'
      });
    }
  });

  // System resume from sleep
  powerMonitor.on('resume', () => {
    console.log('⏰ System resumed from sleep');
    // We don't auto-resume tracking, user must manually start again
  });

  // Shutdown detection
  powerMonitor.on('shutdown', () => {
    console.log('🛑 System shutting down - stopping tracker');
    if (mainWindow && !mainWindow.isDestroyed() && isTracking) {
      mainWindow.webContents.send('system-event', { 
        type: 'system-shutdown',
        reason: 'PC is shutting down'
      });
    }
  });

  console.log('✅ PowerMonitor event listeners setup complete');
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
    console.log('Initial Windows session ID:', sessionId);
  });

  // Check for user switch every 2 seconds
  setInterval(() => {
    getCurrentSessionId().then(sessionId => {
      if (lastSessionId !== null && sessionId !== lastSessionId) {
        console.log('👤 User switched - stopping tracker');
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


