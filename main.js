const { app, BrowserWindow, ipcMain, globalShortcut, shell, protocol } = require('electron');
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
    iconPath = path.join(__dirname, 'assets', 'icon.svg');
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
      enableRemoteModule: true,
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

// Handler to get current system idle time
ipcMain.handle('get-system-idle-time', () => {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      const psCommand = `powershell -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LastInput { [DllImport(\\\"user32.dll\\\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); [DllImport(\\\"kernel32.dll\\\")] public static extern uint GetTickCount(); [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } }'; $lastInput = New-Object LastInput+LASTINPUTINFO; $lastInput.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lastInput); [LastInput]::GetLastInputInfo([ref]$lastInput); $tickCount = [LastInput]::GetTickCount(); $idleTime = ($tickCount - $lastInput.dwTime) / 1000; Write-Output $idleTime"`;
      
      exec(psCommand, { timeout: 1500 }, (error, stdout, stderr) => {
        if (error) {
          console.error('PowerShell error in get-system-idle-time:', error.message);
          resolve(null);
          return;
        }
        if (stderr) {
          console.error('PowerShell stderr in get-system-idle-time:', stderr);
          resolve(null);
          return;
        }
        if (!stdout) {
          resolve(null);
          return;
        }
        try {
          const trimmed = stdout.trim();
          // Check if output is a valid number (not "True", "False", or other non-numeric)
          if (trimmed === 'True' || trimmed === 'False' || trimmed === '' || trimmed.toLowerCase() === 'true' || trimmed.toLowerCase() === 'false') {
            console.warn('PowerShell returned non-numeric value:', trimmed);
            resolve(null);
            return;
          }
          const idleSeconds = parseFloat(trimmed);
          if (isNaN(idleSeconds) || idleSeconds < 0) {
            console.warn('Invalid idle time from PowerShell:', trimmed);
            resolve(null);
            return;
          }
          resolve(idleSeconds);
        } catch (e) {
          console.error('Error parsing idle time:', e);
          resolve(null);
        }
      });
    });
  }
  return null;
});

ipcMain.handle('set-is-tracking', (event, value) => {
  isTracking = value;
  if (value) {
    startSystemActivityMonitoring();
  } else {
    stopSystemActivityMonitoring();
  }
});

// System-wide activity monitoring for Windows
function startSystemActivityMonitoring() {
  if (systemActivityMonitor) {
    return; // Already monitoring
  }

  console.log('Starting system-wide activity monitoring...');

  if (process.platform === 'win32') {
    const { exec } = require('child_process');
    const path = require('path');
    let lastIdleTime = 0;
    let consecutiveActiveChecks = 0;
    let checkCount = 0;
    
    // Monitor system activity every 1 second for more responsive detection
    systemActivityMonitor = setInterval(() => {
      checkCount++;
      // Use inline PowerShell command for better reliability (works in packaged app)
      const psCommand = `powershell -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LastInput { [DllImport(\\\"user32.dll\\\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); [DllImport(\\\"kernel32.dll\\\")] public static extern uint GetTickCount(); [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } }'; $lastInput = New-Object LastInput+LASTINPUTINFO; $lastInput.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lastInput); [LastInput]::GetLastInputInfo([ref]$lastInput); $tickCount = [LastInput]::GetTickCount(); $idleTime = ($tickCount - $lastInput.dwTime) / 1000; Write-Output $idleTime"`;
      
      exec(psCommand, { timeout: 1500 }, (error, stdout, stderr) => {
        if (error) {
          console.error('Error checking system activity:', error.message);
          return;
        }
        if (stderr) {
          console.error('PowerShell stderr:', stderr);
          return;
        }
        if (!stdout || !mainWindow || mainWindow.isDestroyed()) {
          return;
        }
        
          try {
          const trimmed = stdout.trim();
          // Check if output is a valid number (not "True", "False", or other non-numeric)
          if (trimmed === 'True' || trimmed === 'False' || trimmed === '' || trimmed.toLowerCase() === 'true' || trimmed.toLowerCase() === 'false') {
            console.warn('PowerShell returned non-numeric value in monitoring:', trimmed);
            return;
          }
          const idleSeconds = parseFloat(trimmed);
          if (isNaN(idleSeconds) || idleSeconds < 0) {
            console.warn('Invalid idle time from PowerShell:', trimmed);
            return;
          }
          
          // More aggressive activity detection:
          // 1. If idle time is less than 20 seconds, user is definitely active
          // 2. If idle time decreased (user became active) - very sensitive (0.05s threshold)
          // 3. If idle time is stable but low (< 10s), user is active
          // 4. If idle time is decreasing, user is active
          const isActive = idleSeconds < 20 || 
                          (lastIdleTime > 0 && idleSeconds < lastIdleTime - 0.05) ||
                          (idleSeconds < 10 && lastIdleTime < 10) ||
                          (lastIdleTime > 0 && idleSeconds < lastIdleTime);
          
          // Log every 30 checks for debugging (every 30 seconds, less spam)
          if (checkCount % 30 === 0) {
            console.log(`System activity check #${checkCount}: idle=${idleSeconds.toFixed(1)}s, lastIdle=${lastIdleTime.toFixed(1)}s, active=${isActive}`);
          }
              
              if (isActive) {
                consecutiveActiveChecks++;
            // Send activity signal on every active check (with idle time info)
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('system-activity-detected', idleSeconds);
                // Log every 10 seconds for debugging (less spam)
                if (consecutiveActiveChecks % 10 === 0) {
                  console.log(`✓ System activity: idle=${idleSeconds.toFixed(1)}s (active for ${consecutiveActiveChecks} checks)`);
                }
              } else {
                console.warn('Cannot send system-activity-detected: mainWindow is null or destroyed');
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
          console.error('Error parsing system activity:', e);
        }
      });
    }, 1000); // Check every 1 second for more responsive detection
  }
}

function stopSystemActivityMonitoring() {
  if (systemActivityMonitor) {
    clearInterval(systemActivityMonitor);
    systemActivityMonitor = null;
  }
}

ipcMain.handle('show-overlay', () => {
  try {
    console.log('show-overlay called');
    if (!overlayWindow) {
      console.log('Creating overlay window');
      createOverlayWindow();
      // Window will be shown in ready-to-show event
    } else {
      // Window already exists, just show it
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
              <h1 style="color: green;">✓ Login Successful!</h1>
              <p>You can close this window and return to the Time Tracker app.</p>
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


