const { ipcRenderer } = require('electron');
const { createClient } = require('@supabase/supabase-js');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Supabase client - Hardcoded credentials
const supabaseUrl = 'https://yxkniwzsinqyjdqqzyjs.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl4a25pd3pzaW5xeWpkcXF6eWpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzY4ODY2OTMsImV4cCI6MjA1MjQ2MjY5M30.9n2wAH28zZplcHDSSDquQ9dD3zXTDoNmZ69uKSUE3Pk';

console.log('Initializing Supabase client...');
console.log('Supabase URL:', supabaseUrl);
console.log('Supabase Key (first 20 chars):', supabaseKey ? supabaseKey.substring(0, 20) + '...' : 'MISSING');

// Verify credentials are present
if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: Supabase credentials are missing!');
  alert('ERROR: Supabase credentials are missing. Please check the application configuration.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storage: window.localStorage,
    storageKey: 'supabase.auth.token'
  },
  global: {
    headers: {
      'x-client-info': 'electron-time-tracker'
    }
  }
});

console.log('Supabase client created successfully');

// Test connection
supabase.auth.getSession().then(({ data, error }) => {
  if (error) {
    console.error('Error testing Supabase connection:', error);
  } else {
    console.log('Supabase connection test successful');
  }
}).catch(err => {
  console.error('Exception testing Supabase connection:', err);
});

// IST timezone utilities
// IST is UTC+5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getISTComponents() {
  const now = new Date();
  // Get UTC time in milliseconds
  const utcTime = now.getTime();
  // Add IST offset to get IST time in milliseconds
  const istTimeMs = utcTime + IST_OFFSET_MS;
  
  // Create a date object representing IST time
  const istDate = new Date(istTimeMs);
  
  // Extract components (using UTC methods because we've already adjusted for IST)
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth();
  const date = istDate.getUTCDate();
  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  
  return { year, month, date, hours, minutes };
}

function getCurrentDayCycle() {
  const ist = getISTComponents();
  
  let cycleDate, cycleStart, cycleEnd;
  let cycleYear, cycleMonth, cycleDay;

  // If current time is before 6 AM IST, the cycle started yesterday at 6 AM
  if (ist.hours < 6) {
    // Cycle started yesterday at 6 AM IST
    // Calculate yesterday's date components
    const yesterday = new Date(Date.UTC(ist.year, ist.month, ist.date));
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    
    cycleYear = yesterday.getUTCFullYear();
    cycleMonth = yesterday.getUTCMonth();
    cycleDay = yesterday.getUTCDate();
    
    // Cycle start: yesterday at 6:00:00 AM IST = yesterday at 00:30:00 UTC
    cycleStart = new Date(Date.UTC(cycleYear, cycleMonth, cycleDay, 0, 30, 0, 0));
    
    // Cycle end: today at 5:59:59.999 AM IST = today at 00:29:59.999 UTC
    cycleEnd = new Date(Date.UTC(ist.year, ist.month, ist.date, 0, 29, 59, 999));
  } else {
    // Cycle started today at 6 AM IST
    cycleYear = ist.year;
    cycleMonth = ist.month;
    cycleDay = ist.date;
    
    // Cycle start: today at 6:00:00 AM IST = today at 00:30:00 UTC
    cycleStart = new Date(Date.UTC(cycleYear, cycleMonth, cycleDay, 0, 30, 0, 0));
    
    // Cycle end: tomorrow at 5:59:59.999 AM IST = tomorrow at 00:29:59.999 UTC
    const tomorrow = new Date(Date.UTC(ist.year, ist.month, ist.date));
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    cycleEnd = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 0, 29, 59, 999));
  }

  // Create cycle date object for the cycle date (not time)
  cycleDate = new Date(Date.UTC(cycleYear, cycleMonth, cycleDay));
  
  // Format date string as YYYY-MM-DD
  const dateString = `${cycleYear}-${String(cycleMonth + 1).padStart(2, '0')}-${String(cycleDay).padStart(2, '0')}`;

  return {
    start: cycleStart,
    end: cycleEnd,
    date: cycleDate,
    dateString: dateString
  };
}

function formatISTTime(date) {
  // date is already in UTC, just format it as IST
  // toLocaleString with timeZone already handles the conversion
  return date.toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// State management
let currentUser = null;
let userProfile = null; // Store user profile data including full_name
let isTracking = false;
let timeEntryId = null;
let startTime = null;
let baseDuration = 0; // Cumulative duration from previous sessions in same day cycle
let baseDurationAtSessionStart = 0; // Base duration when current session started (to prevent double-counting)
let sessionStartTime = null; // Start time of current session
let pausedDuration = 0; // Track paused time in current session
let pauseStartTime = null; // When tracking was paused
let isStoppingTracking = false; // Flag to prevent race conditions during stop
let timerInterval = null;
let captureInterval = null;
let dailyResetCheckInterval = null;
let idleTimer = null; // Timer for inactivity detection
let idleDoubleCheckTimer = null; // Timer for double-checking inactivity
let lastActivityTime = Date.now(); // Last time user was active
let resetIdleTimerDebounce = null; // Debounce timer for resetIdleTimer
let mouseMovementCount = 0;
let keystrokeCount = 0;
let currentDayCycle = null; // Current day cycle info
let isOnline = navigator.onLine; // Network status
let pendingUpdates = []; // Queue for offline updates
let syncInterval = null; // Interval for syncing when back online
let systemActivitySyncInterval = null; // Interval for syncing system activity
let projects = []; // List of projects assigned to user
let tasks = []; // List of tasks for selected project
let selectedProjectId = null; // Currently selected project
let selectedTaskId = null; // Currently selected task

// Local storage utilities for offline support
function getLocalStorageKey(userId, dayCycle) {
  return `time_tracker_${userId}_${dayCycle}`;
}

function saveToLocalStorage(userId, dayCycle, data) {
  try {
    const key = getLocalStorageKey(userId, dayCycle);
    const storageData = {
      ...data,
      dateString: dayCycle, // Store dateString for validation
      lastUpdated: Date.now(),
      synced: false
    };
    localStorage.setItem(key, JSON.stringify(storageData));
  } catch (error) {
    console.error('Error saving to local storage:', error);
  }
}

function loadFromLocalStorage(userId, dayCycle) {
  try {
    const key = getLocalStorageKey(userId, dayCycle);
    const data = localStorage.getItem(key);
    if (data) {
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading from local storage:', error);
  }
  return null;
}

function clearLocalStorage(userId, dayCycle) {
  try {
    const key = getLocalStorageKey(userId, dayCycle);
    localStorage.removeItem(key);
  } catch (error) {
    console.error('Error clearing local storage:', error);
  }
}

// Network status monitoring
function setupNetworkMonitoring() {
  window.addEventListener('online', () => {
    isOnline = true;
    console.log('Network connection restored');
    syncPendingUpdates();
  });
  
  window.addEventListener('offline', () => {
    isOnline = false;
    console.log('Network connection lost - using local storage');
  });
  
  // Check network status periodically
  setInterval(() => {
    const wasOnline = isOnline;
    isOnline = navigator.onLine;
    
    if (!wasOnline && isOnline) {
      console.log('Network connection restored');
      syncPendingUpdates();
    }
  }, 5000);
}

// Ensure duration never decreases - always use maximum
function ensureMaxDuration(currentDuration, newDuration) {
  return Math.max(currentDuration, newDuration);
}

// Sync duration to Supabase (used when local is higher)
async function syncDurationToSupabase(timeEntryId, duration) {
  if (!isOnline || !timeEntryId) return false;

  try {
    // Fetch current duration first
    const { data: currentEntry } = await supabase
      .from('time_entries')
      .select('duration')
      .eq('id', timeEntryId)
      .single();

    const remoteDuration = currentEntry?.duration || 0;
    const maxDuration = ensureMaxDuration(remoteDuration, duration);

    if (maxDuration > remoteDuration) {
      const { error } = await supabase
        .from('time_entries')
        .update({
          duration: maxDuration,
          end_time: null, // Always NULL during active tracking
          updated_at: new Date().toISOString()
        })
        .eq('id', timeEntryId);

      if (error) {
        console.error('Error syncing duration:', error);
        return false;
      }
      return true;
    }
    return true;
  } catch (error) {
    console.error('Error syncing duration:', error);
    return false;
  }
}

// Sync pending updates when back online
async function syncPendingUpdates() {
  if (!isOnline || !currentUser || pendingUpdates.length === 0) return;

  console.log(`Syncing ${pendingUpdates.length} pending updates...`);

  for (let i = pendingUpdates.length - 1; i >= 0; i--) {
    const update = pendingUpdates[i];
    try {
      // Fetch current duration first
      const { data: currentEntry } = await supabase
        .from('time_entries')
        .select('duration')
        .eq('id', update.timeEntryId)
        .single();

      const remoteDuration = currentEntry?.duration || 0;
      const maxDuration = ensureMaxDuration(remoteDuration, update.duration);

      const { error } = await supabase
        .from('time_entries')
        .update({
          duration: maxDuration,
          end_time: null, // Always NULL
          updated_at: new Date().toISOString()
        })
        .eq('id', update.timeEntryId);

      if (!error) {
        // Remove from queue
        pendingUpdates.splice(i, 1);
        console.log('Synced pending update successfully');
      } else {
        console.error('Error syncing pending update:', error);
      }
    } catch (error) {
      console.error('Error syncing pending update:', error);
    }
  }

  // Update local storage to mark as synced
  if (currentDayCycle) {
    const localData = loadFromLocalStorage(currentUser.id, currentDayCycle.dateString);
    if (localData) {
      saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
        ...localData,
        synced: true
      });
    }
  }
}

// DOM elements - wait for DOM to be ready
let loadingContainer, loginContainer, dashboardContainer, loginForm, emailInput, passwordInput;
let errorMessage, userNameSpan, logoutBtn, startBtn, stopBtn, timerDisplay, statusDisplay;
let projectSelect, taskSelect, taskNameDisplay, taskTagDisplay;
let azureSsoBtn, closeBtn, closeBtnLogin, minimizeBtn, minimizeBtnLogin;

// Initialize DOM elements when DOM is ready
function initializeDOMElements() {
  loadingContainer = document.getElementById('loading-container');
  loginContainer = document.getElementById('login-container');
  dashboardContainer = document.getElementById('dashboard-container');
  loginForm = document.getElementById('login-form');
  emailInput = document.getElementById('email');
  passwordInput = document.getElementById('password');
  errorMessage = document.getElementById('error-message');
  azureSsoBtn = document.getElementById('azure-sso-btn');
  userNameSpan = document.getElementById('user-name');
  logoutBtn = document.getElementById('logout-btn');
  minimizeBtn = document.getElementById('minimize-btn');
  minimizeBtnLogin = document.getElementById('minimize-btn-login');
  closeBtn = document.getElementById('close-btn');
  closeBtnLogin = document.getElementById('close-btn-login');
  startBtn = document.getElementById('start-btn');
  stopBtn = document.getElementById('stop-btn');
  timerDisplay = document.getElementById('timer');
  statusDisplay = document.getElementById('status');
  projectSelect = document.getElementById('project-select');
  taskSelect = document.getElementById('task-select');
  taskNameDisplay = document.getElementById('task-name');
  taskTagDisplay = document.getElementById('task-tag');

  // Verify critical elements exist
  if (!projectSelect) {
    console.error('project-select element not found!');
  }
  if (!taskSelect) {
    console.error('task-select element not found!');
  }
  if (!taskNameDisplay) {
    console.error('task-name element not found!');
  }
  if (!taskTagDisplay) {
    console.error('task-tag element not found!');
  }

  // Set up event listeners
  if (loginForm) {
loginForm.addEventListener('submit', handleLogin);
  }
  if (azureSsoBtn) {
    azureSsoBtn.addEventListener('click', handleAzureSSO);
  }
  if (logoutBtn) {
    console.log('Logout button found, adding event listener');
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Logout button clicked');
      handleLogout();
    });
  } else {
    console.error('Logout button not found!');
  }
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', handleMinimize);
  }
  if (minimizeBtnLogin) {
    minimizeBtnLogin.addEventListener('click', handleMinimize);
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', handleClose);
  }
  if (closeBtnLogin) {
    closeBtnLogin.addEventListener('click', handleClose);
  }
  if (startBtn) {
startBtn.addEventListener('click', startTracking);
  }
  if (stopBtn) {
stopBtn.addEventListener('click', stopTracking);
  }
  if (projectSelect) {
    projectSelect.addEventListener('change', handleProjectChange);
  }
  if (taskSelect) {
    taskSelect.addEventListener('change', handleTaskChange);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeDOMElements();
    checkAuth();
  });
} else {
  initializeDOMElements();
  checkAuth();
}

// Handle window beforeunload to save duration if tracking is active
window.addEventListener('beforeunload', async (e) => {
  if (isTracking) {
    console.log('Window closing - stopping tracking and saving duration...');
    // Use synchronous-like approach - we can't use async/await in beforeunload
    // So we'll use sendBeacon or a synchronous approach
    // For Electron, we can use a blocking approach
    e.preventDefault();
    
    // Create a promise that resolves when stopTracking completes
    const stopPromise = stopTracking();
    
    // Wait for it to complete (with timeout)
    try {
      await Promise.race([
        stopPromise,
        new Promise(resolve => setTimeout(resolve, 2000)) // 2 second timeout
      ]);
    } catch (error) {
      console.error('Error in beforeunload stopTracking:', error);
    }
    
    // Small delay to ensure database write completes
    await new Promise(resolve => setTimeout(resolve, 300));
  }
});
// Permission check button removed from UI - permissions checked automatically

// Track mouse movements and keystrokes for statistics and reset idle timer
function setupActivityListeners() {
  // Create a throttled version that logs activity for debugging
  const activityHandler = (eventType) => {
    return () => {
      if (isTracking && !pauseStartTime) {
        resetIdleTimer();
        // Log occasionally for debugging (only every 5 seconds)
        const now = Date.now();
        if (!activityHandler.lastLogTime || (now - activityHandler.lastLogTime) > 5000) {
          console.log(`Activity detected: ${eventType}`);
          activityHandler.lastLogTime = now;
        }
      }
    };
  };
  
  // Mouse events - capture on both document and window
  const mouseEvents = ['mousemove', 'mousedown', 'mouseup', 'click', 'wheel', 'contextmenu'];
  mouseEvents.forEach(eventType => {
    const handler = activityHandler(`mouse:${eventType}`);
    document.addEventListener(eventType, handler, { capture: true, passive: true });
    window.addEventListener(eventType, handler, { capture: true, passive: true });
  });
  
  // Keyboard events - capture on both document and window
  const keyboardEvents = ['keydown', 'keyup', 'keypress'];
  keyboardEvents.forEach(eventType => {
    const handler = activityHandler(`keyboard:${eventType}`);
    document.addEventListener(eventType, handler, { capture: true, passive: true });
    window.addEventListener(eventType, handler, { capture: true, passive: true });
  });
  
  // Also listen for focus events (user switching windows/apps)
  window.addEventListener('focus', activityHandler('window:focus'), { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isTracking && !pauseStartTime) {
      activityHandler('document:visible')();
    }
  }, { capture: true, passive: true });
  
  // Track mouse movements and keystrokes for statistics
  document.addEventListener('mousemove', () => {
    mouseMovementCount++;
  }, { capture: true, passive: true });
  
  document.addEventListener('keypress', () => {
    keystrokeCount++;
  }, { capture: true, passive: true });
}

// Reset idle timer when activity is detected
function resetIdleTimer() {
  if (!isTracking || pauseStartTime) return; // Don't reset if paused or not tracking
  
  // Update immediately (no debounce) to ensure activity is captured
  const now = Date.now();
  const timeSinceLastUpdate = now - lastActivityTime;
  
  // Only update if it's been at least 50ms since last update (light debounce to avoid spam)
  if (timeSinceLastUpdate > 50) {
    lastActivityTime = now;
    
    // Cancel any pending double-check if activity is detected
    if (idleDoubleCheckTimer) {
      clearTimeout(idleDoubleCheckTimer);
      idleDoubleCheckTimer = null;
      console.log(`Activity detected (${Math.floor(timeSinceLastUpdate / 1000)}s since last) - cancelled idle double-check`);
    }
  }
}

// Listen for system-wide activity from main process
// This is the PRIMARY method for detecting activity when user works in other apps
ipcRenderer.on('system-activity-detected', (event, idleSeconds) => {
  if (isTracking && !pauseStartTime) {
    // Update lastActivityTime directly for system-wide activity
    const now = Date.now();
    const timeSinceLastUpdate = now - lastActivityTime;
    const previousTime = lastActivityTime;
    lastActivityTime = now;
    
    // Log system activity (this is critical for debugging)
    if (timeSinceLastUpdate > 2000) { // Only log if it's been more than 2 seconds
      console.log(`✓ System-wide activity detected: ${Math.floor(timeSinceLastUpdate / 1000)}s since last (idle: ${idleSeconds ? idleSeconds.toFixed(1) : 'N/A'}s)`);
    }
    
    // Clear any pending double-check
    if (idleDoubleCheckTimer) {
      clearTimeout(idleDoubleCheckTimer);
      idleDoubleCheckTimer = null;
      console.log('System activity detected - cleared pending idle double-check');
    }
  }
});

// Setup activity listeners when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupActivityListeners);
} else {
  setupActivityListeners();
}

// IPC handlers for overlay
ipcRenderer.on('overlay-continue', () => {
  if (isTracking && pauseStartTime) {
    resumeTracking();
  }
});

ipcRenderer.on('overlay-stop', () => {
  if (isTracking) {
    stopTracking();
  }
});

async function checkAuth() {
  try {
    console.log('Checking authentication...');
    // Show loading state while checking
    loadingContainer.classList.remove('hidden');
    loginContainer.classList.add('hidden');
    dashboardContainer.classList.add('hidden');
    
    const { data: { session }, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error('Error checking session:', error);
      showLogin();
      return;
    }
    
    if (session) {
      console.log('Session found, user:', session.user.email);
      currentUser = session.user;
      showDashboard();
    } else {
      console.log('No session found, showing login');
      showLogin();
    }
  } catch (error) {
    console.error('Error in checkAuth:', error);
    showLogin();
  }
}

function showLogin() {
  if (loadingContainer) loadingContainer.classList.add('hidden');
  if (loginContainer) loginContainer.classList.remove('hidden');
  if (dashboardContainer) dashboardContainer.classList.add('hidden');
}

async function showDashboard() {
  if (loadingContainer) loadingContainer.classList.add('hidden');
  if (loginContainer) loginContainer.classList.add('hidden');
  if (dashboardContainer) dashboardContainer.classList.remove('hidden');
  
  // Fetch user profile to get full_name
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', currentUser.id)
      .single();
    
    if (profile && !error) {
      userProfile = profile;
      if (userNameSpan) {
      userNameSpan.textContent = profile.full_name || profile.email || 'User';
      }
    } else {
      if (userNameSpan) {
      userNameSpan.textContent = currentUser.email || 'User';
      }
    }
  } catch (error) {
    console.error('Error fetching user profile:', error);
    if (userNameSpan) {
    userNameSpan.textContent = currentUser.email || 'User';
    }
  }
  
  // Fetch projects assigned to user
  await loadProjects();
  
  // Setup network monitoring
  setupNetworkMonitoring();
  
  // Initialize day cycle and check for existing time entry
  currentDayCycle = getCurrentDayCycle();
  loadLastTimeEntry();
  
  // Start daily reset check
  startDailyResetCheck();
  
  // Start periodic sync check (every 60 seconds)
  if (syncInterval) {
    clearInterval(syncInterval);
  }
  syncInterval = setInterval(() => {
    if (isOnline && pendingUpdates.length > 0) {
      syncPendingUpdates();
    }
  }, 60000);
  
  // Check permissions once when dashboard loads (not on every start button click)
  checkAllPermissions();
  
  // Update start button state
  updateStartButtonState();
}

async function handleLogin(e) {
  e.preventDefault();
  errorMessage.textContent = '';

  const email = emailInput.value;
  const password = passwordInput.value;

  console.log('Attempting login for:', email);
  console.log('Supabase URL:', supabaseUrl);
  console.log('Supabase client initialized:', !!supabase);

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      console.error('Login error:', error);
      errorMessage.textContent = error.message || 'Login failed. Please check your credentials.';
      return;
    }

    console.log('Login successful, user:', data.user.email);
    currentUser = data.user;
    showDashboard();
  } catch (err) {
    console.error('Exception during login:', err);
    errorMessage.textContent = 'An error occurred during login. Please try again.';
  }
}

async function handleAzureSSO() {
  try {
    errorMessage.textContent = '';
    console.log('Initiating Azure SSO login...');
    
    // Show loading message
    errorMessage.textContent = 'Opening Azure SSO login in your browser...';
    errorMessage.style.color = '#3b82f6';
    
    // Set up listener for OAuth callback BEFORE opening browser
    setupAzureSSOCallback();
    
    // Request main process to open Azure SSO in system browser
    // The callback will be handled by a local HTTP server
    const result = await ipcRenderer.invoke('open-azure-sso-window', {
      redirectUrl: 'https://timeflow.mechlintech.com'
    });
    
    if (result.callbackUrl) {
      console.log('Callback URL:', result.callbackUrl);
      console.log('Your website should redirect to:', result.callbackUrl);
    }
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    // Update message
    errorMessage.textContent = 'Please complete login in your browser. Waiting for callback...';
    
  } catch (err) {
    console.error('Error initiating Azure SSO:', err);
    errorMessage.textContent = err.message || 'Failed to initiate Azure SSO login. Please try again.';
    errorMessage.style.color = '#ef4444';
  }
}

// Store callback listener reference so we can remove it if needed
let azureSsoCallbackListener = null;

function setupAzureSSOCallback() {
  // Remove existing listener if any
  if (azureSsoCallbackListener) {
    ipcRenderer.removeListener('azure-sso-callback', azureSsoCallbackListener);
  }
  
  // Create new listener
  azureSsoCallbackListener = async (event, callbackData) => {
    try {
      console.log('═══════════════════════════════════════════════════════');
      console.log('Renderer: Received Azure SSO callback');
      console.log('Callback data:', {
        has_access_token: !!callbackData.access_token,
        has_refresh_token: !!callbackData.refresh_token,
        has_url: !!callbackData.url,
        has_error: !!callbackData.error,
        success: callbackData.success
      });
      console.log('═══════════════════════════════════════════════════════');
      
      if (callbackData.error) {
        throw new Error(callbackData.error);
      }
      
      errorMessage.textContent = 'Completing authentication...';
      errorMessage.style.color = '#3b82f6';
      
      // Extract tokens from the callback URL (for custom protocol fallback)
      let accessToken = null;
      let refreshToken = null;
      
      if (callbackData.url) {
        try {
          const url = new URL(callbackData.url);
          
          // Check hash fragment first (Supabase OAuth uses hash)
          if (url.hash) {
            const hash = url.hash.substring(1); // Remove #
            const params = new URLSearchParams(hash);
            accessToken = params.get('access_token');
            refreshToken = params.get('refresh_token');
          }
          
          // If not in hash, check query params
          if (!accessToken) {
            accessToken = url.searchParams.get('access_token');
            refreshToken = url.searchParams.get('refresh_token');
          }
        } catch (parseError) {
          console.error('Error parsing callback URL:', parseError);
        }
      }
      
      // If we have tokens directly from callback data (preferred - from HTTP server)
      if (callbackData.access_token && callbackData.refresh_token) {
        accessToken = callbackData.access_token;
        refreshToken = callbackData.refresh_token;
        console.log('Using tokens from callback data (HTTP server)');
      }
      
      if (accessToken && refreshToken) {
        console.log('Setting Supabase session with tokens...');
        // Set session with tokens
        const { data, error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });
        
        if (error) {
          console.error('Error setting session:', error);
          throw error;
        }
        
        console.log('✅ Azure SSO login successful!');
        console.log('User email:', data.user?.email);
        currentUser = data.user;
        showDashboard();
        
        // Remove listener after successful login
        if (azureSsoCallbackListener) {
          ipcRenderer.removeListener('azure-sso-callback', azureSsoCallbackListener);
          azureSsoCallbackListener = null;
        }
        return;
      }
      
      // If we get here, we couldn't extract tokens
      throw new Error('Failed to extract authentication tokens from callback.');
      
    } catch (err) {
      console.error('❌ Error processing Azure SSO callback:', err);
      errorMessage.textContent = err.message || 'Failed to complete Azure SSO login. Please try again.';
      errorMessage.style.color = '#ef4444';
    }
  };
  
  // Add listener
  ipcRenderer.on('azure-sso-callback', azureSsoCallbackListener);
  console.log('✅ Azure SSO callback listener set up');
  
  // Set up timeout in case callback never arrives
  setTimeout(() => {
    if (loginContainer && !loginContainer.classList.contains('hidden')) {
      console.warn('⚠️ Azure SSO login timed out');
      errorMessage.textContent = 'Azure SSO login timed out. Please try again.';
      errorMessage.style.color = '#ef4444';
      
      // Remove listener on timeout
      if (azureSsoCallbackListener) {
        ipcRenderer.removeListener('azure-sso-callback', azureSsoCallbackListener);
        azureSsoCallbackListener = null;
      }
    }
  }, 5 * 60 * 1000); // 5 minute timeout
}

function handleMinimize() {
  // Request main process to minimize the window
  ipcRenderer.invoke('minimize-window');
}

async function handleClose() {
  // If tracking is active, stop tracking and save duration before closing
  if (isTracking) {
    console.log('Stopping tracking before closing application...');
    try {
      await stopTracking();
      // Give a small delay to ensure the database update completes
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error('Error stopping tracking before close:', error);
      // Still close even if there's an error, but log it
    }
  }
  
  // Request main process to close the window
  ipcRenderer.invoke('close-window');
}

async function handleLogout() {
  try {
    console.log('Logout initiated...');
    
  // Stop tracking and save state
  if (isTracking) {
      console.log('Stopping tracking before logout...');
    await stopTracking();
  }
  
    // Clear all intervals
  if (dailyResetCheckInterval) {
    clearInterval(dailyResetCheckInterval);
    dailyResetCheckInterval = null;
  }
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleDoubleCheckTimer) {
      clearTimeout(idleDoubleCheckTimer);
      idleDoubleCheckTimer = null;
    }
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
    if (realTimeUpdateInterval) {
      clearInterval(realTimeUpdateInterval);
      realTimeUpdateInterval = null;
    }
    if (systemActivitySyncInterval) {
      clearInterval(systemActivitySyncInterval);
      systemActivitySyncInterval = null;
    }
    
    // Sign out from Supabase
    console.log('Signing out from Supabase...');
    const { error: signOutError } = await supabase.auth.signOut();
    
    if (signOutError) {
      console.error('Error signing out:', signOutError);
      // Continue with logout even if signOut fails
    }
    
    // Clear all state
  currentUser = null;
  isTracking = false;
    projects = [];
    tasks = [];
    selectedProjectId = null;
    selectedTaskId = null;
    timeEntryId = null;
    sessionStartTime = null;
    pauseStartTime = null;
    pausedDuration = 0;
    baseDuration = 0;
    baseDurationAtSessionStart = 0;
    lastActivityTime = Date.now();
    
    // Clear UI
    if (emailInput) emailInput.value = '';
    if (passwordInput) passwordInput.value = '';
    if (timerDisplay) timerDisplay.textContent = '00:00:00';
    if (statusDisplay) {
      statusDisplay.textContent = 'Not Tracking';
      statusDisplay.classList.remove('tracking');
    }
    
    // Show login screen
    console.log('Showing login screen...');
  showLogin();
    
    console.log('Logout completed successfully');
  } catch (error) {
    console.error('Error during logout:', error);
    // Still try to show login screen even if there's an error
    showLogin();
  }
}

// Helper function to link time entry to project via project_time_entries table
async function linkTimeEntryToProject(timeEntryId, projectId) {
  if (!timeEntryId || !projectId || !isOnline) return;

  try {
    // Check if link already exists
    const { data: existingLink } = await supabase
      .from('project_time_entries')
      .select('id')
      .eq('time_entry_id', timeEntryId)
      .single();

    if (existingLink) {
      // Update existing link
      const { error } = await supabase
        .from('project_time_entries')
        .update({ project_id: projectId })
        .eq('time_entry_id', timeEntryId);

      if (error) {
        console.error('Error updating project_time_entries:', error);
      }
    } else {
      // Create new link
      const { error } = await supabase
        .from('project_time_entries')
        .insert({
          time_entry_id: timeEntryId,
          project_id: projectId,
          billable: true
        });

      if (error) {
        console.error('Error creating project_time_entries:', error);
      }
    }
  } catch (error) {
    console.error('Error linking time entry to project:', error);
  }
}

// Fetch projects assigned to the current user
async function loadProjects() {
  if (!currentUser) {
    console.log('No current user, skipping loadProjects');
    return;
  }

  if (!projectSelect) {
    console.error('projectSelect element not found, cannot load projects');
    return;
  }

  try {
    console.log('Loading projects for user:', currentUser.id);
    
    // Query project_members table (not project_user_assignments)
    const { data: memberships, error: membershipsError } = await supabase
      .from('project_members')
      .select(`
        project_id,
        projects (
          id,
          name,
          description,
          task_id,
          status
        )
      `)
      .eq('user_id', currentUser.id);

    if (membershipsError) {
      console.error('Error fetching project memberships:', membershipsError);
      console.error('Error code:', membershipsError.code);
      console.error('Error message:', membershipsError.message);
      
      const errorMsg = membershipsError.message || '';
      if (errorMsg.includes('does not exist') || errorMsg.includes('relation')) {
        if (projectSelect) {
          projectSelect.innerHTML = '<option value="">⚠ project_members table not found</option>';
        }
        console.error('❌ project_members table does not exist');
        return;
      }
      
      if (projectSelect) {
        const shortMsg = errorMsg.substring(0, 60);
        projectSelect.innerHTML = `<option value="">Error: ${shortMsg}...</option>`;
      }
      return;
    }

    // Extract projects from memberships
    projects = (memberships || [])
      .map(membership => membership.projects)
      .filter(project => project !== null && project.status === 'active'); // Only show active projects

    console.log('Loaded projects:', projects);

    // Populate project dropdown
    if (projectSelect) {
      projectSelect.innerHTML = '<option value="">Select a project...</option>';
      
      if (projects.length === 0) {
        projectSelect.innerHTML = '<option value="">No projects assigned</option>';
        console.warn('No projects found for user:', currentUser.id);
      } else {
        projects.forEach(project => {
          const option = document.createElement('option');
          option.value = project.id;
          option.textContent = project.name;
          projectSelect.appendChild(option);
        });
      }
    }

    // Reset task selection
    if (taskSelect) {
      taskSelect.innerHTML = '<option value="">Select a task...</option>';
      taskSelect.disabled = true;
    }
    tasks = [];
    selectedProjectId = null;
    selectedTaskId = null;
    updateTaskDisplay();
  } catch (error) {
    console.error('Error loading projects:', error);
    if (projectSelect) {
      projectSelect.innerHTML = '<option value="">Error loading projects</option>';
    }
  }
}

// Fetch tasks - in this schema, tasks are standalone (not linked to projects)
// Projects have a task_id field, but we'll show all available tasks
async function loadTasks(projectId) {
  if (!projectId) {
    tasks = [];
    if (taskSelect) {
      taskSelect.innerHTML = '<option value="">Select a task...</option>';
      taskSelect.disabled = true;
    }
    return;
  }

  if (!taskSelect) {
    console.error('taskSelect element not found, cannot load tasks');
    return;
  }

  try {
    console.log('Loading tasks (all available tasks)');
    
    // Fetch all tasks (they're not project-specific in this schema)
    const { data: allTasks, error } = await supabase
      .from('tasks')
      .select('id, name, category')
      .order('name');

    if (error) {
      console.error('Error fetching tasks:', error);
      if (taskSelect) {
        taskSelect.innerHTML = '<option value="">Error loading tasks</option>';
      }
      return;
    }

    tasks = allTasks || [];
    console.log('Loaded tasks:', tasks);

    // Populate task dropdown
    if (taskSelect) {
      taskSelect.innerHTML = '<option value="">Select a task...</option>';
      
      if (tasks.length === 0) {
        taskSelect.innerHTML = '<option value="">No tasks available</option>';
        console.warn('No tasks found');
      } else {
        tasks.forEach(task => {
          const option = document.createElement('option');
          option.value = task.id;
          option.textContent = task.name;
          taskSelect.appendChild(option);
        });
      }

      taskSelect.disabled = false;
    }
  } catch (error) {
    console.error('Error loading tasks:', error);
    if (taskSelect) {
      taskSelect.innerHTML = '<option value="">Error loading tasks</option>';
    }
  }
}

// Handle project selection change
async function handleProjectChange(event) {
  if (!event || !event.target) return;
  
  const projectId = event.target.value;
  selectedProjectId = projectId || null;
  selectedTaskId = null;
  
  if (taskSelect) {
    taskSelect.value = '';
  }

  if (projectId) {
    await loadTasks(projectId);
    const selectedProject = projects.find(p => p.id === projectId);
    if (selectedProject && taskNameDisplay && taskTagDisplay) {
      taskNameDisplay.textContent = selectedProject.name;
      taskTagDisplay.textContent = 'Select a task';
    }
  } else {
    tasks = [];
    if (taskSelect) {
      taskSelect.innerHTML = '<option value="">Select a task...</option>';
      taskSelect.disabled = true;
    }
    if (taskNameDisplay && taskTagDisplay) {
      taskNameDisplay.textContent = 'Select a project and task';
      taskTagDisplay.textContent = 'No project selected';
    }
  }

  updateStartButtonState();
  updateTaskDisplay();
}

// Handle task selection change
function handleTaskChange(event) {
  if (!event || !event.target) return;
  
  selectedTaskId = event.target.value || null;
  updateTaskDisplay();
  updateStartButtonState();
}

// Update task display in the UI
function updateTaskDisplay() {
  if (!taskNameDisplay || !taskTagDisplay) {
    console.warn('Task display elements not found');
    return;
  }

  if (selectedProjectId && selectedTaskId) {
    const selectedProject = projects.find(p => p.id === selectedProjectId);
    const selectedTask = tasks.find(t => t.id === selectedTaskId);
    
    if (selectedProject && selectedTask) {
      taskNameDisplay.textContent = selectedTask.name;
      taskTagDisplay.textContent = selectedProject.name;
    }
  } else if (selectedProjectId) {
    const selectedProject = projects.find(p => p.id === selectedProjectId);
    if (selectedProject) {
      taskNameDisplay.textContent = selectedProject.name;
      taskTagDisplay.textContent = 'Select a task';
    }
  } else {
    taskNameDisplay.textContent = 'Select a project and task';
    taskTagDisplay.textContent = 'No project selected';
  }
}

// Update start button state based on selections
function updateStartButtonState() {
  if (selectedProjectId && selectedTaskId && !isTracking) {
    startBtn.disabled = false;
    startBtn.title = 'Start Tracking';
  } else if (isTracking) {
    startBtn.disabled = true;
  } else {
    startBtn.disabled = true;
    startBtn.title = 'Please select a project and task to start tracking';
  }
}

/**
 * Loads the last time entry from Supabase for the current day cycle
 * This ensures the tracker continues from where it left off, rather than starting from 0
 * Checks both local storage (for offline support) and Supabase (for latest data)
 */
async function loadLastTimeEntry() {
  if (!currentUser) {
    console.log('No current user, skipping loadLastTimeEntry');
    return;
  }
  
  console.log('🔄 Loading last time entry for current day cycle...');

  // Check if we need to reset (new day cycle)
  const newDayCycle = getCurrentDayCycle();
  if (currentDayCycle && currentDayCycle.dateString !== newDayCycle.dateString) {
    // New day cycle - reset everything
    console.log('New day cycle detected, resetting:', {
      old: currentDayCycle.dateString,
      new: newDayCycle.dateString
    });
    
    // Clear old local storage data
    if (currentUser) {
      clearLocalStorage(currentUser.id, currentDayCycle.dateString);
    }
    
    currentDayCycle = newDayCycle;
    baseDuration = 0;
    baseDurationAtSessionStart = 0;
    timeEntryId = null;
    updateDayCycleDisplay();
    updateTimerDisplay(0);
    return;
  }

  currentDayCycle = newDayCycle;

  // Get profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('id', currentUser.id)
    .single();

  if (!profile) {
    console.error('Profile not found');
    return;
  }

  // Load from local storage first (offline data)
  const localData = loadFromLocalStorage(currentUser.id, currentDayCycle.dateString);
  let localDuration = 0;
  let localTimeEntryId = null;
  
  if (localData) {
    localDuration = localData.duration || 0;
    localTimeEntryId = localData.timeEntryId || null;
  }

  // Try to fetch from Supabase (if online)
  let remoteDuration = 0;
  let remoteTimeEntryId = null;
  
  if (isOnline) {
    try {
      // Query for entries that fall within the current day cycle
      // Check both start_time and updated_at to catch all entries for this cycle
      const cycleStartISO = currentDayCycle.start.toISOString();
      const cycleEndISO = currentDayCycle.end.toISOString();
      
      // First, try to find entries where start_time is within the cycle
      const { data: timeEntriesByStart, error: error1 } = await supabase
        .from('time_entries')
        .select('id, user_id, start_time, end_time, duration, created_at, updated_at')
        .eq('user_id', profile.id)
        .gte('start_time', cycleStartISO)
        .lte('start_time', cycleEndISO)
        .order('updated_at', { ascending: false })
        .limit(10);

      // Also check entries that were updated during this cycle
      // This catches entries that might have been started earlier but are being tracked in this cycle
      const { data: timeEntriesByUpdate, error: error2 } = await supabase
        .from('time_entries')
        .select('id, user_id, start_time, end_time, duration, created_at, updated_at')
        .eq('user_id', profile.id)
        .gte('updated_at', cycleStartISO)
        .lte('updated_at', cycleEndISO)
        .order('updated_at', { ascending: false })
        .limit(10);

      // Combine and deduplicate entries
      const allEntries = [];
      const entryIds = new Set();
      
      if (!error1 && timeEntriesByStart) {
        timeEntriesByStart.forEach(entry => {
          if (!entryIds.has(entry.id)) {
            entryIds.add(entry.id);
            allEntries.push(entry);
          }
        });
      }
      
      if (!error2 && timeEntriesByUpdate) {
        timeEntriesByUpdate.forEach(entry => {
          if (!entryIds.has(entry.id)) {
            entryIds.add(entry.id);
            allEntries.push(entry);
          }
        });
      }

      if (allEntries.length > 0) {
        // Sort by updated_at descending to get the most recent
        allEntries.sort((a, b) => {
          const aTime = new Date(a.updated_at || a.created_at).getTime();
          const bTime = new Date(b.updated_at || b.created_at).getTime();
          return bTime - aTime;
        });
        
        // Use the most recent entry for this cycle
        const matchingEntry = allEntries[0];
        remoteDuration = matchingEntry.duration || 0;
        remoteTimeEntryId = matchingEntry.id;
        
        // Restore project from project_time_entries if it exists
        if (isOnline && matchingEntry.id) {
          const { data: projectLink } = await supabase
            .from('project_time_entries')
            .select('project_id')
            .eq('time_entry_id', matchingEntry.id)
            .single();

          if (projectLink && projectLink.project_id) {
            selectedProjectId = projectLink.project_id;
            if (projectSelect) {
              projectSelect.value = projectLink.project_id;
            }
            await loadTasks(projectLink.project_id);
            
            // Try to get task from project
            const { data: projectData } = await supabase
              .from('projects')
              .select('task_id')
              .eq('id', projectLink.project_id)
              .single();

            if (projectData && projectData.task_id) {
              selectedTaskId = projectData.task_id;
              if (taskSelect) {
                taskSelect.value = projectData.task_id;
              }
              updateTaskDisplay();
            }
          }
        }
        
        console.log('✅ Loaded time entry for current cycle:', {
          id: matchingEntry.id,
          duration: remoteDuration,
          durationFormatted: formatDurationFromSeconds(remoteDuration),
          start_time: matchingEntry.start_time,
          updated_at: matchingEntry.updated_at,
          cycle_start: cycleStartISO,
          cycle_end: cycleEndISO,
          cycle_date: currentDayCycle.dateString
        });
      } else {
        console.log('ℹ️ No time entry found for current day cycle:', currentDayCycle.dateString);
        if (error1) console.error('Error querying by start_time:', error1);
        if (error2) console.error('Error querying by updated_at:', error2);
      }
    } catch (error) {
      console.error('❌ Error fetching time entries:', error);
      isOnline = false; // Mark as offline if fetch fails
    }
  }

  // Validate that we're using the correct day cycle
  // If local storage has data for a different day, clear it
  if (localData && localData.dateString && localData.dateString !== currentDayCycle.dateString) {
    console.log('Local storage data is for a different day cycle, clearing it');
    clearLocalStorage(currentUser.id, localData.dateString);
    localDuration = 0;
    localTimeEntryId = null;
  }

  // Use the MAXIMUM duration (never reduce time)
  baseDuration = ensureMaxDuration(localDuration, remoteDuration);
  
  // Validate duration - it should not exceed the time since cycle start
  // But allow some buffer (e.g., if user was tracking and paused, duration can be close to max)
  const now = new Date();
  const maxPossibleDuration = Math.floor((now - currentDayCycle.start) / 1000); // in seconds
  const bufferSeconds = 300; // 5 minute buffer to account for pauses, etc.
  
  if (baseDuration > (maxPossibleDuration + bufferSeconds)) {
    console.warn('Duration exceeds maximum possible for current cycle (with buffer), resetting:', {
      baseDuration,
      maxPossibleDuration,
      buffer: bufferSeconds,
      cycleStart: currentDayCycle.start.toISOString()
    });
    // Reset to 0 if duration is clearly wrong
    baseDuration = 0;
    baseDurationAtSessionStart = 0;
    timeEntryId = null;
    // Clear local storage for this cycle
    clearLocalStorage(currentUser.id, currentDayCycle.dateString);
  } else if (baseDuration > maxPossibleDuration) {
    // If slightly over (within buffer), cap it to max possible
    console.log('Capping duration to maximum possible:', {
      baseDuration,
      maxPossibleDuration
    });
    baseDuration = maxPossibleDuration;
  }
  
  // Use remote timeEntryId if available, otherwise use local
  timeEntryId = remoteTimeEntryId || localTimeEntryId;

  // If local duration is higher, we need to sync it
  if (localDuration > remoteDuration && isOnline && timeEntryId && baseDuration <= maxPossibleDuration) {
    // Sync the higher duration to Supabase
    await syncDurationToSupabase(timeEntryId, baseDuration);
  }

  // Save to local storage for offline access (include dateString for validation)
  saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
    duration: baseDuration,
    timeEntryId: timeEntryId,
    dateString: currentDayCycle.dateString // Store dateString for validation
  });
  
  console.log('Duration loaded:', {
    localDuration,
    remoteDuration,
    baseDuration,
    maxPossibleDuration,
    dateString: currentDayCycle.dateString,
    cycleStart: currentDayCycle.start.toISOString(),
    currentTime: now.toISOString()
  });
  
  // Update display with saved duration
  updateDayCycleDisplay();
  updateTimerDisplay(baseDuration);
  
  // Restore project and task from local storage if available
  if (localData && localData.projectId) {
    selectedProjectId = localData.projectId;
    projectSelect.value = localData.projectId;
    await loadTasks(localData.projectId);
    
    if (localData.taskId) {
      selectedTaskId = localData.taskId;
      taskSelect.value = localData.taskId;
    }
    updateTaskDisplay();
  }
  
  // Update start button state
  updateStartButtonState();
}

// Permission checking functions
async function checkCameraPermission() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { granted: false, error: 'Camera API not available' };
    }

    // Check if we can enumerate devices first (this doesn't require permission)
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      if (videoDevices.length === 0) {
        return { granted: false, error: 'No camera device found' };
      }
    } catch (enumError) {
      console.log('Could not enumerate devices:', enumError);
      // Continue anyway, might still work
    }

    // Try to get camera access with a longer timeout (10 seconds)
    // This gives more time for camera initialization, especially if it's being used by another app
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 }
        } 
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Camera access timeout')), 10000)
      )
    ]);
    
    // If successful, stop the stream immediately
    if (stream && stream.getTracks) {
      stream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
    }
    
    return { granted: true };
  } catch (error) {
    // Log detailed error information
    const errorDetails = {
      name: error.name,
      message: error.message,
      constraint: error.constraint,
      toString: error.toString()
    };
    console.log('Camera permission check result:', errorDetails);
    
    // Handle specific error types
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return { granted: false, error: 'Permission denied. Please allow camera access in your system settings.' };
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return { granted: false, error: 'No camera device found' };
    } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      // Camera might be in use by another application
      return { granted: true, error: 'Camera may be in use by another application, but permission appears granted' };
    } else if (error.message && error.message.includes('timeout')) {
      // Timeout usually means permission is granted but camera is slow/unavailable
      // Allow tracking to proceed since permission is likely granted
      return { granted: true, error: 'Camera access timeout - permission appears granted but camera may be slow or in use. You can proceed with tracking.' };
    } else {
      // For other errors, assume permission might be granted but there's a technical issue
      // This allows the user to proceed if they know permission is granted
      console.warn('Camera check returned error, but permission may still be granted:', errorDetails);
      return { granted: true, error: `Camera check warning: ${error.message || error.name || 'Unknown error'}. Permission may still be granted.` };
    }
  }
}

async function checkScreenshotPermission() {
  try {
    // Try to capture a test screenshot - use buffer method to avoid file copy issues
    const testBuffer = await screenshot({ format: 'png' });
    
    if (testBuffer && testBuffer.length > 0) {
      return { granted: true };
    } else {
      return { granted: false, error: 'Screenshot capture returned empty buffer' };
    }
  } catch (error) {
    console.log('Screenshot permission check result:', error.message || error);
    return { granted: false, error: error.message || 'Screenshot capture failed' };
  }
}

function getOSInstructions() {
  const platform = os.platform();
  if (platform === 'win32') {
    return {
      camera: [
        'Open Windows Settings (Win + I)',
        'Go to Privacy → Camera',
        'Make sure "Allow apps to access your camera" is ON',
        'Scroll down and ensure "Time Flow" or "Electron" is allowed',
        'Restart the application after enabling'
      ],
      screenshot: [
        'Open Windows Settings (Win + I)',
        'Go to Privacy → Screen recording (Windows 10/11)',
        'Make sure screen recording is enabled for desktop apps',
        'If prompted, allow the application to record your screen',
        'Note: Some antivirus software may block screenshot functionality'
      ]
    };
  } else if (platform === 'darwin') {
    return {
      camera: [
        'Open System Preferences → Security & Privacy',
        'Go to the Privacy tab',
        'Select Camera from the left sidebar',
        'Check the box next to "Time Flow" or "Electron"',
        'Restart the application after enabling'
      ],
      screenshot: [
        'Open System Preferences → Security & Privacy',
        'Go to the Privacy tab',
        'Select Screen Recording from the left sidebar',
        'Check the box next to "Time Flow" or "Electron"',
        'Restart the application after enabling'
      ]
    };
  } else {
    return {
      camera: [
        'Check your system privacy settings',
        'Ensure camera access is granted to the application',
        'You may need to grant permissions through your desktop environment settings'
      ],
      screenshot: [
        'Check your system privacy settings',
        'Ensure screen recording/screenshot permissions are granted',
        'You may need to grant permissions through your desktop environment settings'
      ]
    };
  }
}

function updatePermissionUI(type, granted, error) {
  // UI removed - permissions still checked in background
  // Log permission status for debugging
  const isGranted = granted || (error && error.includes('may still be granted'));
  if (isGranted) {
    console.log(`${type} permission: Granted`);
  } else {
    console.warn(`${type} permission: Not granted - ${error || 'Unknown error'}`);
  }
}

async function checkAllPermissions() {
  // Check permissions in background (UI removed)
  console.log('Checking permissions...');
  
  // Check camera permission
  const cameraResult = await checkCameraPermission();
  updatePermissionUI('camera', cameraResult.granted, cameraResult.error);
  
  // Check screenshot permission
  const screenshotResult = await checkScreenshotPermission();
  updatePermissionUI('screenshot', screenshotResult.granted, screenshotResult.error);
  
  // Enable/disable start button based on permissions AND project/task selection
  // Allow starting if camera permission appears granted (even with warnings)
  // This handles cases where permission is granted but camera check has technical issues
  const cameraOk = cameraResult.granted || (cameraResult.error && cameraResult.error.includes('may still be granted'));
  const permissionsOk = cameraOk && screenshotResult.granted;
  
  // Update start button state (will check both permissions and project/task selection)
  updateStartButtonState();
  
  if (!permissionsOk) {
    startBtn.title = 'Please enable camera and screenshot permissions to start tracking';
  }
  
  return {
    camera: cameraResult.granted,
    screenshot: screenshotResult.granted
  };
}

async function startTracking() {
  if (isTracking) return;

  // Validate that project and task are selected
  if (!selectedProjectId || !selectedTaskId) {
    alert('Please select a project and task before starting tracking.');
    return;
  }

  // Check if day cycle has changed
  const newDayCycle = getCurrentDayCycle();
  if (currentDayCycle && currentDayCycle.dateString !== newDayCycle.dateString) {
    // New day cycle - reset and reload
    currentDayCycle = newDayCycle;
    baseDuration = 0;
    baseDurationAtSessionStart = 0;
    timeEntryId = null;
    await loadLastTimeEntry();
  }

  isTracking = true;
  sessionStartTime = new Date();
  baseDurationAtSessionStart = baseDuration; // Store base duration at session start
  pausedDuration = 0;
  pauseStartTime = null;
  lastActivityTime = Date.now(); // Initialize with current time
  console.log('Tracking started - lastActivityTime initialized to:', new Date(lastActivityTime).toLocaleTimeString());
  mouseMovementCount = 0;
  keystrokeCount = 0;

  // Get profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('id', currentUser.id)
    .single();

  if (!profile) {
    console.error('Profile not found');
    return;
  }

  // If we have an existing time entry for this day cycle, update it
  // Otherwise, create a new one
  if (timeEntryId) {
    // Update existing entry - resume tracking
    if (isOnline) {
      try {
        const { error } = await supabase
          .from('time_entries')
          .update({
            end_time: null, // Clear end_time to indicate active tracking
            updated_at: sessionStartTime.toISOString()
          })
          .eq('id', timeEntryId);

        if (error) {
          console.error('Error updating time entry:', error);
          isOnline = false;
        } else {
          // Update or create project_time_entries link
          await linkTimeEntryToProject(timeEntryId, selectedProjectId);
        }
      } catch (error) {
        console.error('Error updating time entry:', error);
        isOnline = false;
      }
    }
    // Save to local storage regardless of online status
    saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
      duration: baseDuration,
      timeEntryId: timeEntryId,
      projectId: selectedProjectId,
      taskId: selectedTaskId
    });
  } else {
    // Create new time entry for this day cycle
    // Use the actual session start time as the entry start_time
    if (isOnline) {
      try {
        const { data: timeEntry, error } = await supabase
          .from('time_entries')
          .insert({
            user_id: profile.id,
            start_time: sessionStartTime.toISOString(),
            duration: baseDuration // Start with cumulative duration (should be 0 for new day)
          })
          .select()
          .single();

        if (error) {
          console.error('Error creating time entry:', error);
          isOnline = false;
        } else {
          timeEntryId = timeEntry.id;
          // Link time entry to project via project_time_entries
          await linkTimeEntryToProject(timeEntryId, selectedProjectId);
        }
      } catch (error) {
        console.error('Error creating time entry:', error);
        isOnline = false;
      }
    }
    
    // Save to local storage regardless
    saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
      duration: baseDuration,
      timeEntryId: timeEntryId,
      projectId: selectedProjectId,
      taskId: selectedTaskId
    });
  }

  await ipcRenderer.invoke('set-is-tracking', true);

  // Update UI
  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  startBtn.disabled = true;
  stopBtn.disabled = false;
  projectSelect.disabled = true; // Disable project selection while tracking
  taskSelect.disabled = true; // Disable task selection while tracking
  statusDisplay.textContent = 'Tracking';
  statusDisplay.classList.add('tracking');

  // Start timer
  startTimer();

  // Ensure activity listeners are set up
  setupActivityListeners();

  // Start inactivity detection
  startIdleDetection();
  
  // Also periodically sync with system activity (fallback)
  // This ensures we don't miss activity even if IPC messages are delayed
  if (systemActivitySyncInterval) {
    clearInterval(systemActivitySyncInterval);
  }
  systemActivitySyncInterval = setInterval(() => {
    // Request current system activity status from main process
    if (isTracking && !pauseStartTime) {
      ipcRenderer.invoke('get-system-idle-time').then(idleSeconds => {
        // Only update if system clearly shows user is active (idle < 2 minutes)
        // This prevents the fallback from interfering with inactivity detection
        if (idleSeconds !== null && idleSeconds < 2 * 60) {
          // User is active (idle less than 2 minutes)
          const now = Date.now();
          const timeSinceLastUpdate = now - lastActivityTime;
          // Update more frequently (every 2 seconds) to catch activity quickly
          if (timeSinceLastUpdate > 2000) {
            lastActivityTime = now;
            // Log occasionally
            if (timeSinceLastUpdate > 10000) {
              console.log(`Fallback sync: System activity detected - idle=${idleSeconds.toFixed(1)}s, updated lastActivityTime`);
            }
            
            // Clear any pending double-check
            if (idleDoubleCheckTimer) {
              clearTimeout(idleDoubleCheckTimer);
              idleDoubleCheckTimer = null;
              console.log('Fallback sync: Cleared pending idle double-check');
            }
          }
        }
      }).catch(err => {
        // On error, don't update - rely on other activity detection methods
        // The main activity listeners will catch real activity
      });
    }
  }, 2000); // Check every 2 seconds (more frequent for better reliability)

  // Start periodic captures (every 30 seconds)
  startPeriodicCaptures();

  // Start real-time updates (every 30 seconds)
  startRealTimeUpdates();
}

async function stopTracking() {
  if (!isTracking) return;
  if (isStoppingTracking) {
    console.warn('stopTracking already in progress, ignoring duplicate call');
    return;
  }

  // Set flag to prevent race conditions
  isStoppingTracking = true;

  // IMPORTANT: Set isTracking to false FIRST to prevent real-time updates from interfering
  isTracking = false;
  await ipcRenderer.invoke('set-is-tracking', false);

  // Clear intervals IMMEDIATELY to prevent any race conditions
  if (realTimeUpdateInterval) {
    clearInterval(realTimeUpdateInterval);
    realTimeUpdateInterval = null;
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (idleDoubleCheckTimer) {
    clearTimeout(idleDoubleCheckTimer);
    idleDoubleCheckTimer = null;
  }
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (systemActivitySyncInterval) {
    clearInterval(systemActivitySyncInterval);
    systemActivitySyncInterval = null;
  }
  
  // Wait a brief moment to ensure any pending async operations complete
  await new Promise(resolve => setTimeout(resolve, 100));

  // Calculate session duration (subtract paused time)
  const endTime = new Date();
  let sessionDuration = 0;
  
  if (sessionStartTime) {
    // Calculate session duration accurately
    const now = Date.now();
    
    // If tracking was paused (modal was open), add that time to pausedDuration
    if (pauseStartTime) {
      pausedDuration += now - pauseStartTime;
      pauseStartTime = null;
    }
    
    // Calculate total session time and subtract paused time
    const totalSessionTime = Math.floor((now - sessionStartTime.getTime()) / 1000); // in seconds
    const pausedTimeSeconds = Math.floor(pausedDuration / 1000);
    sessionDuration = totalSessionTime - pausedTimeSeconds;
    if (sessionDuration < 0) sessionDuration = 0;
    
    console.log(`Stop tracking - Session duration calculation:`, {
      totalSessionTime,
      pausedTimeSeconds,
      sessionDuration,
      baseDurationAtSessionStart,
      sessionStartTime: sessionStartTime.toISOString(),
      endTime: endTime.toISOString()
    });
  } else {
    console.warn('Stop tracking called but sessionStartTime is null - duration may be incorrect');
  }

  // Calculate cumulative duration using baseDurationAtSessionStart to prevent double-counting
  const cumulativeDuration = baseDurationAtSessionStart + sessionDuration;
  
  console.log(`Stop tracking - Cumulative duration: ${cumulativeDuration} seconds (base: ${baseDurationAtSessionStart}, session: ${sessionDuration})`);

  // Ensure duration never decreases - get current max from local/remote
  const localData = loadFromLocalStorage(currentUser.id, currentDayCycle.dateString);
  const currentMax = localData ? Math.max(localData.duration || 0, baseDuration) : baseDuration;
  let finalDuration = ensureMaxDuration(currentMax, cumulativeDuration);
  
  // Safety check: If tracking was active but duration is 0, something went wrong
  // Use the currentMax as a fallback to prevent losing existing duration
  if (finalDuration === 0 && currentMax > 0) {
    console.warn('Warning: Calculated duration is 0 but currentMax is', currentMax, '- using currentMax as fallback');
    finalDuration = currentMax;
  }
  
  // Additional safety: If we have a sessionStartTime but duration is 0, calculate minimum 1 second
  if (finalDuration === 0 && sessionStartTime && sessionDuration === 0) {
    const minDuration = Math.max(1, Math.floor((Date.now() - sessionStartTime.getTime()) / 1000));
    if (minDuration > 0) {
      console.warn('Warning: Session duration calculated as 0, using minimum duration:', minDuration);
      finalDuration = baseDurationAtSessionStart + minDuration;
    }
  }

  // Save to local storage first (works offline)
  saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
    duration: finalDuration,
    timeEntryId: timeEntryId
  });

  // Sync duration to Supabase when stopping
  console.log('Stopping tracking - syncing final duration to Supabase...');
  if (timeEntryId) {
    if (isOnline) {
      try {
        // First, fetch current duration from Supabase to ensure we don't reduce it
        const { data: currentEntry, error: fetchError } = await supabase
          .from('time_entries')
          .select('duration, updated_at')
          .eq('id', timeEntryId)
          .single();

        if (fetchError) {
          console.error('Error fetching current duration before update:', fetchError);
          // Still try to update with our calculated duration
        }

        const remoteDuration = currentEntry?.duration || 0;
        console.log(`📊 Current state in database before update: duration=${remoteDuration}s, updated_at=${currentEntry?.updated_at || 'N/A'}`);
        
        const maxDuration = ensureMaxDuration(remoteDuration, finalDuration);
        
        // If remote duration is suspiciously low (like 15 seconds) but we calculated much more, log a warning
        if (remoteDuration < 60 && finalDuration > 300) {
          console.warn(`⚠️ SUSPICIOUS: Database has ${remoteDuration}s but we calculated ${finalDuration}s. This might indicate another process is overwriting values.`);
        }
        
        console.log(`Stop tracking - Updating Supabase:`, {
          timeEntryId,
          remoteDuration,
          finalDuration,
          maxDuration,
          formatted: formatDurationFromSeconds(maxDuration)
        });

        // CRITICAL: Verify isTracking is still false before updating (prevent race condition)
        if (isTracking) {
          console.warn('WARNING: isTracking became true during stopTracking - aborting update to prevent race condition');
          isStoppingTracking = false; // Reset flag before returning
          return;
        }

        // CRITICAL: Ensure we're saving the correct duration - log all values for debugging
        console.log('🔵 About to save to Supabase:', {
          timeEntryId,
          calculatedFinalDuration: finalDuration,
          remoteDurationFromDB: remoteDuration,
          maxDurationToSave: maxDuration,
          sessionDuration,
          baseDurationAtSessionStart,
          cumulativeDuration,
          formatted: formatDurationFromSeconds(maxDuration)
        });

        // Retry mechanism to ensure the duration is saved correctly
        let updateSuccess = false;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (!updateSuccess && retryCount < maxRetries) {
          retryCount++;
          console.log(`Attempting to save duration (attempt ${retryCount}/${maxRetries}): ${maxDuration} seconds`);
          
          // Use a timestamp to ensure we're the latest update
          const updateTimestamp = new Date().toISOString();
          
          const { data: updateData, error } = await supabase
            .from('time_entries')
            .update({
              end_time: null, // Always NULL, even when stopping
              duration: maxDuration,
              updated_at: updateTimestamp
            })
            .eq('id', timeEntryId)
            .select('duration, updated_at'); // Request the updated data back
          
          if (updateData && updateData.length > 0) {
            console.log(`Update response data:`, updateData[0]);
            if (updateData[0].duration !== maxDuration) {
              console.error(`⚠️ Update returned wrong duration! Expected ${maxDuration}, got ${updateData[0].duration}`);
            }
          }
          
          if (error) {
            console.error(`Error updating time entry on stop (attempt ${retryCount}):`, error);
            if (retryCount >= maxRetries) {
              // Queue for retry when online
              pendingUpdates.push({
                timeEntryId: timeEntryId,
                duration: finalDuration,
                endTime: null // Always NULL
              });
              isOnline = false;
              break;
            }
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          
          // Wait a moment for the update to propagate
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Verify the update was successful by fetching the updated record
          const { data: verifyEntry, error: verifyError } = await supabase
            .from('time_entries')
            .select('duration, end_time, updated_at')
            .eq('id', timeEntryId)
            .single();
          
          if (verifyError) {
            console.error(`Error verifying time entry update (attempt ${retryCount}):`, verifyError);
            if (retryCount >= maxRetries) {
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          
          console.log(`✓ Verification (attempt ${retryCount}): Duration in DB = ${verifyEntry.duration} seconds, Expected = ${maxDuration} seconds`);
          
          if (verifyEntry.duration === maxDuration) {
            console.log(`✅ SUCCESS: Duration correctly saved to Supabase: ${formatDurationFromSeconds(maxDuration)} (${maxDuration} seconds)`);
            updateSuccess = true;
          } else {
            console.error(`⚠️ WARNING: Duration mismatch on attempt ${retryCount}! Expected ${maxDuration}, got ${verifyEntry.duration}`);
            if (retryCount < maxRetries) {
              console.log(`Retrying update...`);
              await new Promise(resolve => setTimeout(resolve, 500));
            } else {
              console.error(`❌ FAILED: Could not save correct duration after ${maxRetries} attempts. Final value in DB: ${verifyEntry.duration} seconds`);
              // Try one more time with a more aggressive approach
              console.log('Attempting final aggressive update...');
              const { error: finalError } = await supabase
                .from('time_entries')
                .update({
                  duration: maxDuration,
                  end_time: null, // Always NULL, even when stopping
                  updated_at: new Date().toISOString()
                })
                .eq('id', timeEntryId);
              
              if (finalError) {
                console.error('Final update attempt also failed:', finalError);
              } else {
                console.log('Final update attempt completed - please verify manually');
              }
            }
          }
        }
        
        if (updateSuccess) {
          
          // Update base duration for next session
          baseDuration = maxDuration;
          // Mark as synced in local storage
          saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
            duration: maxDuration,
            timeEntryId: timeEntryId,
            projectId: selectedProjectId,
            taskId: selectedTaskId,
            synced: true
          });
          console.log(`✓ Final duration synced to Supabase: ${formatDurationFromSeconds(maxDuration)} (${maxDuration} seconds)`);
        }
      } catch (error) {
        console.error('Error syncing duration on stop:', error);
        pendingUpdates.push({
          timeEntryId: timeEntryId,
          duration: finalDuration,
          endTime: null // Always NULL
        });
        isOnline = false;
      }
    } else {
      // Offline - queue for later sync
      pendingUpdates.push({
        timeEntryId: timeEntryId,
        duration: finalDuration,
        endTime: null // Always NULL
      });
      baseDuration = finalDuration;
    }
  } else {
    baseDuration = finalDuration;
  }

  // Update UI
  startBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  stopBtn.disabled = true;
  projectSelect.disabled = false; // Re-enable project selection
  taskSelect.disabled = !selectedProjectId; // Re-enable task selection if project is selected
  statusDisplay.textContent = 'Not Tracking';
  statusDisplay.classList.remove('tracking');
  updateTimerDisplay(baseDuration);
  updateStartButtonState(); // Update start button state based on selections

  sessionStartTime = null;
  baseDurationAtSessionStart = 0;
  pausedDuration = 0;
  pauseStartTime = null;
  
  // Clear the stopping flag
  isStoppingTracking = false;
}

function formatDurationFromSeconds(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateTimerDisplay(totalSeconds) {
  timerDisplay.textContent = formatDurationFromSeconds(totalSeconds);
}

// Inactivity detection
function startIdleDetection() {
  const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes (300 seconds)

  function checkIdle() {
    if (!isTracking) {
      // Clear the timer if tracking stopped
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (idleDoubleCheckTimer) {
        clearTimeout(idleDoubleCheckTimer);
        idleDoubleCheckTimer = null;
      }
      return;
    }

    // Don't check if already paused
    if (pauseStartTime) {
      idleTimer = setTimeout(checkIdle, 1000);
      return;
    }

    const now = Date.now();
    const timeSinceLastActivity = now - lastActivityTime;
    
    // Before checking threshold, verify system activity one more time
    // This is a safety check to ensure we have the latest activity status
    if (timeSinceLastActivity > IDLE_THRESHOLD - 10000) {
      // Check system idle time directly before showing overlay
      ipcRenderer.invoke('get-system-idle-time').then(idleSeconds => {
        // Only reset if system clearly shows user is active (idle < 2 minutes)
        // This prevents false positives while still allowing inactivity detection
        if (idleSeconds !== null && idleSeconds < 2 * 60) {
          // User is actually active - update lastActivityTime (2 minutes threshold)
          lastActivityTime = Date.now();
          console.log(`Safety check: System shows user is active (idle=${idleSeconds.toFixed(1)}s) - updating lastActivityTime`);
          
          // Clear any pending double-check
          if (idleDoubleCheckTimer) {
            clearTimeout(idleDoubleCheckTimer);
            idleDoubleCheckTimer = null;
            console.log('Safety check: Cleared pending idle double-check due to detected activity');
          }
        } else if (idleSeconds === null) {
          // Can't determine system idle time - rely on lastActivityTime alone
          // Don't reset lastActivityTime - let the threshold check proceed
          console.log('Safety check: Cannot determine system idle time - relying on lastActivityTime');
        }
      }).catch(err => {
        // On error, rely on lastActivityTime alone - don't reset it
        console.log('Safety check: Error getting system idle time - relying on lastActivityTime');
      });
    }
    
    // Debug logging (only log when close to threshold)
    if (timeSinceLastActivity > IDLE_THRESHOLD - 10000 && timeSinceLastActivity < IDLE_THRESHOLD + 10000) {
      console.log(`Idle check: ${Math.floor(timeSinceLastActivity / 1000)}s since last activity (threshold: ${IDLE_THRESHOLD / 1000}s)`);
      console.log(`Last activity time: ${new Date(lastActivityTime).toLocaleTimeString()}, Current time: ${new Date(now).toLocaleTimeString()}`);
    }
    
    // Re-check time since last activity after potential update
    const updatedTimeSinceLastActivity = Date.now() - lastActivityTime;
    
    // Check if user has been inactive for threshold
    if (updatedTimeSinceLastActivity >= IDLE_THRESHOLD) {
      // Only start double-check if we don't already have one pending
      if (!idleDoubleCheckTimer) {
        console.log(`Idle threshold reached (${Math.floor(updatedTimeSinceLastActivity / 1000)}s), starting double-check...`);
        
      // Double-check: verify we're still inactive (prevent false positives)
        const doubleCheckDelay = 3000; // Wait 3 seconds and check again (longer delay)
        idleDoubleCheckTimer = setTimeout(async () => {
          // Clear the timer reference
          idleDoubleCheckTimer = null;
          
          // Re-check conditions
          if (!isTracking || pauseStartTime) {
            console.log('Tracking stopped or paused during double-check - cancelling');
            return;
          }
          
          // Final safety check - verify system idle time one more time
          const finalIdleSeconds = await ipcRenderer.invoke('get-system-idle-time').catch(() => null);
          
          // Only prevent showing overlay if system clearly shows user is active (idle < 2 minutes)
          if (finalIdleSeconds !== null && finalIdleSeconds < 2 * 60) {
            // User is actually active - don't show overlay
            lastActivityTime = Date.now();
            console.log(`Final check: System shows user is active (idle=${finalIdleSeconds.toFixed(1)}s) - NOT showing overlay`);
            return;
          }
          
        const recheckTime = Date.now();
        const recheckTimeSinceActivity = recheckTime - lastActivityTime;
        
          console.log(`Double-check: ${Math.floor(recheckTimeSinceActivity / 1000)}s since last activity, system idle: ${finalIdleSeconds !== null ? finalIdleSeconds.toFixed(1) : 'N/A'}s`);
          
          // Show overlay if still inactive after double-check
          // If system idle time is available, require it to be >= 3 minutes (slightly less than 5 min threshold)
          // If system idle time is unavailable, rely on lastActivityTime alone
          const shouldShowOverlay = recheckTimeSinceActivity >= IDLE_THRESHOLD && 
            (finalIdleSeconds === null || finalIdleSeconds >= 3 * 60);
          
          if (shouldShowOverlay) {
          // Pause tracking
          pauseStartTime = Date.now();
          
          console.log('Inactivity confirmed - pausing tracking and showing overlay');
      
          // Stop timer and captures
          if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
          }
          if (captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
          }

            // Sync duration before pausing
            await syncCurrentDuration();

          // Show overlay modal
          ipcRenderer.invoke('show-overlay').catch(err => {
            console.error('Error showing overlay:', err);
          });
        } else {
            console.log(`Activity detected during double-check (${Math.floor(recheckTimeSinceActivity / 1000)}s) - not showing overlay`);
        }
      }, doubleCheckDelay);
      }
    } else {
      // Activity detected - clear any pending double-check
      if (idleDoubleCheckTimer) {
        clearTimeout(idleDoubleCheckTimer);
        idleDoubleCheckTimer = null;
        console.log('Activity detected - cleared pending idle double-check');
      }
    }
    
    // Schedule next check
    idleTimer = setTimeout(checkIdle, 1000);
  }

  // Clear any existing idle timer before starting a new one
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (idleDoubleCheckTimer) {
    clearTimeout(idleDoubleCheckTimer);
    idleDoubleCheckTimer = null;
  }
  
  // Start checking
  idleTimer = setTimeout(checkIdle, 1000);
}

// Resume tracking after inactivity
async function resumeTracking() {
  if (!isTracking || !pauseStartTime) return;
  
  // Calculate paused duration and add to total
  const now = Date.now();
  pausedDuration += now - pauseStartTime;
  pauseStartTime = null;
  
  // Sync duration when resuming (to save the state before pause)
  await syncCurrentDuration();
  
  // Reset activity time
  lastActivityTime = now;
  
  // Resume timer if it was stopped
  if (!timerInterval) {
    startTimer();
  }
  
  // Resume captures if they were stopped
  if (!captureInterval) {
    startPeriodicCaptures();
  }
  
  // Restart idle detection
  if (!idleTimer) {
    startIdleDetection();
  }
  
  // Clear any pending double-check
  if (idleDoubleCheckTimer) {
    clearTimeout(idleDoubleCheckTimer);
    idleDoubleCheckTimer = null;
  }
  
  // Update status
  if (statusDisplay) {
  statusDisplay.textContent = 'Tracking';
  statusDisplay.classList.add('tracking');
  }
}

function startTimer() {
  timerInterval = setInterval(() => {
    if (sessionStartTime && !pauseStartTime && isTracking) {
      // Calculate session duration accurately
      const now = Date.now();
      let sessionDuration = Math.floor((now - sessionStartTime.getTime()) / 1000);
      sessionDuration -= Math.floor(pausedDuration / 1000);
      if (sessionDuration < 0) sessionDuration = 0;
      
      // Total duration = baseDurationAtSessionStart + session (prevents double-counting)
      const totalDuration = baseDurationAtSessionStart + sessionDuration;
      updateTimerDisplay(totalDuration);
    }
  }, 1000);
}

function updateDayCycleDisplay() {
  // Day cycle display removed - only show tracking status
  if (!isTracking) {
    statusDisplay.textContent = 'Not Tracking';
    statusDisplay.classList.remove('tracking');
  }
}


function startPeriodicCaptures() {
  // Clear any existing interval to prevent duplicates
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }

  const CAPTURE_INTERVAL = 5 * 60 * 1000; // 5 minutes (300 seconds)

  // Capture immediately on start
  captureScreenshotAndCamera().catch(err => {
    console.warn('Initial capture failed, will retry on next interval:', err);
  });

  // Then capture every 5 minutes - always capture when tracking is active
  captureInterval = setInterval(() => {
    if (isTracking && timeEntryId) {
      // Always attempt capture - don't skip even if paused
      captureScreenshotAndCamera().catch(err => {
        console.warn('Periodic capture failed, will retry on next interval:', err);
      });
    } else if (isTracking && !timeEntryId) {
      console.warn('Skipping capture: tracking active but no timeEntryId yet');
    }
  }, CAPTURE_INTERVAL);
  
  console.log('Periodic captures started - will capture every 5 minutes');
}

async function captureScreenshotAndCamera() {
  // Always attempt capture if tracking is active - don't skip due to pause
  if (!isTracking) {
    console.log('Skipping capture: tracking is not active');
    return;
  }
  if (!timeEntryId) {
    console.warn('Skipping capture: no timeEntryId available yet');
    return;
  }

  let screenshotPath = null;

  try {
    // Capture screenshot - get buffer instead of using filename to avoid file copy issues
    const screenshotBuffer = await screenshot({ format: 'png' });
    
    // Save to temp file
    screenshotPath = path.join(os.tmpdir(), `screenshot-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, screenshotBuffer);

    // Verify file was created
    if (!fs.existsSync(screenshotPath)) {
      throw new Error('Screenshot file was not created');
    }

    // Upload screenshot
    const screenshotFileName = `screenshots/${currentUser.id}/${Date.now()}-screenshot.png`;
    const screenshotFile = fs.readFileSync(screenshotPath);
    const { data: screenshotData, error: screenshotError } = await supabase.storage
      .from('screenshots')
      .upload(screenshotFileName, screenshotFile, {
        contentType: 'image/png',
        upsert: false
      });

    if (!screenshotError && screenshotData) {
      // Insert screenshot record
      const { error: insertError } = await supabase
        .from('screenshots')
        .insert({
          time_entry_id: timeEntryId,
          storage_path: screenshotFileName,
          type: 'screenshot',
          taken_at: new Date().toISOString()
        });

      if (insertError) {
        console.error('Error inserting screenshot record:', insertError);
      }
    } else if (screenshotError) {
      console.warn('Error uploading screenshot:', screenshotError);
    }

    // Clean up temp file
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      try {
        fs.unlinkSync(screenshotPath);
      } catch (unlinkError) {
        console.warn('Error deleting temp screenshot file:', unlinkError);
      }
    }

    // Capture camera (continue even if screenshot had issues)
    await captureCamera();

  } catch (error) {
    console.warn('Error capturing screenshot (continuing with camera):', error.message || error);
    
    // Clean up temp file if it exists
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      try {
        fs.unlinkSync(screenshotPath);
      } catch (unlinkError) {
        // Ignore cleanup errors
      }
    }
    
    // Still try to capture camera even if screenshot failed
    try {
      await captureCamera();
    } catch (cameraError) {
      console.warn('Error capturing camera:', cameraError.message || cameraError);
    }
  }
}

async function captureCamera() {
  // Always attempt camera capture if tracking is active
  if (!isTracking) {
    console.log('Skipping camera capture: tracking is not active');
    return;
  }
  if (!timeEntryId) {
    console.warn('Skipping camera capture: no timeEntryId available yet');
    return;
  }

  let stream = null;
  let video = null;

  try {
    console.log('Starting camera capture...');
    
    // Get camera stream - only when we need to capture
    // Use more lenient constraints to avoid conflicts
    stream = await navigator.mediaDevices.getUserMedia({ 
      video: { 
        width: { ideal: 640, max: 1280 },
        height: { ideal: 480, max: 720 },
        facingMode: 'user'
      } 
    });
    
    console.log('Camera stream obtained');
    
    video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // Mute to avoid any audio issues
    video.setAttribute('playsinline', 'true'); // Ensure plays inline
    
    // Add video to DOM temporarily (hidden) - some browsers need this
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    document.body.appendChild(video);
    
    // Wait for video to be ready and capture immediately
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Video load timeout after 5 seconds'));
      }, 5000); // Increased timeout to 5 seconds for reliability

      const onLoadedMetadata = () => {
        clearTimeout(timeout);
        console.log(`Video metadata loaded: ${video.videoWidth}x${video.videoHeight}`);
        
        video.play().then(() => {
          // Wait for first frame - increased to 300ms for better reliability
          setTimeout(() => {
            // Verify video is actually playing and has dimensions
            if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) {
              console.log(`Video is ready for capture: ${video.videoWidth}x${video.videoHeight}, readyState: ${video.readyState}`);
              video.removeEventListener('loadedmetadata', onLoadedMetadata);
              resolve();
            } else {
              console.warn(`Video not ready: width=${video.videoWidth}, height=${video.videoHeight}, readyState=${video.readyState}`);
              // Still try to capture - might work
              video.removeEventListener('loadedmetadata', onLoadedMetadata);
              resolve();
            }
          }, 300);
        }).catch((playError) => {
          video.removeEventListener('loadedmetadata', onLoadedMetadata);
          reject(playError);
        });
      };
      
      video.addEventListener('loadedmetadata', onLoadedMetadata);
      
      video.onerror = (err) => {
        clearTimeout(timeout);
        console.error('Video error:', err);
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        reject(err);
      };
    });

    // Create canvas and capture frame immediately
    const canvas = document.createElement('canvas');
    const videoWidth = video.videoWidth || 640;
    const videoHeight = video.videoHeight || 480;
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    const ctx = canvas.getContext('2d');
    
    // Verify video has valid dimensions before drawing
    if (videoWidth <= 0 || videoHeight <= 0) {
      throw new Error(`Invalid video dimensions: ${videoWidth}x${videoHeight}`);
    }
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Verify canvas has content
    const imageData = ctx.getImageData(0, 0, Math.min(10, canvas.width), Math.min(10, canvas.height));
    const hasContent = imageData.data.some(pixel => pixel !== 0);
    
    if (!hasContent) {
      console.warn('Canvas appears to be empty - video might not have rendered yet');
      // Still proceed, might be a false positive
    }
    
    console.log(`Camera frame captured: ${canvas.width}x${canvas.height}`);

    // CRITICAL: Release camera IMMEDIATELY after capturing frame
    // Stop all tracks first
    if (stream && stream.getTracks) {
      const tracks = stream.getTracks();
      tracks.forEach(track => {
        try {
          track.stop(); // This releases the camera hardware
          track.enabled = false;
        } catch (e) {
          // Ignore errors when stopping
        }
      });
    }

    // Clear video element references immediately
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
        video.load(); // Reset video element
        
        // Remove from DOM if it was added
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      } catch (e) {
        // Ignore errors
      }
      video = null;
    }

    // Clear stream reference
    stream = null;

    // Convert canvas to buffer (camera is already released at this point)
    return new Promise((resolve) => {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          console.error('Canvas toBlob returned null - canvas might be empty');
          resolve();
          return;
        }
        
        try {
          console.log(`Converting canvas to blob: ${blob.size} bytes`);
          const arrayBuffer = await blob.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          
          if (buffer.length === 0) {
            console.error('Buffer is empty - camera capture failed');
            resolve();
            return;
          }
          
          const cameraPath = path.join(os.tmpdir(), `camera-${Date.now()}.png`);
          fs.writeFileSync(cameraPath, buffer);

          // Verify file was created
          if (!fs.existsSync(cameraPath)) {
            throw new Error('Camera file was not created');
          }
          
          const fileStats = fs.statSync(cameraPath);
          console.log(`Camera file created: ${cameraPath} (${fileStats.size} bytes)`);

          // Upload camera capture to screenshots bucket in camera folder
          const cameraFileName = `camera/${currentUser.id}/${Date.now()}-camera.png`;
          const cameraFile = fs.readFileSync(cameraPath);
          
          console.log(`Uploading camera capture to screenshots bucket: ${cameraFileName}`);
          const { data: cameraData, error: cameraError } = await supabase.storage
            .from('screenshots')
            .upload(cameraFileName, cameraFile, {
              contentType: 'image/png',
              upsert: false
            });

          if (cameraError) {
            console.error('Error uploading camera capture:', cameraError);
            console.error('Error details:', JSON.stringify(cameraError, null, 2));
            
            // Check if it's a bucket/path issue
            if (cameraError.message && (cameraError.message.includes('bucket') || cameraError.message.includes('not found'))) {
              console.error('❌ Storage bucket issue - check if "screenshots" bucket exists in Supabase Storage');
            }
            if (cameraError.message && cameraError.message.includes('policy')) {
              console.error('❌ Storage policy issue - check RLS policies for screenshots bucket (camera folder)');
            }
            if (cameraError.message && cameraError.message.includes('permission')) {
              console.error('❌ Storage permission issue - check storage policies allow uploads to screenshots/camera/{user_id}/*');
            }
            
            resolve();
            return;
          }

          if (cameraData) {
            console.log('Camera capture uploaded successfully:', cameraData.path);
            
            // Insert screenshot record with type 'camera'
            const { error: insertError } = await supabase
              .from('screenshots')
              .insert({
                time_entry_id: timeEntryId,
                storage_path: cameraFileName,
                type: 'camera',
                taken_at: new Date().toISOString()
              });

            if (insertError) {
              console.error('Error inserting camera record:', insertError);
            } else {
              console.log('Camera record inserted successfully');
            }
          } else {
            console.warn('Camera upload returned no data');
          }

          // Clean up temp file
          try {
          fs.unlinkSync(cameraPath);
            console.log('Camera temp file cleaned up');
          } catch (unlinkError) {
            console.warn('Error deleting temp camera file:', unlinkError);
          }
          
          resolve();
        } catch (error) {
          console.error('Error processing camera capture:', error);
          console.error('Error stack:', error.stack);
          resolve();
        }
      }, 'image/png', 0.95); // Use 0.95 quality to reduce file size
    });
  } catch (error) {
    // Handle specific camera errors gracefully
    const errorName = error.name || error.constructor.name;
    const errorMessage = error.message || error.toString();
    
    console.error('Camera capture failed:', {
      name: errorName,
      message: errorMessage,
      stack: error.stack
    });
    
    if (errorName === 'NotReadableError' || errorMessage.includes('Could not start video source')) {
      // Camera is likely in use by another application
      console.warn('Camera is in use or unavailable:', errorMessage);
      // Continue tracking without camera - don't log as error
    } else if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
      console.warn('Camera permission denied:', errorMessage);
      // Continue tracking without camera
    } else if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
      console.warn('No camera device found:', errorMessage);
      // Continue tracking without camera
    } else if (errorMessage.includes('timeout')) {
      console.warn('Camera capture timeout:', errorMessage);
      // Continue tracking without camera
    } else {
      // Other errors - log but continue
      console.warn('Camera capture error (continuing without camera):', errorName, errorMessage);
    }
    // Camera might not be available, continue without it - don't throw error
  } finally {
    // Ensure camera is ALWAYS released, even if there's an error
    // This is a safety net - camera should already be released above
    if (stream) {
      try {
        const tracks = stream.getTracks();
        tracks.forEach(track => {
          try {
            track.stop(); // Release camera hardware
            track.enabled = false;
          } catch (e) {
            // Ignore errors when stopping tracks
          }
        });
      } catch (e) {
        // Ignore errors
      }
      stream = null; // Clear reference
    }
    
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
        video.load(); // Reset video element completely
        // Remove from DOM if it was added
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      } catch (e) {
        // Ignore errors
      }
      video = null; // Clear reference
    }
  }
}

let realTimeUpdateInterval = null; // Store interval ID for cleanup

function startRealTimeUpdates() {
  // Clear any existing interval
  if (realTimeUpdateInterval) {
    clearInterval(realTimeUpdateInterval);
    realTimeUpdateInterval = null;
  }
  
  // Update duration in database every 1 minute (60 seconds)
  // Use baseDurationAtSessionStart to prevent double-counting
  realTimeUpdateInterval = setInterval(async () => {
    // Double-check isTracking and isStoppingTracking to prevent race conditions
    if (!isTracking || isStoppingTracking || !timeEntryId || !sessionStartTime) {
      if (isStoppingTracking) {
        console.log('Real-time update skipped: stopTracking in progress');
      }
      return;
    }
    
    // Skip if paused (but we'll sync when pause happens)
    if (pauseStartTime) return;

    // Calculate current session duration accurately
    const now = Date.now();
    let sessionDuration = Math.floor((now - sessionStartTime.getTime()) / 1000);
    sessionDuration -= Math.floor(pausedDuration / 1000);
    if (sessionDuration < 0) sessionDuration = 0;

    // Calculate total duration using baseDurationAtSessionStart (not current baseDuration)
    // This prevents double-counting if baseDuration was updated during this session
    const totalDuration = baseDurationAtSessionStart + sessionDuration;

    // Save to local storage first (works offline)
    saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
      duration: totalDuration,
      timeEntryId: timeEntryId
    });

    // Update in Supabase if online
    if (isOnline) {
      try {
        // Fetch current duration from Supabase (source of truth)
        const { data: currentEntry, error: fetchError } = await supabase
          .from('time_entries')
          .select('duration')
          .eq('id', timeEntryId)
          .single();

        if (fetchError) {
          console.error('Error fetching current duration:', fetchError);
          isOnline = false;
          return;
        }

        const savedDuration = currentEntry?.duration || 0;
        
        // CRITICAL: Skip real-time update if stopTracking is in progress
        if (isStoppingTracking) {
          console.log('Real-time update skipped: stopTracking in progress, not overwriting final duration');
          return;
        }
        
        // Use the maximum of saved duration and calculated duration
        // This ensures we never reduce time and handle any edge cases
        const maxDuration = Math.max(savedDuration, totalDuration);

        // Only update if there's a meaningful change (more than 1 second)
        // AND if the calculated duration is greater than saved (never reduce)
        if (Math.abs(maxDuration - savedDuration) > 1 && totalDuration > savedDuration) {
          console.log(`Real-time update: Updating duration from ${savedDuration}s to ${maxDuration}s`);
          const { error: updateError } = await supabase
            .from('time_entries')
            .update({
              duration: maxDuration,
              end_time: null, // Always NULL during active tracking
              updated_at: new Date().toISOString()
            })
            .eq('id', timeEntryId);

          if (updateError) {
            console.error('Error updating time entry duration:', updateError);
            isOnline = false;
          } else {
            // Update baseDuration to reflect what's now in DB
            // This will be used when we stop tracking
            baseDuration = maxDuration;
            
            // Update local storage with synced value
            saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
              duration: maxDuration,
              timeEntryId: timeEntryId
            });
          }
        }
      } catch (error) {
        console.error('Error syncing duration:', error);
        isOnline = false;
      }
    } else {
      // Offline - queue for later sync
      pendingUpdates.push({
        timeEntryId: timeEntryId,
        duration: totalDuration
      });
    }
  }, 60000); // Every 60 seconds (1 minute)
}

// Helper function to sync current duration to Supabase
async function syncCurrentDuration() {
  if (!isTracking || !timeEntryId || !sessionStartTime) return false;
  
  try {
    // Calculate current session duration accurately
    const now = Date.now();
    let sessionDuration = Math.floor((now - sessionStartTime.getTime()) / 1000);
    sessionDuration -= Math.floor(pausedDuration / 1000);
    if (sessionDuration < 0) sessionDuration = 0;
    
    // Calculate total duration using baseDurationAtSessionStart
    const totalDuration = baseDurationAtSessionStart + sessionDuration;
    
    // Save to local storage first (works offline)
    saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
      duration: totalDuration,
      timeEntryId: timeEntryId,
      projectId: selectedProjectId,
      taskId: selectedTaskId
    });
    
    // Update in Supabase if online
    if (isOnline) {
      try {
        // Fetch current duration from Supabase (source of truth)
        const { data: currentEntry, error: fetchError } = await supabase
          .from('time_entries')
          .select('duration')
          .eq('id', timeEntryId)
          .single();

        if (fetchError) {
          console.error('Error fetching current duration:', fetchError);
          isOnline = false;
          return false;
        }

        const savedDuration = currentEntry?.duration || 0;
        
        // Use the maximum of saved duration and calculated duration
        const maxDuration = Math.max(savedDuration, totalDuration);

        // Update if there's a meaningful change (more than 1 second)
        if (Math.abs(maxDuration - savedDuration) > 1) {
          const { error: updateError } = await supabase
            .from('time_entries')
            .update({
              duration: maxDuration,
              updated_at: new Date().toISOString()
            })
            .eq('id', timeEntryId);

          if (updateError) {
            console.error('Error updating time entry duration:', updateError);
            isOnline = false;
            return false;
          } else {
            // Update baseDuration to reflect what's now in DB
            baseDuration = maxDuration;
            
            // Update local storage with synced value
            saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
              duration: maxDuration,
              timeEntryId: timeEntryId,
              projectId: selectedProjectId,
              taskId: selectedTaskId
            });
            
            console.log(`Duration synced to Supabase: ${formatDurationFromSeconds(maxDuration)}`);
            return true;
          }
        }
        return true;
      } catch (error) {
        console.error('Error syncing duration:', error);
        isOnline = false;
        return false;
      }
    } else {
      // Offline - queue for later sync
      pendingUpdates.push({
        timeEntryId: timeEntryId,
        duration: totalDuration
      });
      return false;
    }
  } catch (error) {
    console.error('Error in syncCurrentDuration:', error);
    return false;
  }
}

function startDailyResetCheck() {
  // Check every minute if we've crossed the 6 AM IST threshold
  dailyResetCheckInterval = setInterval(async () => {
    if (!currentUser) return;

    const newDayCycle = getCurrentDayCycle();
    
    // Check if day cycle has changed
    if (currentDayCycle && currentDayCycle.dateString !== newDayCycle.dateString) {
      // New day cycle detected - reset everything
      console.log('New day cycle detected - resetting tracking');
      
      // Stop tracking if active
      if (isTracking) {
        await stopTracking();
      }
      
      // Reset state
      currentDayCycle = newDayCycle;
      baseDuration = 0;
      baseDurationAtSessionStart = 0;
      timeEntryId = null;
      
      // Reload last time entry (should be empty for new day)
      await loadLastTimeEntry();
      
      // Update UI
      updateDayCycleDisplay();
      updateTimerDisplay(0);
      
      // Show notification
      // Day cycle display removed - just show not tracking status
      if (!isTracking) {
        statusDisplay.textContent = 'Not Tracking';
        statusDisplay.classList.remove('tracking');
      }
    }
  }, 60000); // Check every minute
}

