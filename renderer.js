/* Electron renderer — uses preload bridge (contextIsolation). No Node require(). */
const tf = window.timeflow
if (!tf) {
  alert('TimeFlow preload bridge missing. contextIsolation/preload misconfigured.')
  throw new Error('timeflow preload missing')
}

const ipcRenderer = tf.ipc
const createClient = tf.createClient
const screenshot = tf.screenshot
const fs = tf.fs
const path = tf.path
const os = tf.os
const crypto = tf.crypto
const Buffer = tf.Buffer
const __dirname = tf.dirname

const appVersion = tf.appVersion
const TRACKER_VERSION = appVersion
const appPlatform = os.platform()

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let supabase = null

async function initSupabaseClient() {
  if (supabase) return supabase

  console.log('Resolving Supabase config (env or remote desktop-config.json)...')
  const cfg = await tf.getSupabaseConfig()
  if (!cfg?.supabaseUrl || !cfg?.supabasePublishableKey) {
    throw new Error(
      'Missing Supabase config. For local dev set .env; packaged apps fetch https://timeflow.mechlintech.com/desktop-config.json',
    )
  }

  console.log('Supabase config source:', cfg.source || 'unknown')
  supabase = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: window.localStorage,
      storageKey: 'supabase.auth.token',
    },
    global: {
      headers: {
        'x-client-info': 'electron-time-tracker',
      },
    },
  })
  console.log('Supabase client created successfully')
  return supabase
}

function getActivityDisplayName() {
  return (userProfile && (userProfile.full_name || userProfile.email))
    || (currentUser && currentUser.email)
    || 'Someone';
}

function getSelectedWorkLabel() {
  const project = (typeof projects !== 'undefined' && projects)
    ? projects.find((item) => item && item.id === selectedProjectId)
    : null;
  const task = (typeof tasks !== 'undefined' && tasks)
    ? tasks.find((item) => item && item.id === selectedTaskId)
    : null;
  const projectName = (project && project.name) || 'a project';
  const taskName = (task && task.name) || 'a task';
  return { projectName, taskName, label: `${projectName} / ${taskName}` };
}

function formatDurationForLog(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

async function writeUserLog(logType, message, metadata) {
  const userId = currentUser && currentUser.id;
  if (!userId || !message) return;
  try {
    const { error } = await supabase.from('user_logs').insert({
      user_id: userId,
      log_type: logType,
      log_message: message,
      metadata: Object.assign({
        source: 'desktop',
        api_action: null,
        api_table: null,
        api_operation: null,
        app_version: appVersion,
        platform: appPlatform,
        architecture: os.arch(),
        user_email: (currentUser && currentUser.email) || null,
        user_name: getActivityDisplayName(),
        recorded_at: new Date().toISOString()
      }, metadata || {}, {
        source: 'desktop'
      }),
      device_info: `${appPlatform} ${os.arch()}`,
      user_agent: 'TimeFlow Desktop'
    });
    if (error) {
      console.warn('Failed to write activity log:', error.message || error);
    }
  } catch (err) {
    console.warn('Failed to write activity log:', err.message || err);
  }
}

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

// Day cycle timezone utilities
// USE_LOCAL_TIME_FOR_DAY_CYCLE: set to true to use machine local time (for testing date-change reset by changing system clock).
// Set to false for production so day cycle uses IST (global time - reset at midnight IST).
// true = use machine local time (change system clock to test midnight rollover, e.g. 11:55 PM → 12:05 AM = new day, new DB entry)
const USE_LOCAL_TIME_FOR_DAY_CYCLE = false; // false = use IST (Asia/Kolkata) for production

// IST is UTC+5:30 (used when USE_LOCAL_TIME_FOR_DAY_CYCLE is false)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns date components used for day cycle. When USE_LOCAL_TIME_FOR_DAY_CYCLE is true,
 * uses local machine time (for testing). Otherwise uses IST (Asia/Kolkata) so "today" is always the date in India.
 */
function getISTComponents() {
  const now = new Date();
  if (USE_LOCAL_TIME_FOR_DAY_CYCLE) {
    // Use local machine time for day cycle (for testing - change system date/time to verify reset at midnight)
    return {
      year: now.getFullYear(),
      month: now.getMonth(),
      date: now.getDate(),
      hours: now.getHours(),
      minutes: now.getMinutes()
    };
  }
  // Production: use Asia/Kolkata so day is always the calendar date in India (global time)
  const istStr = now.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }); // e.g. "2026-02-04, 14:30:00"
  const [datePart, timePart] = istStr.split(', ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hr, min] = (timePart || '0:0:0').split(':').map(Number);
  return {
    year: y,
    month: m - 1, // 0-based for Date
    date: d,
    hours: hr,
    minutes: min
  };
}

/**
 * Day cycle = one calendar day. Resets at midnight (00:00) in the chosen time (local or IST).
 * Same calendar day = same session (e.g. start at 8 PM same day continues that day's time).
 */
function getCurrentDayCycle() {
  const ist = getISTComponents();
  const cycleYear = ist.year;
  const cycleMonth = ist.month;
  const cycleDay = ist.date;

  let cycleStart, cycleEnd, cycleDate;

  if (USE_LOCAL_TIME_FOR_DAY_CYCLE) {
    // Local: cycle is midnight to 23:59:59.999 in local time
    cycleStart = new Date(cycleYear, cycleMonth, cycleDay, 0, 0, 0, 0);
    cycleEnd = new Date(cycleYear, cycleMonth, cycleDay, 23, 59, 59, 999);
    cycleDate = new Date(cycleYear, cycleMonth, cycleDay);
  } else {
    // IST: midnight IST = (cycleDay-1) 18:30 UTC, end of day IST = cycleDay 18:29:59.999 UTC
    cycleStart = new Date(Date.UTC(cycleYear, cycleMonth, cycleDay - 1, 18, 30, 0, 0));
    cycleEnd = new Date(Date.UTC(cycleYear, cycleMonth, cycleDay, 18, 29, 59, 999));
    cycleDate = new Date(Date.UTC(cycleYear, cycleMonth, cycleDay));
  }

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
let sessionStartTime = null; // Wall-clock session start (for DB start_time / display only)
let sessionStartPerfMs = null; // performance.now() at session start — monotonic, not affected by OS clock changes
let pausedDuration = 0; // Accumulated paused time in current session (ms, from performance.now() deltas)
let pauseStartPerfMs = null; // performance.now() when inactivity pause began (null = not paused)
let isStoppingTracking = false; // Flag to prevent race conditions during stop
let timerInterval = null;
let captureInterval = null; // Kept for clearInterval compatibility when stopping
let captureTimeoutId = null; // setTimeout chain for reliable 5-7 min interval
let lastCaptureTime = 0; // When we last ran capture (for catch-up and watchdog)
let cameraSkippedDueToInUse = false; // When true, next capture interval is shortened so we retry camera soon (e.g. after Teams call ends)
let captureInProgress = false; // Prevents overlapping captures and watchdog restart during capture
let captureWatchdogInterval = null; // Restarts capture loop if it was lost (e.g. after background throttle)
let dailyResetCheckInterval = null;
let idleTimer = null; // Timer for inactivity detection
let idleDoubleCheckTimer = null; // Timer for double-checking inactivity
let lastActivityTime = Date.now(); // Last time user was active

/** Active tracked seconds this session, from monotonic clock (immune to system time changes). */
function getMonotonicSessionSeconds() {
  if (sessionStartPerfMs == null) return 0;
  const perfNow = performance.now();
  const currentPauseMs = pauseStartPerfMs != null ? perfNow - pauseStartPerfMs : 0;
  const activeMs = perfNow - sessionStartPerfMs - pausedDuration - currentPauseMs;
  const sec = Math.floor(activeMs / 1000);
  return sec < 0 ? 0 : sec;
}
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

// Performance optimization: Cache display configuration
let cachedDisplays = null;
let displayCacheTimestamp = 0;
const DISPLAY_CACHE_DURATION = 5 * 60 * 1000; // Cache for 5 minutes

// Screen comparer: auto-stop when screen unchanged or black (content region only, taskbar excluded)
const TASKBAR_HEIGHT_PX = 48; // Pixels to exclude from bottom for comparison (taskbar)
const COMPARE_RESIZE_WIDTH = 48; // Downscale content for hash (smaller = more tolerant of tiny differences)
const CONSECUTIVE_SAME_THRESHOLD = 1; // Auto-stop after 2 consecutive identical screens (1 = trigger when current matches previous)
const BLACK_LUMINANCE_THRESHOLD = 25; // Pixel luminance below this = dark (screen only)
const BLACK_DARK_PIXEL_RATIO = 0.92; // If this fraction of sampled pixels is dark, treat as black screen
const SCREEN_COMPARER_COOLDOWN_MS = 2 * 60 * 1000; // Don't auto-stop for "unchanged" in first 2 minutes
// Only compare last 2 screens (and trigger "screen unchanged") when user is active; if inactive, let inactivity overlay handle it
const ACTIVE_FOR_SCREEN_COMPARE_MS = 5 * 60 * 1000; // Same as inactivity threshold – if no activity in 5 min, don't trigger "unchanged"
let lastContentHashForComparer = null;
let consecutiveSameScreenCount = 0;
// Face detection: lightweight check on start and every 5–7 min (no tape/black logic)
const FACE_API_WEIGHTS_BASE = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
// Higher inputSize = better for distant/small faces; 224 is a balance (128 was too strict at distance). Same tiny model, no extra download.
// On very weak systems, try 160 for slightly less CPU while still better than 128.
const FACE_DETECTOR_INPUT_SIZE = 224;
const FACE_DETECTOR_SCORE_THRESHOLD = 0.35; // Slightly lenient so farther/partial faces still count
let faceApiModelsLoaded = false;
let faceApiLoadPromise = null;

// Run once at load: Electron needs browser DOM for face-api (avoids "Illegal constructor" in any renderer)
(function patchFaceApiEnv() {
  if (typeof faceapi === 'undefined' || !faceapi.env || typeof faceapi.env.monkeyPatch !== 'function') return;
  try {
    faceapi.env.monkeyPatch({
      createCanvasElement: () => document.createElement('canvas'),
      createImageElement: () => document.createElement('img')
    });
  } catch (_) {}
})();

async function loadFaceApiModels() {
  if (faceApiModelsLoaded) return true;
  if (faceApiLoadPromise) return faceApiLoadPromise;
  faceApiLoadPromise = (async () => {
    if (typeof faceapi === 'undefined') {
      console.warn('Face detection: face-api not loaded (script missing or blocked)');
      return false;
    }
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_WEIGHTS_BASE);
      faceApiModelsLoaded = true;
      console.log('Face detection: tiny face detector loaded');
      return true;
    } catch (err) {
      console.warn('Face detection: failed to load models', err.message);
      return false;
    }
  })();
  return faceApiLoadPromise;
}

/**
 * Returns true if at least one face is detected in the canvas. Minimal CPU: runs only when needed.
 * Uses inputSize 224 + lower scoreThreshold to improve detection when user is at a distance.
 */
async function detectFaceInCanvas(canvas) {
  if (!canvas || canvas.width < 10 || canvas.height < 10) return false;
  const loaded = await loadFaceApiModels();
  if (!loaded) return true; // allow when models unavailable (e.g. offline)
  try {
    const opts = new faceapi.TinyFaceDetectorOptions({
      inputSize: FACE_DETECTOR_INPUT_SIZE,
      scoreThreshold: FACE_DETECTOR_SCORE_THRESHOLD
    });
    const detections = await faceapi.detectAllFaces(canvas, opts);
    return detections && detections.length > 0;
  } catch (err) {
    console.warn('Face detection: detect failed', err.message);
    return true; // do not block on detection errors
  }
}

// Capture Settings Manager
let captureSettings = {
  enableScreenshotCapture: true, // Default to enabled
  enableCameraCapture: true, // Default to enabled
  settingsChannel: null,
  refreshInterval: null
};

// Last permission check result - used so tracker cannot start without camera/screenshot when required
let lastPermissionCheck = null;

// Initialize capture settings from user profile
async function initializeCaptureSettings(userId) {
  try {
    console.log('Fetching capture settings for user:', userId);
    
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('enable_screenshot_capture, enable_camera_capture')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Error fetching capture settings:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      
      // If profile doesn't exist, create it with default enabled settings
      if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
        console.log('Profile not found, creating default profile...');
        const { data: newProfile, error: createError } = await supabase
          .from('profiles')
          .insert({
            id: userId,
            enable_screenshot_capture: true,
            enable_camera_capture: true
          })
          .select('enable_screenshot_capture, enable_camera_capture')
          .single();
        
        if (createError) {
          console.error('Error creating profile:', createError);
          // Default to enabled on error (graceful degradation)
          captureSettings.enableScreenshotCapture = true;
          captureSettings.enableCameraCapture = true;
          return;
        }
        
        if (newProfile) {
          captureSettings.enableScreenshotCapture = newProfile.enable_screenshot_capture ?? true;
          captureSettings.enableCameraCapture = newProfile.enable_camera_capture ?? true;
          console.log('Created profile with default settings:', {
            screenshot: captureSettings.enableScreenshotCapture,
            camera: captureSettings.enableCameraCapture
          });
        } else {
          captureSettings.enableScreenshotCapture = true;
          captureSettings.enableCameraCapture = true;
        }
      } else {
        // Default to enabled on other errors (graceful degradation)
        captureSettings.enableScreenshotCapture = true;
        captureSettings.enableCameraCapture = true;
      }
      return;
    }

    if (profile) {
      captureSettings.enableScreenshotCapture = profile.enable_screenshot_capture ?? true;
      captureSettings.enableCameraCapture = profile.enable_camera_capture ?? true;
      console.log('✅ Capture settings loaded:', {
        screenshot: captureSettings.enableScreenshotCapture,
        camera: captureSettings.enableCameraCapture
      });
    } else {
      // Default to enabled if profile not found
      console.warn('Profile not found, defaulting to enabled');
      captureSettings.enableScreenshotCapture = true;
      captureSettings.enableCameraCapture = true;
    }

    // Setup real-time subscription to profile changes
    setupCaptureSettingsSubscription(userId);
    
    // Setup periodic refresh as fallback (every 5 minutes)
    if (captureSettings.refreshInterval) {
      clearInterval(captureSettings.refreshInterval);
    }
    captureSettings.refreshInterval = setInterval(() => {
      initializeCaptureSettings(userId).catch(err => {
        console.error('Error refreshing capture settings:', err);
      });
    }, 5 * 60 * 1000); // Every 5 minutes

  } catch (error) {
    console.error('Exception fetching capture settings:', error);
    // Default to enabled on exception (graceful degradation)
    captureSettings.enableScreenshotCapture = true;
    captureSettings.enableCameraCapture = true;
  }
}

// Setup real-time subscription to profile changes
function setupCaptureSettingsSubscription(userId) {
  // Clean up existing subscription
  if (captureSettings.settingsChannel) {
    supabase.removeChannel(captureSettings.settingsChannel);
    captureSettings.settingsChannel = null;
  }

  try {
    captureSettings.settingsChannel = supabase
      .channel(`capture-settings-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          const updatedProfile = payload.new;
          const oldScreenshot = captureSettings.enableScreenshotCapture;
          const oldCamera = captureSettings.enableCameraCapture;
          
          captureSettings.enableScreenshotCapture = updatedProfile.enable_screenshot_capture ?? true;
          captureSettings.enableCameraCapture = updatedProfile.enable_camera_capture ?? true;

          // Notify user if settings changed
          if (oldScreenshot !== captureSettings.enableScreenshotCapture) {
            console.log(`Screenshot capture ${captureSettings.enableScreenshotCapture ? 'enabled' : 'disabled'} by administrator`);
          }
          if (oldCamera !== captureSettings.enableCameraCapture) {
            console.log(`Camera capture ${captureSettings.enableCameraCapture ? 'enabled' : 'disabled'} by administrator`);
          }
        }
      )
      .subscribe();

    console.log('Capture settings real-time subscription established');
  } catch (error) {
    console.error('Error setting up capture settings subscription:', error);
  }
}

// Cleanup capture settings subscription
function cleanupCaptureSettings() {
  if (captureSettings.settingsChannel) {
    supabase.removeChannel(captureSettings.settingsChannel);
    captureSettings.settingsChannel = null;
  }
  if (captureSettings.refreshInterval) {
    clearInterval(captureSettings.refreshInterval);
    captureSettings.refreshInterval = null;
  }
}

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
    console.log(`Cleared local storage for ${dayCycle}`);
  } catch (error) {
    console.error('Error clearing local storage:', error);
  }
}

// Clear all old local storage entries for a user (except current day cycle)
function clearAllOldLocalStorage(userId, currentDayCycle) {
  try {
    const prefix = `time_tracker_${userId}_`;
    const keysToRemove = [];
    
    // Iterate through all localStorage keys
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        // Extract the day cycle from the key
        const dayCycle = key.replace(prefix, '');
        // If it's not the current day cycle, mark it for removal
        if (dayCycle !== currentDayCycle) {
          keysToRemove.push(key);
        }
      }
    }
    
    // Remove all old entries
    keysToRemove.forEach(key => {
      localStorage.removeItem(key);
      console.log(`Cleared old local storage entry: ${key}`);
    });
    
    if (keysToRemove.length > 0) {
      console.log(`🧹 Cleaned up ${keysToRemove.length} old local storage entries`);
    }
  } catch (error) {
    console.error('Error clearing old local storage:', error);
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
          updated_at: new Date().toISOString(),
          app_version: appVersion // Track which version of the tracker updated this entry
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
          updated_at: new Date().toISOString(),
          app_version: appVersion // Track which version of the tracker updated this entry
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
let versionBadge, versionText;

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
  versionBadge = document.getElementById('version-badge');
  versionText = document.getElementById('version-text');

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
async function bootApp() {
  initializeDOMElements()
  try {
    await initSupabaseClient()
  } catch (err) {
    console.error('Failed to initialize Supabase:', err)
    alert(
      `Could not load app configuration.\n\n${err.message || err}\n\nLocal dev: set SUPABASE_URL and SUPABASE_ANON_KEY in .env\nInstalled app: ensure ${tf.env.DESKTOP_CONFIG_URL || 'desktop-config.json'} is reachable.`,
    )
    return
  }
  checkAuth()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bootApp()
  })
} else {
  bootApp()
}

// Cleanup on app shutdown
window.addEventListener('beforeunload', () => {
  cleanupCaptureSettings();
});

// Handle window beforeunload to save duration if tracking is active
window.addEventListener('beforeunload', async (e) => {
  if (isTracking) {
    console.log('Window closing - stopping tracking and saving duration...');
    // Use synchronous-like approach - we can't use async/await in beforeunload
    // So we'll use sendBeacon or a synchronous approach
    // For Electron, we can use a blocking approach
    e.preventDefault();
    
    // CRITICAL: Check day cycle before saving (don't save if day has changed)
    const currentCycle = getCurrentDayCycle();
    if (currentDayCycle && currentDayCycle.dateString !== currentCycle.dateString) {
      console.warn('⚠️ Day cycle changed during shutdown - not saving old day data');
      // Don't save - let the new day start fresh
      return;
    }
    
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

// Handle app visibility change (when PC wakes from sleep or app regains focus)
document.addEventListener('visibilitychange', async () => {
  if (document.hidden && isTracking) {
    // App became hidden - check if screen is off
    console.log('👁️ App became hidden - checking if screen is off...');
    await checkScreenOffAndStop();
  } else if (!document.hidden && currentUser) {
    // App became visible - sync duration immediately (timers are throttled when hidden, so DB may be behind)
    if (isTracking && timeEntryId && sessionStartTime) {
      syncCurrentDuration().catch(err => console.error('Visibility sync failed:', err));
    }
    // App became visible - validate day cycle
    console.log('🔄 App became visible - validating day cycle...');
    const newDayCycle = getCurrentDayCycle();
    
    if (!currentDayCycle || currentDayCycle.dateString !== newDayCycle.dateString) {
      const wasTracking = isTracking;
      console.log('🔄 Day cycle changed while app was hidden - resetting', { wasTracking });
      
      if (wasTracking) {
        await stopTracking();
      }
      
      if (currentUser) {
        clearAllOldLocalStorage(currentUser.id, newDayCycle.dateString);
        if (currentDayCycle) {
          clearLocalStorage(currentUser.id, currentDayCycle.dateString);
        }
      }
      
      currentDayCycle = newDayCycle;
      baseDuration = 0;
      baseDurationAtSessionStart = 0;
      timeEntryId = null;
      isTracking = false;
      
      await loadLastTimeEntry();
      updateDayCycleDisplay();
      updateTimerDisplay(0);
      
      if (wasTracking && selectedProjectId && selectedTaskId) {
        console.log('🔄 Auto-starting tracker for new day (app became visible)');
        await startTracking();
      } else if (statusDisplay) {
        statusDisplay.textContent = 'Not Tracking';
        statusDisplay.classList.remove('tracking');
      }
    }

    // Catch-up: if we're tracking and last screenshot was too long ago (e.g. app was in background and timers were throttled), capture now and reschedule
    if (isTracking && pauseStartPerfMs == null && timeEntryId && !captureInProgress) {
      const timeSinceLastCapture = Date.now() - lastCaptureTime;
      if (timeSinceLastCapture >= CAPTURE_INTERVAL_MIN_MS) {
        console.log(`App visible: last capture ${Math.round(timeSinceLastCapture / 60000)} min ago - running catch-up capture`);
        startPeriodicCaptures();
      }
    }
  }
});

// Check if screen is off and stop tracking if it is
async function checkScreenOffAndStop() {
  if (!isTracking) return;
  
  try {
    // Check screen state (Windows)
    if (process.platform === 'win32') {
      const isScreenOff = await ipcRenderer.invoke('check-screen-off');
      if (isScreenOff) {
        console.log('🖥️ Screen is off - stopping tracker');
        await stopTracking();
        if (statusDisplay) {
          statusDisplay.textContent = 'Stopped: Screen is off';
          statusDisplay.classList.remove('tracking');
          setTimeout(() => {
            if (statusDisplay && !isTracking) {
              statusDisplay.textContent = 'Not Tracking';
            }
          }, 5000);
        }
        
        // Show overlay modal instead of alert
        await ipcRenderer.invoke('show-overlay', {
          title: 'Screen Off',
          message: 'Your screen is off. Tracking has been stopped.',
          icon: '🖥️',
          isStopped: true
        });
      }
    }
  } catch (error) {
    console.error('Error checking screen state:', error);
  }
}

// Monitor screen state periodically while tracking
let screenStateCheckInterval = null;

function startScreenStateMonitoring() {
  if (screenStateCheckInterval) {
    clearInterval(screenStateCheckInterval);
  }
  
  // Check screen state every 5 seconds while tracking
  screenStateCheckInterval = setInterval(async () => {
    if (isTracking && document.hidden) {
      await checkScreenOffAndStop();
    }
  }, 5000);
}

function stopScreenStateMonitoring() {
  if (screenStateCheckInterval) {
    clearInterval(screenStateCheckInterval);
    screenStateCheckInterval = null;
  }
}
// Permission check button removed from UI - permissions checked automatically

// In-window activity: mouse click or keyboard key in the tracker window (resets inactivity timer). No mousemove, no "low/high" - any click/key counts.
function setupActivityListeners() {
  // Single click or key = activity (no throttle)
  const activityHandler = (eventType) => {
    return () => {
      if (isTracking && pauseStartPerfMs == null) {
        resetIdleTimer();
        if (!activityHandler.lastLogTime || (Date.now() - activityHandler.lastLogTime) > 5000) {
          console.log(`Activity detected: ${eventType}`);
          activityHandler.lastLogTime = Date.now();
        }
      }
    };
  };

  // Mouse clicks, keyboard keys, and mouse move (hover) count as activity - single key/click/hover = active
  const mouseClickEvents = ['mousedown', 'mouseup', 'click'];
  mouseClickEvents.forEach(eventType => {
    const handler = activityHandler(`mouse:${eventType}`);
    document.addEventListener(eventType, handler, { capture: true, passive: true });
  });

  const keyboardEvents = ['keydown', 'keypress'];
  keyboardEvents.forEach(eventType => {
    const handler = activityHandler(`keyboard:${eventType}`);
    document.addEventListener(eventType, handler, { capture: true, passive: true });
  });

  // Mouse move (hover) in tracker window = activity; throttle to avoid spam (max once per 15s for idle reset)
  let lastMouseMoveActivityTime = 0;
  const MOUSE_MOVE_ACTIVITY_THROTTLE_MS = 15000;
  document.addEventListener('mousemove', () => {
    if (!isTracking || pauseStartPerfMs != null) return;
    const now = Date.now();
    if (now - lastMouseMoveActivityTime >= MOUSE_MOVE_ACTIVITY_THROTTLE_MS) {
      lastMouseMoveActivityTime = now;
      resetIdleTimer();
    }
  }, { capture: true, passive: true });
  
  // Performance optimization: Throttle statistics tracking to reduce overhead
  let lastMouseMoveTime = 0;
  let lastKeypressTime = 0;
  const STATS_THROTTLE_MS = 100; // Throttle to max once per 100ms
  
  document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastMouseMoveTime >= STATS_THROTTLE_MS) {
      mouseMovementCount++;
      lastMouseMoveTime = now;
    }
  }, { capture: true, passive: true });
  
  document.addEventListener('keypress', () => {
    const now = Date.now();
    if (now - lastKeypressTime >= STATS_THROTTLE_MS) {
      keystrokeCount++;
      lastKeypressTime = now;
    }
  }, { capture: true, passive: true });
}

// Reset idle timer when activity is detected (mouse click or keyboard key only).
function resetIdleTimer() {
  if (!isTracking) return;
  if (pauseStartPerfMs != null) return;

  const now = Date.now();
  const timeSinceLastUpdate = now - lastActivityTime;
  // Light 50ms debounce to avoid key-repeat spam; any single click/key still counts
  if (timeSinceLastUpdate > 50) {
    lastActivityTime = now;
    if (idleDoubleCheckTimer) {
      clearTimeout(idleDoubleCheckTimer);
      idleDoubleCheckTimer = null;
      console.log(`Activity detected (${Math.floor(timeSinceLastUpdate / 1000)}s since last) - cancelled idle double-check`);
    }
  }
}

// Activity = (1) mouse click, key press, or mouse move (hover) in THIS window, OR (2) system-wide from main, OR (3) fallback poll.
// (2) and (3) prevent "inactive" when user is in another app. Single key/click/hover anywhere count as activity.
ipcRenderer.on('system-activity-detected', (event, idleSeconds) => {
  if (!isTracking || pauseStartPerfMs != null) return;
  const now = Date.now();
  const timeSinceLastUpdate = now - lastActivityTime;
  if (timeSinceLastUpdate > 50) {
    lastActivityTime = now;
    if (idleDoubleCheckTimer) {
      clearTimeout(idleDoubleCheckTimer);
      idleDoubleCheckTimer = null;
      console.log(`System activity (idle=${idleSeconds != null ? idleSeconds.toFixed(1) : '?'}s) - cancelled idle double-check`);
    }
  }
});

// Fallback: poll system idle from renderer so we still detect activity if main's monitor misses (cross-platform via Electron).
let activityFallbackInterval = null;
function startActivityFallbackPoll() {
  if (activityFallbackInterval) return;
  const POLL_MS = 5000;
  const IDLE_ACTIVE_THRESHOLD_SEC = 30;
  activityFallbackInterval = setInterval(async () => {
    if (!isTracking || pauseStartPerfMs != null) return;
    try {
      const idleSeconds = await ipcRenderer.invoke('get-system-idle-time');
      if (typeof idleSeconds === 'number' && idleSeconds >= 0 && idleSeconds < IDLE_ACTIVE_THRESHOLD_SEC) {
        const now = Date.now();
        if (now - lastActivityTime > 50) {
          lastActivityTime = now;
          if (idleDoubleCheckTimer) {
            clearTimeout(idleDoubleCheckTimer);
            idleDoubleCheckTimer = null;
          }
        }
      }
    } catch (_) { /* ignore */ }
  }, POLL_MS);
}
function stopActivityFallbackPoll() {
  if (activityFallbackInterval) {
    clearInterval(activityFallbackInterval);
    activityFallbackInterval = null;
  }
}

// Setup activity listeners when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupActivityListeners);
} else {
  setupActivityListeners();
}

// IPC handlers for overlay
ipcRenderer.on('overlay-continue', async () => {
  if (isTracking && pauseStartPerfMs != null) {
    // Resume tracking if paused (inactivity scenario)
    resumeTracking();
    const name = getActivityDisplayName();
    writeUserLog(
      'idle_continue',
      `Tracker paused after 5 minutes of no activity. ${name} chose Continue`,
      {
        api_action: 'Resume tracking after inactivity',
        api_table: 'time_entries',
        api_operation: 'update',
        time_entry_id: timeEntryId,
        project_id: selectedProjectId,
        task_id: selectedTaskId,
        project_name: getSelectedWorkLabel().projectName,
        task_name: getSelectedWorkLabel().taskName
      }
    );
    // Close overlay after resuming
    await ipcRenderer.invoke('close-overlay').catch(err => {
      console.error('Error closing overlay:', err);
    });
  } else if (!isTracking) {
    // Start tracking if stopped (system event scenario)
    // Only start if project and task are selected
    if (selectedProjectId && selectedTaskId) {
      await startTracking();
      // Close overlay after starting
      await ipcRenderer.invoke('close-overlay').catch(err => {
        console.error('Error closing overlay:', err);
      });
    } else {
      alert('Please select a project and task before starting tracking.');
      // Close overlay even if can't start
      await ipcRenderer.invoke('close-overlay').catch(err => {
        console.error('Error closing overlay:', err);
      });
    }
  }
});

ipcRenderer.on('overlay-stop', async () => {
  if (isTracking) {
    if (pauseStartPerfMs != null) pauseStartPerfMs = null;
    const entryIdToUpdate = timeEntryId;
    await stopTracking({ skipActivityLog: true });

    // Inactivity Stop: fetch from DB, reduce by 5 min, write back, then show in tracker
    if (entryIdToUpdate) {
      let dbDurationSeconds = 0;
      if (isOnline) {
        try {
          const { data: entry, error } = await supabase
            .from('time_entries')
            .select('duration')
            .eq('id', entryIdToUpdate)
            .single();
          if (!error && entry != null) {
            dbDurationSeconds = Number(entry.duration) || 0;
          }
        } catch (e) {
          console.error('Overlay Stop: error fetching duration from DB', e);
        }
      }
      const FIVE_MIN_SEC = 5 * 60;
      const durationToReduce = dbDurationSeconds > 0 ? dbDurationSeconds : baseDuration;
      const reducedSeconds = Math.max(0, durationToReduce - FIVE_MIN_SEC);
      console.log(`Overlay Stop: DB duration=${dbDurationSeconds}s, after 5 min deduction=${reducedSeconds}s`);

      if (isOnline && durationToReduce > 0) {
        try {
          const { error: updateError } = await supabase
            .from('time_entries')
            .update({
              duration: reducedSeconds,
              updated_at: new Date().toISOString(),
              app_version: appVersion
            })
            .eq('id', entryIdToUpdate);
          if (updateError) {
            console.error('Overlay Stop: error saving reduced duration to DB', updateError);
          } else {
            console.log(`Overlay Stop: saved reduced duration to DB: ${reducedSeconds}s`);
          }
        } catch (e) {
          console.error('Overlay Stop: error updating DB', e);
        }
      }
      baseDuration = reducedSeconds;
      saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
        duration: reducedSeconds,
        timeEntryId: entryIdToUpdate,
        projectId: selectedProjectId,
        taskId: selectedTaskId
      });
      updateTimerDisplay(reducedSeconds);
      const name = getActivityDisplayName();
      writeUserLog(
        'idle_stop',
        `Tracker paused after 5 minutes of no activity. ${name} chose Stop. Time saved for today: ${formatDurationForLog(reducedSeconds)}`,
        {
          api_action: 'Stop tracking after inactivity',
          api_table: 'time_entries',
          api_operation: 'update',
          time_entry_id: entryIdToUpdate,
          duration_seconds: reducedSeconds,
          duration_label: formatDurationForLog(reducedSeconds),
          deducted_seconds: 300,
          project_id: selectedProjectId,
          task_id: selectedTaskId,
          project_name: getSelectedWorkLabel().projectName,
          task_name: getSelectedWorkLabel().taskName
        }
      );
    }
  }
  ipcRenderer.invoke('close-overlay').catch(err => {
    console.error('Error closing overlay:', err);
  });
});

// Handle system events (screen lock, sleep, shutdown, user switch)
ipcRenderer.on('system-event', async (event, data) => {
  const { type, reason } = data;
  
  if (!isTracking) {
    return; // Not tracking, ignore
  }
  
  console.log(`🛑 System event detected: ${type} - ${reason || 'No reason provided'}`);
  console.log('⏹️ Stopping tracker automatically...');
  
  // Stop tracking immediately
  try {
    await stopTracking();
    
    // Show notification to user
    if (statusDisplay) {
      statusDisplay.textContent = `Stopped: ${reason || type}`;
      statusDisplay.classList.remove('tracking');
      
      // Reset status message after 5 seconds
      setTimeout(() => {
        if (statusDisplay && !isTracking) {
          statusDisplay.textContent = 'Not Tracking';
        }
      }, 5000);
    }
    
    // Show overlay modal instead of alert
    const overlayMessages = {
      'screen-locked': {
        title: 'Screen Locked',
        message: 'Your screen was locked. Tracking has been stopped.',
        icon: '🔒'
      },
      'system-sleep': {
        title: 'System Sleep',
        message: 'Your PC entered sleep mode. Tracking has been stopped.',
        icon: '😴'
      },
      'system-shutdown': {
        title: 'System Shutdown',
        message: 'Your PC is shutting down. Tracking has been stopped.',
        icon: '🛑'
      },
      'user-switched': {
        title: 'User Switched',
        message: 'Windows user was switched. Tracking has been stopped.',
        icon: '👤'
      },
      'screen-off': {
        title: 'Screen Off',
        message: 'Your screen is off. Tracking has been stopped.',
        icon: '🖥️'
      },
      'app-quitting': {
        title: 'App Closing',
        message: 'The application is closing. Tracking has been stopped.',
        icon: '👋'
      }
    };
    
    const overlayConfig = overlayMessages[type] || {
      title: 'Tracking Stopped',
      message: reason || 'Tracking has been stopped automatically.',
      icon: '⏹️'
    };
    
    // Show overlay with custom message
    await ipcRenderer.invoke('show-overlay', {
      ...overlayConfig,
      isStopped: true // Indicates tracking is stopped (not paused)
    });
  } catch (error) {
    console.error('Error stopping tracking on system event:', error);
  }
});

// ============================================
// VERSION MANAGEMENT FUNCTIONS
// ============================================

let isVersionValid = false;
let versionCheckComplete = false;
let minimumRequiredVersion = null;
let downloadUrl = null;
let forceUpdate = false;

// Compare version strings (e.g., "1.4.0" vs "1.3.0")
function compareVersions(version1, version2) {
  const v1parts = version1.split('.').map(Number);
  const v2parts = version2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(v1parts.length, v2parts.length); i++) {
    const v1part = v1parts[i] || 0;
    const v2part = v2parts[i] || 0;
    
    if (v1part > v2part) return 1;
    if (v1part < v2part) return -1;
  }
  
  return 0;
}

// Fetch required version via RPC (bypasses RLS, avoids "infinite recursion in policy for relation profiles"). No fallback — if fetch fails, app is blocked.
async function checkAppVersion() {
  try {
    console.log(`🔍 Checking app version: ${TRACKER_VERSION} (Platform: ${appPlatform})`);

    const { data: requiredFromDb, error: rpcError } = await supabase.rpc('get_tracker_required_version');

    if (rpcError) {
      console.error('❌ Could not fetch tracker_required_version:', rpcError.message || rpcError.code || JSON.stringify(rpcError));
      isVersionValid = false;
      versionCheckComplete = true;
      return {
        valid: false,
        reason: 'version_check_failed',
        minimumVersion: '',
        currentVersion: TRACKER_VERSION,
        downloadUrl: null,
        downloadUrls: null,
        forceUpdate: true
      };
    }

    if (requiredFromDb == null || requiredFromDb === '') {
      console.error('❌ tracker_required_version not set in system_settings');
      isVersionValid = false;
      versionCheckComplete = true;
      return {
        valid: false,
        reason: 'version_check_skipped',
        minimumVersion: '',
        currentVersion: TRACKER_VERSION,
        downloadUrl: null,
        downloadUrls: null,
        forceUpdate: true
      };
    }

    const rawRequired = requiredFromDb;
    const requiredStr = typeof rawRequired === 'string' ? rawRequired.trim() : String(rawRequired);
    const parts = requiredStr.split('.').filter(Boolean);
    if (parts.length === 1) parts.push('0', '0');
    else if (parts.length === 2) parts.push('0');
    minimumRequiredVersion = parts.slice(0, 3).map(p => (parseInt(p, 10) || 0).toString()).join('.');

    if (!minimumRequiredVersion || !/^\d+\.\d+\.\d+$/.test(minimumRequiredVersion)) {
      console.error('❌ tracker_required_version invalid format:', rawRequired);
      isVersionValid = false;
      versionCheckComplete = true;
      return {
        valid: false,
        reason: 'version_check_skipped',
        minimumVersion: '',
        currentVersion: TRACKER_VERSION,
        downloadUrl: null,
        downloadUrls: null,
        forceUpdate: true
      };
    }

    console.log(`📋 Required version (from DB): ${minimumRequiredVersion}`);
    console.log(`📋 Current tracker version: ${TRACKER_VERSION}`);

    const versionComparison = compareVersions(TRACKER_VERSION, minimumRequiredVersion);

    // Exact match only: if not equal, show update modal (no "equal or greater" logic)
    if (versionComparison !== 0) {
      console.warn(`❌ Version mismatch: ${TRACKER_VERSION} !== ${minimumRequiredVersion} (exact match required) — showing update modal`);
      isVersionValid = false;
      versionCheckComplete = true;
      return {
        valid: false,
        reason: 'version_outdated',
        minimumVersion: minimumRequiredVersion,
        currentVersion: TRACKER_VERSION,
        downloadUrl: downloadUrl || null,
        downloadUrls: null,
        forceUpdate: true
      };
    }

    console.log(`✓ Version OK: exact match ${TRACKER_VERSION}`);
    isVersionValid = true;
    versionCheckComplete = true;
    return { valid: true, reason: 'version_valid' };
  } catch (error) {
    console.error('❌ Error checking app version:', error);
    isVersionValid = false;
    versionCheckComplete = true;
    return {
      valid: false,
      reason: 'version_check_error',
      minimumVersion: '',
      currentVersion: TRACKER_VERSION,
      downloadUrl: null,
      downloadUrls: null,
      forceUpdate: true
    };
  }
}

// Track version usage in database
async function trackVersionUsage() {
  if (!currentUser) {
    console.log('No user logged in, skipping version tracking');
    return;
  }
  
  try {
    console.log(`📊 Tracking version usage: ${appVersion} for user ${currentUser.id}`);
    
    // Check if record exists
    const { data: existingRecord } = await supabase
      .from('user_version_tracking')
      .select('id, session_count')
      .eq('user_id', currentUser.id)
      .eq('app_version', appVersion)
      .single();
    
    if (existingRecord) {
      // Update existing record
      const { error: updateError } = await supabase
        .from('user_version_tracking')
        .update({
          last_seen_at: new Date().toISOString(),
          session_count: (existingRecord.session_count || 0) + 1,
          platform: appPlatform,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingRecord.id);
      
      if (updateError) {
        console.error('Error updating version tracking:', updateError);
      } else {
        console.log('✓ Version tracking updated');
      }
    } else {
      // Insert new record
      const { error: insertError } = await supabase
        .from('user_version_tracking')
        .insert({
          user_id: currentUser.id,
          app_version: appVersion,
          platform: appPlatform,
          last_seen_at: new Date().toISOString(),
          first_seen_at: new Date().toISOString(),
          session_count: 1
        });
      
      if (insertError) {
        console.error('Error inserting version tracking:', insertError);
      } else {
        console.log('✓ Version tracking created');
      }
    }
  } catch (error) {
    console.error('❌ Error tracking version usage:', error);
    // Don't block app if tracking fails
  }
}

// Show update required modal when app version is below tracker_required_version
function showUpdateRequiredModal(versionInfo) {
  const updateModal = document.getElementById('update-required-modal');
  const updateMessage = document.getElementById('update-message');
  const downloadBtn = document.getElementById('download-update-btn');
  const closeBtn = document.getElementById('close-app-btn');

  if (!updateModal || !updateMessage) {
    console.error('Update modal elements not found');
    if (typeof alert === 'function') {
      alert('Your current version is old please update to new version.');
    }
    return;
  }

  updateMessage.innerHTML = `
    <p>Your current version is old please update to new version.</p>
    ${versionInfo.forceUpdate ? '<p class="update-warning">⚠️ This update is mandatory. The application will not function until you update.</p>' : ''}
  `;

  const updateAppUrl = 'https://timeflow.mechlintech.com';
  if (downloadBtn) {
    downloadBtn.style.display = 'inline-block';
    downloadBtn.onclick = () => {
      tf.openExternal(updateAppUrl)
    };
  }

  if (closeBtn) {
    closeBtn.onclick = () => {
      ipcRenderer.invoke('close-window');
    };
  }

  // Ensure modal is visible: remove hidden, show overlay, block background
  document.body.style.pointerEvents = 'none';
  updateModal.style.pointerEvents = 'auto';
  updateModal.classList.remove('hidden');
  updateModal.style.display = '';
  updateModal.style.visibility = 'visible';
  updateModal.style.opacity = '1';
  requestAnimationFrame(() => {
    updateModal.classList.remove('hidden');
    updateModal.style.display = 'flex';
  });
}

// Show camera/screenshot permission modal (same style as overlay: gradient, icon, title, message, buttons)
// customMessage: body text; reason: 'device' | 'permission' | 'screenshot' for behavior and button labels
function showCameraDetectionModal(customMessage, reason) {
  const cameraModal = document.getElementById('camera-detection-modal');
  const cameraMessage = document.getElementById('camera-message');
  const cameraTitle = document.getElementById('camera-modal-title');
  const cameraIcon = document.getElementById('camera-modal-icon');
  const retryBtn = document.getElementById('camera-retry-btn');
  const closeCameraModalBtn = document.getElementById('close-camera-modal-btn');
  
  if (!cameraModal || !cameraMessage) {
    console.error('Camera detection modal elements not found');
    alert(customMessage || 'No camera device detected. Please connect a camera to start tracking.');
    return;
  }
  
  const defaultMessage = 'No camera device detected. Please connect a camera to start tracking.';
  if (cameraIcon) cameraIcon.textContent = reason === 'screenshot' ? '🖥️' : '📷';
  if (cameraTitle) {
    if (reason === 'screenshot') cameraTitle.textContent = 'Screenshot access required';
    else if (reason === 'face') cameraTitle.textContent = 'Camera covered or blur';
    else if (reason === 'permission' || (customMessage && customMessage.includes('Allow desktop apps'))) cameraTitle.textContent = 'Camera access required';
    else cameraTitle.textContent = 'Camera Required';
  }
  cameraMessage.textContent = customMessage || defaultMessage;
  
  if (retryBtn) retryBtn.textContent = (reason === 'permission' || reason === 'screenshot') ? 'Start Tracking' : (reason === 'face' ? 'OK' : 'Retry');
  
  // Setup retry button based on reason
  if (retryBtn) {
    if (reason === 'permission') {
      retryBtn.onclick = async () => {
        const result = await checkCameraPermission();
        if (result.granted) {
          hideCameraDetectionModal();
          if (lastPermissionCheck) lastPermissionCheck.cameraOk = true;
          updateStartButtonState();
          await startTracking();
        } else {
          cameraMessage.textContent =
            'Camera access is still not allowed.\n\n' +
            'Please turn ON "Allow desktop apps to access your camera" in Windows Settings → Privacy → Camera, then click Retry again. You may need to restart the app.';
        }
      };
    } else if (reason === 'screenshot') {
      retryBtn.onclick = async () => {
        const result = await checkScreenshotPermission();
        if (result.granted) {
          hideCameraDetectionModal();
          if (lastPermissionCheck) lastPermissionCheck.screenshotOk = true;
          updateStartButtonState();
          await startTracking();
        } else {
          cameraMessage.textContent = (result.error || 'Screenshot access is still not allowed.') + '\n\nEnable screen recording in Windows Settings → Privacy, then click Start Tracking again.';
        }
      };
    } else if (reason === 'face') {
      retryBtn.onclick = () => {
        hideCameraDetectionModal();
      };
    } else {
      retryBtn.onclick = async () => {
        const cameraCheck = await checkCameraDevice();
        if (cameraCheck.detected) {
          hideCameraDetectionModal();
          await startTracking();
        } else {
          cameraMessage.textContent = cameraCheck.error || defaultMessage;
        }
      };
    }
  }
  
  // Setup close button
  if (closeCameraModalBtn) {
    closeCameraModalBtn.onclick = () => {
      hideCameraDetectionModal();
    };
  }
  
  // Force modal visible and on top (in case .hidden or parent hides it)
  cameraModal.classList.remove('hidden');
  cameraModal.style.display = 'flex';
  cameraModal.style.visibility = 'visible';
  cameraModal.style.zIndex = '100000';
  cameraModal.style.pointerEvents = 'auto';
  
  // Block background interactions
  document.body.style.pointerEvents = 'none';
  cameraModal.style.pointerEvents = 'auto';
}

// Show camera permission dialog (same style as "Camera black" overlay: gradient, icon, title, message, Start Tracking + Close)
function showCameraPermissionRequiredModal() {
  const steps = getOSInstructions();
  const cameraSteps = (steps && steps.camera)
    ? steps.camera.join('\n• ')
    : 'Privacy → Camera → Allow desktop apps to access your camera';
  const message =
    'The tracker cannot start because camera access is disabled in Windows.';
  const modal = document.getElementById('camera-detection-modal');
  if (!modal) {
    alert('Camera access required\n\n' + message);
    return;
  }
  showCameraDetectionModal(message, 'permission');
}

// Show screenshot permission dialog (same style: gradient, icon, title, message, Start Tracking + Close)
function showScreenshotPermissionRequiredModal() {
  const steps = getOSInstructions();
  const screenshotSteps = (steps && steps.screenshot)
    ? steps.screenshot.join('\n• ')
    : 'Privacy → Screen recording → Allow desktop apps to record screen';
  const message =
    'The tracker cannot start because screenshot/screen recording access is disabled or not allowed.\n\n' +
    'To fix this:\n\n' +
    '• ' + screenshotSteps + '\n\n' +
    'After enabling, click "Start Tracking" below to try again. You may need to restart the app.';
  const modal = document.getElementById('camera-detection-modal');
  if (!modal) {
    alert('Screenshot access required\n\n' + message);
    return;
  }
  showCameraDetectionModal(message, 'screenshot');
}

// Hide camera detection modal
function hideCameraDetectionModal() {
  const cameraModal = document.getElementById('camera-detection-modal');
  if (cameraModal) {
    cameraModal.classList.add('hidden');
    cameraModal.style.display = '';
    cameraModal.style.visibility = '';
    cameraModal.style.zIndex = '';
    document.body.style.pointerEvents = 'auto';
  }
}

async function checkAuth() {
  try {
    console.log('Checking authentication...');
    if (!loadingContainer || !loginContainer || !dashboardContainer) {
      console.error('DOM containers not ready');
      return;
    }
    // Show loading state while checking
    loadingContainer.classList.remove('hidden');
    loginContainer.classList.add('hidden');
    dashboardContainer.classList.add('hidden');

    // Version check: fetch required version from DB (tracker_required_version), then compare. No fallback — fetch failure blocks app.
    const versionCheck = await checkAppVersion();
    if (!versionCheck.valid) {
      console.error('❌ Version check failed, blocking app access');
      if (loadingContainer) loadingContainer.classList.add('hidden');
      if (loginContainer) loginContainer.classList.add('hidden');
      if (dashboardContainer) dashboardContainer.classList.add('hidden');
      showUpdateRequiredModal({
        currentVersion: versionCheck.currentVersion,
        minimumVersion: versionCheck.minimumVersion,
        downloadUrl: versionCheck.downloadUrl,
        downloadUrls: versionCheck.downloadUrls,
        forceUpdate: versionCheck.forceUpdate
      });
      return;
    }

    const { data: { session }, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error('Error checking session:', error);
      showLogin();
      return;
    }
    
    if (session) {
      console.log('Session found, user:', session.user.email);
      currentUser = session.user;
      
      // Track version usage after login
      await trackVersionUsage();
      
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
  if (!isVersionValid) return;
  if (loadingContainer) loadingContainer.classList.add('hidden');
  if (loginContainer) loginContainer.classList.remove('hidden');
  if (dashboardContainer) dashboardContainer.classList.add('hidden');
}

async function showDashboard() {
  if (loadingContainer) loadingContainer.classList.add('hidden');
  if (loginContainer) loginContainer.classList.add('hidden');
  if (dashboardContainer) dashboardContainer.classList.remove('hidden');
  
  // Display app version
  if (versionText) {
    versionText.textContent = `v${appVersion}`;
  }
  
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
  
  // Initialize capture settings
  await initializeCaptureSettings(currentUser.id);
  
  // Fetch projects assigned to user
  await loadProjects();
  
  // Setup network monitoring
  setupNetworkMonitoring();
  
  // CRITICAL: Validate day cycle on startup (handles forced shutdowns)
  // This ensures we never load stale data from previous day after PC restart
  console.log('🔄 Validating day cycle on startup...');
  const startupDayCycle = getCurrentDayCycle();
  
  // Clear ALL old local storage entries on startup (safety measure)
  if (currentUser) {
    clearAllOldLocalStorage(currentUser.id, startupDayCycle.dateString);
    console.log('🧹 Cleared all old local storage entries on startup');
  }
  
  // Initialize day cycle
  currentDayCycle = startupDayCycle;
  
  // Reset state to ensure clean start (especially after forced shutdown)
  // If tracking was active when PC shut down, we don't want to resume with old data
  baseDuration = 0;
  baseDurationAtSessionStart = 0;
  timeEntryId = null;
  isTracking = false; // Ensure tracking is stopped on startup
  
  // Update UI to show reset state
  updateDayCycleDisplay();
  updateTimerDisplay(0);
  if (statusDisplay) {
    statusDisplay.textContent = 'Not Tracking';
    statusDisplay.classList.remove('tracking');
  }
  
  // Now load last time entry (will validate day cycle again); await so we show correct day/session
  await loadLastTimeEntry();
  
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
    
    // Track version usage after successful login
    await trackVersionUsage();
    
    await showDashboard();
    writeUserLog('login', `${getActivityDisplayName()} logged in with email and password`, {
      api_action: 'Sign in',
      api_table: 'auth',
      api_operation: 'signIn',
      login_method: 'email_password',
      user_email: currentUser && currentUser.email
    });
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
        await showDashboard();
        writeUserLog('login', `${getActivityDisplayName()} logged in with Azure SSO`, {
          api_action: 'Sign in',
          api_table: 'auth',
          api_operation: 'setSession',
          login_method: 'azure_sso',
          user_email: currentUser && currentUser.email
        });
        
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
  // Cleanup capture settings subscription
  cleanupCaptureSettings();
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
    if (captureTimeoutId) {
      clearTimeout(captureTimeoutId);
      captureTimeoutId = null;
    }
    if (captureWatchdogInterval) {
      clearInterval(captureWatchdogInterval);
      captureWatchdogInterval = null;
    }
    if (realTimeUpdateInterval) {
      clearInterval(realTimeUpdateInterval);
      realTimeUpdateInterval = null;
    }
    if (systemActivitySyncInterval) {
      clearInterval(systemActivitySyncInterval);
      systemActivitySyncInterval = null;
    }
    
    // Write the logout log while the session is still valid
    await writeUserLog('logout', `${getActivityDisplayName()} logged out of the desktop app`, {
      api_action: 'Sign out',
      api_table: 'auth',
      api_operation: 'signOut',
      user_email: currentUser && currentUser.email
    });

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
    sessionStartPerfMs = null;
    pauseStartPerfMs = null;
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

  if (projectId) {
    const selectedProject = projects.find((item) => item && item.id === projectId);
    writeUserLog(
      'project_selected',
      `${getActivityDisplayName()} selected project ${(selectedProject && selectedProject.name) || 'a project'}`,
      {
        api_action: 'Select project',
        api_table: 'projects',
        api_operation: 'read',
        project_id: projectId,
        project_name: (selectedProject && selectedProject.name) || null
      }
    );
  }
}

// Handle task selection change
function handleTaskChange(event) {
  if (!event || !event.target) return;
  
  selectedTaskId = event.target.value || null;
  updateTaskDisplay();
  updateStartButtonState();

  if (selectedTaskId) {
    const selectedTask = tasks.find((item) => item && item.id === selectedTaskId);
    const work = getSelectedWorkLabel();
    writeUserLog(
      'task_selected',
      `${getActivityDisplayName()} selected task ${(selectedTask && selectedTask.name) || 'a task'} on ${work.projectName}`,
      {
        api_action: 'Select task',
        api_table: 'tasks',
        api_operation: 'read',
        project_id: selectedProjectId,
        project_name: work.projectName,
        task_id: selectedTaskId,
        task_name: (selectedTask && selectedTask.name) || null
      }
    );
  }
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

// Update start button state based on selections (permission does not disable button so user can click and see error dialog)
function updateStartButtonState() {
  if (isTracking) {
    startBtn.disabled = true;
    return;
  }
  if (!selectedProjectId || !selectedTaskId) {
    startBtn.disabled = true;
    startBtn.title = 'Please select a project and task to start tracking';
    return;
  }
  // Keep Start button enabled so user can click and get the error popup; set tooltip when permission is missing
  if (lastPermissionCheck && !lastPermissionCheck.cameraOk) {
    startBtn.title = 'Enable camera access in Windows Settings (Privacy → Camera) to start tracking';
  } else if (lastPermissionCheck && !lastPermissionCheck.screenshotOk) {
    startBtn.title = 'Please enable screenshot permission to start tracking';
  } else {
    startBtn.title = 'Start Tracking';
  }
  startBtn.disabled = false;
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

  // ALWAYS get the current day cycle first
  const newDayCycle = getCurrentDayCycle();
  
  // Check if we need to reset (new day cycle) - this works even if currentDayCycle is null
  const dayCycleChanged = !currentDayCycle || currentDayCycle.dateString !== newDayCycle.dateString;
  
  if (dayCycleChanged) {
    // New day cycle - reset everything
    console.log('🔄 New day cycle detected, resetting:', {
      old: currentDayCycle ? currentDayCycle.dateString : 'null',
      new: newDayCycle.dateString
    });
    
    // Clear ALL old local storage data for this user (cleanup old entries)
    if (currentUser) {
      clearAllOldLocalStorage(currentUser.id, newDayCycle.dateString);
      
      // Also clear the specific old day cycle if it exists
      if (currentDayCycle) {
        clearLocalStorage(currentUser.id, currentDayCycle.dateString);
      }
    }
    
    // Reset all state
    currentDayCycle = newDayCycle;
    baseDuration = 0;
    baseDurationAtSessionStart = 0;
    timeEntryId = null;
    
    // Update UI immediately
    updateDayCycleDisplay();
    updateTimerDisplay(0);
    
    // Continue to load data for the NEW day cycle (should be empty)
    // Don't return here - we want to check for new day's data
  } else {
    // Same day cycle - just update reference
    currentDayCycle = newDayCycle;
  }

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
  // BUT validate it's for the correct day cycle AND that stored timeEntryId belongs to this day
  const localData = loadFromLocalStorage(currentUser.id, currentDayCycle.dateString);
  let localDuration = 0;
  let localTimeEntryId = null;
  
  // CRITICAL: Validate local storage data is for the CURRENT day cycle
  if (localData) {
    // Check if the stored dateString matches current day cycle
    if (localData.dateString && localData.dateString === currentDayCycle.dateString) {
      // Additional validation: Check if data is too old (more than 24 hours)
      const now = new Date();
      const dataAge = localData.lastUpdated ? (now.getTime() - localData.lastUpdated) : Infinity;
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
      
      if (dataAge > maxAge) {
        console.warn('⚠️ Local storage data is too old (>24 hours), clearing it:', {
          ageHours: Math.floor(dataAge / (60 * 60 * 1000)),
          dateString: localData.dateString
        });
        clearLocalStorage(currentUser.id, currentDayCycle.dateString);
        localDuration = 0;
        localTimeEntryId = null;
      } else if (localData.timeEntryId && isOnline) {
        // Stored timeEntryId may be from a previous bug (e.g. yesterday's entry saved under today's date).
        // Validate that this entry actually started in the current day cycle; if not, discard local data.
        try {
          const { data: entry, error } = await supabase
            .from('time_entries')
            .select('start_time')
            .eq('id', localData.timeEntryId)
            .eq('user_id', profile.id)
            .single();
          if (error || !entry || !entry.start_time) {
            clearLocalStorage(currentUser.id, currentDayCycle.dateString);
            localDuration = 0;
            localTimeEntryId = null;
          } else {
            const entryStartMs = new Date(entry.start_time).getTime();
            const cycleStartMs = currentDayCycle.start.getTime();
            const cycleEndMs = currentDayCycle.end.getTime();
            if (entryStartMs < cycleStartMs || entryStartMs > cycleEndMs) {
              console.warn('⚠️ Local storage timeEntryId is from a different day (wrong session), clearing:', {
                entryStart: entry.start_time,
                dateString: currentDayCycle.dateString
              });
              clearLocalStorage(currentUser.id, currentDayCycle.dateString);
              localDuration = 0;
              localTimeEntryId = null;
            } else {
              localDuration = localData.duration || 0;
              localTimeEntryId = localData.timeEntryId || null;
            }
          }
        } catch (e) {
          console.warn('⚠️ Could not validate local storage timeEntryId, discarding local data:', e.message);
          clearLocalStorage(currentUser.id, currentDayCycle.dateString);
          localDuration = 0;
          localTimeEntryId = null;
        }
      } else {
        // No timeEntryId in local, or offline - use as-is (dateString already matches)
        localDuration = localData.duration || 0;
        localTimeEntryId = localData.timeEntryId || null;
      }
    } else {
      // Data is for a different day - clear it and don't use it
      console.warn('⚠️ Local storage data is for a different day cycle, clearing it:', {
        stored: localData.dateString,
        current: currentDayCycle.dateString
      });
      clearLocalStorage(currentUser.id, localData.dateString || currentDayCycle.dateString);
      localDuration = 0;
      localTimeEntryId = null;
    }
  }

  // Try to fetch from Supabase (if online)
  let remoteDuration = 0;
  let remoteTimeEntryId = null;
  
  if (isOnline) {
    try {
      // Only load entries that STARTED in the current day cycle (one session per calendar day).
      // Do NOT query by updated_at: the previous day's entry gets updated at day change, so its
      // updated_at would be in the new day and we'd wrongly reuse it (old time, no new DB entry).
      const cycleStartISO = currentDayCycle.start.toISOString();
      const cycleEndISO = currentDayCycle.end.toISOString();

      const { data: timeEntriesByStart, error: error1 } = await supabase
        .from('time_entries')
        .select('id, user_id, start_time, end_time, duration, created_at, updated_at')
        .eq('user_id', profile.id)
        .gte('start_time', cycleStartISO)
        .lte('start_time', cycleEndISO)
        .order('updated_at', { ascending: false })
        .limit(10);

      const allEntries = timeEntriesByStart || [];

      if (allEntries.length > 0) {
        // Use the most recent entry that started in this cycle
        const matchingEntry = allEntries[0];
        // Defensive: only use entry if start_time is actually inside current day cycle (handles timezone/DB quirks)
        const entryStart = matchingEntry.start_time ? new Date(matchingEntry.start_time).getTime() : 0;
        const cycleStartMs = currentDayCycle.start.getTime();
        const cycleEndMs = currentDayCycle.end.getTime();
        if (entryStart < cycleStartMs || entryStart > cycleEndMs) {
          console.warn('⚠️ Ignoring entry that is outside current day cycle (wrong day):', {
            entryStart: matchingEntry.start_time,
            cycleStart: cycleStartISO,
            cycleEnd: cycleEndISO,
            dateString: currentDayCycle.dateString
          });
          remoteDuration = 0;
          remoteTimeEntryId = null;
        } else {
          remoteDuration = matchingEntry.duration || 0;
          remoteTimeEntryId = matchingEntry.id;
        }
        
        if (remoteTimeEntryId && isOnline) {
          // Restore project from project_time_entries if it exists
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
        }
      } else {
        console.log('ℹ️ No time entry found for current day cycle:', currentDayCycle.dateString);
        if (error1) console.error('Error querying by start_time:', error1);
      }
    } catch (error) {
      console.error('❌ Error fetching time entries:', error);
      isOnline = false; // Mark as offline if fetch fails
    }
  }

  // Validation already done above - this check is redundant but kept for safety
  if (localData && localData.dateString && localData.dateString !== currentDayCycle.dateString) {
    console.warn('⚠️ Additional validation: Local storage data mismatch detected, clearing:', {
      stored: localData.dateString,
      current: currentDayCycle.dateString
    });
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

    // Try to get camera access (uses same fallback as capture for Windows 11 / HP TrueVision)
    const stream = await getCameraStreamWithFallback(10000);
    
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
      // Timeout: could be permission denied (e.g. Windows dialog not shown) or camera slow - treat as not granted so user sees the modal
      return { granted: false, error: 'Camera access failed (timeout). Please enable camera in Windows Settings → Privacy → Camera.' };
    } else {
      // Any other error (e.g. SecurityError when Windows blocks): show permission modal so user knows what to fix
      console.warn('Camera check failed:', errorDetails);
      return { granted: false, error: error.message || 'Camera access denied. Please allow camera in your system settings.' };
    }
  }
}

// Check if camera device is actually detected (not just permission)
async function checkCameraDevice() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return { detected: false, error: 'Camera API not available' };
    }

    // Enumerate devices to check if camera hardware exists
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    
    if (videoDevices.length === 0) {
      return { detected: false, error: 'No camera device found. Please connect a camera to start tracking.' };
    }

    // Try to access the camera to verify it's actually available (fallback for Windows 11 / HP TrueVision)
    try {
      const stream = await getCameraStreamWithFallback(5000);
      
      // If successful, stop the stream immediately
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(track => {
          track.stop();
          track.enabled = false;
        });
      }
      
      return { detected: true };
    } catch (accessError) {
      if (accessError.name === 'NotFoundError' || accessError.name === 'DevicesNotFoundError') {
        return { detected: false, error: 'No camera device found. Please connect a camera to start tracking.' };
      }
      // Windows "Allow desktop apps to access your camera" off → NotAllowedError
      if (accessError.name === 'NotAllowedError' || accessError.name === 'PermissionDeniedError') {
        return {
          detected: false,
          error: 'Camera access is blocked. Please enable "Allow desktop apps to access your camera" in Windows Settings → Privacy → Camera, then restart the app.'
        };
      }
      // For other errors (e.g. in use), device exists but can't access
      return { detected: true, warning: 'Camera device found but may be in use or requires permission.' };
    }
  } catch (error) {
    console.error('Error checking camera device:', error);
    return { detected: false, error: 'Unable to check for camera device. Please ensure a camera is connected.' };
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
  lastPermissionCheck = { cameraOk, screenshotOk: screenshotResult.granted };

  // Update start button state (will check both permissions and project/task selection)
  updateStartButtonState();

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

  // Check screenshot permission first – show same-style popup if missing
  const screenshotResult = await checkScreenshotPermission();
  if (!screenshotResult.granted) {
    showScreenshotPermissionRequiredModal();
    return;
  }

  // On Windows, run a one-off screenshot so screenshot-desktop can copy its .bat to temp if needed
  // (avoids ENOENT after user clears temp files – the package copies screenCapture_*.bat to temp on first use)
  if (process.platform === 'win32') {
    screenshot({ format: 'png' }).catch(() => {});
  }

  // Always capture camera; require Windows camera permission and a detected device
  const cameraPermission = await checkCameraPermission();
  if (!cameraPermission.granted) {
    showCameraPermissionRequiredModal();
    return;
  }
  console.log('Checking for camera device...');
  const cameraCheck = await checkCameraDevice();
  if (!cameraCheck.detected) {
    showCameraDetectionModal(cameraCheck.error);
    return;
  }

  // Face check: do not start unless a face is detected
  const faceDetected = await checkFaceBeforeStart();
  if (!faceDetected) {
    showCameraDetectionModal('Camera appears covered or blurry. Please ensure the camera has a clear view.', 'face');
    return;
  }

  // CRITICAL: Always check day cycle FIRST before starting tracking
  // This ensures we never start tracking with old day's data
  const newDayCycle = getCurrentDayCycle();
  const dayCycleChanged = !currentDayCycle || currentDayCycle.dateString !== newDayCycle.dateString;
  
  if (dayCycleChanged) {
    // New day cycle detected - reset everything and reload
    console.log('🔄 Day cycle changed before starting tracking, resetting:', {
      old: currentDayCycle ? currentDayCycle.dateString : 'null',
      new: newDayCycle.dateString
    });
    
    // Clear old local storage
    if (currentUser) {
      clearAllOldLocalStorage(currentUser.id, newDayCycle.dateString);
      if (currentDayCycle) {
        clearLocalStorage(currentUser.id, currentDayCycle.dateString);
      }
    }
    
    // Reset state
    currentDayCycle = newDayCycle;
    baseDuration = 0;
    baseDurationAtSessionStart = 0;
    timeEntryId = null;
    
    // Reload for new day cycle (should be empty)
    await loadLastTimeEntry();
    
    // Update UI
    updateDayCycleDisplay();
    updateTimerDisplay(0);
  }

  isTracking = true;
  sessionStartTime = new Date();
  sessionStartPerfMs = performance.now();
  baseDurationAtSessionStart = baseDuration; // Store base duration at session start
  pausedDuration = 0;
  pauseStartPerfMs = null;
  lastActivityTime = Date.now(); // Initialize with current time
  console.log('Tracking started - lastActivityTime initialized to:', new Date(lastActivityTime).toLocaleTimeString());
  mouseMovementCount = 0;
  keystrokeCount = 0;
  // Reset screen comparer state so auto-stop uses fresh baseline
  lastContentHashForComparer = null;
  consecutiveSameScreenCount = 0;
  cameraSkippedDueToInUse = false;

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
            updated_at: sessionStartTime.toISOString(),
            app_version: appVersion // Track which version of the tracker updated this entry
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
            duration: baseDuration, // Start with cumulative duration (should be 0 for new day)
            app_version: appVersion // Track which version of the tracker created this entry
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
  startActivityFallbackPoll();

  // Start periodic captures (every 5-7 minutes)
  startPeriodicCaptures();

  // Start real-time updates (every 30 seconds)
  startRealTimeUpdates();
  
  // Start screen state monitoring
  startScreenStateMonitoring();

  const work = getSelectedWorkLabel();
  writeUserLog(
    'tracking_start',
    `${getActivityDisplayName()} started tracking on ${work.label}`,
    {
      api_action: 'Start time tracking',
      api_table: 'time_entries',
      api_operation: timeEntryId ? 'update' : 'insert',
      time_entry_id: timeEntryId,
      project_id: selectedProjectId,
      project_name: work.projectName,
      task_id: selectedTaskId,
      task_name: work.taskName,
      day_cycle: currentDayCycle && currentDayCycle.dateString
    }
  );
}

async function stopTracking(options = {}) {
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
  stopActivityFallbackPoll();
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (captureTimeoutId) {
    clearTimeout(captureTimeoutId);
    captureTimeoutId = null;
  }
  if (captureWatchdogInterval) {
    clearInterval(captureWatchdogInterval);
    captureWatchdogInterval = null;
  }
  if (systemActivitySyncInterval) {
    clearInterval(systemActivitySyncInterval);
    systemActivitySyncInterval = null;
  }
  
  // Stop screen state monitoring
  stopScreenStateMonitoring();
  
  // Wait a brief moment to ensure any pending async operations complete
  await new Promise(resolve => setTimeout(resolve, 100));

  // Calculate session duration (subtract paused time)
  const endTime = new Date();
  let sessionDuration = 0;
  
  if (sessionStartTime) {
    // Close any in-progress pause using monotonic clock (same basis as pausedDuration)
    if (pauseStartPerfMs != null) {
      pausedDuration += performance.now() - pauseStartPerfMs;
      pauseStartPerfMs = null;
    }
    sessionDuration = getMonotonicSessionSeconds();
    console.log(`Stop tracking - Session duration calculation:`, {
      pausedTimeSeconds: Math.floor(pausedDuration / 1000),
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
  console.log(`Stop tracking - Paused duration (inactive time excluded): ${Math.floor(pausedDuration / 1000)}s`);

  // CRITICAL: If we have pausedDuration (inactive time was deducted), we must trust our calculated duration
  // Don't let old values from Supabase/local storage override the corrected duration
  const localData = loadFromLocalStorage(currentUser.id, currentDayCycle.dateString);
  const currentMax = localData ? Math.max(localData.duration || 0, baseDuration) : baseDuration;
  let finalDuration;
  
  if (pausedDuration > 0) {
    // Inactive time was deducted - trust our calculated duration
    // Only use local/remote if it's higher (shouldn't happen, but safety check)
    // Use our calculated duration, but ensure we don't go below what we already have synced
    finalDuration = Math.max(cumulativeDuration, currentMax);
    console.log(`⚠️ Inactive time was deducted - using calculated duration: ${finalDuration}s (paused: ${Math.floor(pausedDuration / 1000)}s)`);
  } else {
    // No inactive time deducted - use normal max duration logic
    finalDuration = ensureMaxDuration(currentMax, cumulativeDuration);
  }
  
  // Safety check: If tracking was active but duration is 0, something went wrong
  // Use the currentMax as a fallback to prevent losing existing duration
  if (finalDuration === 0 && currentMax > 0) {
    console.warn('Warning: Calculated duration is 0 but currentMax is', currentMax, '- using currentMax as fallback');
    finalDuration = currentMax;
  }
  
  // Additional safety: If we have a sessionStartTime but duration is 0, calculate minimum 1 second
  if (finalDuration === 0 && sessionStartTime && sessionDuration === 0) {
    const minDuration = Math.max(1, getMonotonicSessionSeconds());
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
        
        // CRITICAL FIX: If inactive time was deducted (pausedDuration > 0), we must use our calculated duration
        // The remote duration might still have the old value (before inactivity deduction)
        // Only use ensureMaxDuration if no inactive time was deducted
        let maxDuration;
        if (pausedDuration > 0) {
          // Inactive time was deducted - trust our calculated finalDuration
          // The remote value might be stale (includes inactive time)
          maxDuration = Math.max(finalDuration, remoteDuration);
          console.log(`⚠️ Inactive time was deducted - using calculated duration: ${finalDuration}s instead of potentially stale remote: ${remoteDuration}s`);
        } else {
          // No inactive time deducted - use normal max logic
          maxDuration = ensureMaxDuration(remoteDuration, finalDuration);
        }
        
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
              updated_at: updateTimestamp,
              app_version: appVersion // Track which version of the tracker updated this entry
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
                  updated_at: new Date().toISOString(),
                  app_version: appVersion // Track which version of the tracker updated this entry
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
          
          // CRITICAL: Reset pausedDuration after successful sync to prevent it from affecting future calculations
          pausedDuration = 0;
          
          // Mark as synced in local storage
          saveToLocalStorage(currentUser.id, currentDayCycle.dateString, {
            duration: maxDuration,
            timeEntryId: timeEntryId,
            projectId: selectedProjectId,
            taskId: selectedTaskId,
            synced: true
          });
          console.log(`✓ Final duration synced to Supabase: ${formatDurationFromSeconds(maxDuration)} (${maxDuration} seconds)`);
          console.log(`✓ Paused duration reset to 0 after successful sync`);
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
  sessionStartPerfMs = null;
  baseDurationAtSessionStart = 0;
  // CRITICAL: Reset pausedDuration after stopping to prevent it from affecting future sessions
  // Note: This is reset here as a safety measure, but should already be reset after successful sync above
  pausedDuration = 0;
  pauseStartPerfMs = null;
  
  // Clear the stopping flag
  isStoppingTracking = false;
  
  console.log(`✓ Tracking stopped. Final duration: ${formatDurationFromSeconds(baseDuration)}s. Paused duration reset.`);

  if (!options.skipActivityLog) {
    const work = getSelectedWorkLabel();
    const durationLabel = formatDurationForLog(baseDuration);
    writeUserLog(
      'tracking_stop',
      `${getActivityDisplayName()} stopped tracking. Time saved for today: ${durationLabel}`,
      {
        api_action: 'Stop time tracking',
        api_table: 'time_entries',
        api_operation: 'update',
        time_entry_id: timeEntryId,
        duration_seconds: baseDuration,
        duration_label: durationLabel,
        project_id: selectedProjectId,
        project_name: work.projectName,
        task_id: selectedTaskId,
        task_name: work.taskName,
        day_cycle: currentDayCycle && currentDayCycle.dateString
      }
    );
  }
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
    if (pauseStartPerfMs != null) {
      idleTimer = setTimeout(checkIdle, 5000);
      return;
    }

    const now = Date.now();
    const timeSinceLastActivity = now - lastActivityTime;

    if (timeSinceLastActivity > IDLE_THRESHOLD - 10000 && timeSinceLastActivity < IDLE_THRESHOLD + 10000) {
      console.log(`Idle check: ${Math.floor(timeSinceLastActivity / 1000)}s since last mouse/keyboard activity (threshold: ${IDLE_THRESHOLD / 1000}s)`);
    }

    // Inactivity = no activity for 5 min. Activity = (A) mouse click/key in this window OR (B) system-wide mouse/key (main process). No low/high - any event counts.
    if (timeSinceLastActivity >= IDLE_THRESHOLD) {
      if (!idleDoubleCheckTimer) {
        console.log(`Idle threshold reached (${Math.floor(timeSinceLastActivity / 1000)}s), starting double-check...`);
        const doubleCheckDelay = 3000;
        idleDoubleCheckTimer = setTimeout(async () => {
          idleDoubleCheckTimer = null;
          if (!isTracking || pauseStartPerfMs != null) return;

          const recheckTime = Date.now();
          const recheckTimeSinceActivity = recheckTime - lastActivityTime;
          console.log(`Double-check: ${Math.floor(recheckTimeSinceActivity / 1000)}s since last activity`);
          const shouldShowOverlay = recheckTimeSinceActivity >= IDLE_THRESHOLD;

          if (shouldShowOverlay) {
          // Pause tracking (no time deduction here - deduction only on Stop)
          pauseStartPerfMs = performance.now();
      
          // Stop timer and captures
          if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
          }
          if (captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
          }
          if (captureTimeoutId) {
            clearTimeout(captureTimeoutId);
            captureTimeoutId = null;
          }

          // Sync current duration to DB (no deduction - time unchanged)
          await syncCurrentDuration();

          // Show overlay - Continue = resume with no time change; Stop = deduct 5 min and stop
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
      
      // User must click Continue (resume, no deduction) or Stop (deduct 5 min and stop).
    }
    
    // Schedule next check (5s is enough - idle threshold is 5 min; reduces CPU load)
    idleTimer = setTimeout(checkIdle, 5000);
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
  
  // Start checking every 5s (was 1s - reduces load without affecting 5-min idle detection)
  idleTimer = setTimeout(checkIdle, 5000);
}

// Resume tracking after inactivity (called when user clicks Continue)
async function resumeTracking() {
  if (!isTracking || pauseStartPerfMs == null) return;

  const now = Date.now();
  // Exclude time while inactivity modal was open from tracked time (don't add it when they click Continue)
  pausedDuration += performance.now() - pauseStartPerfMs;
  pauseStartPerfMs = null;

  // Sync current duration to DB (duration = up to last activity, no time added for modal-open period)
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
  
  // Always restart idle detection so the second (and later) inactivity periods are detected.
  // When paused, we kept rescheduling checkIdle every second so idleTimer was never null,
  // so we previously never called startIdleDetection() on resume; that chain can stop or
  // be throttled when the overlay had focus, so the popup didn't show again.
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (idleDoubleCheckTimer) {
    clearTimeout(idleDoubleCheckTimer);
    idleDoubleCheckTimer = null;
  }
  startIdleDetection();
  
  // Update status
  if (statusDisplay) {
    statusDisplay.textContent = 'Tracking';
    statusDisplay.classList.add('tracking');
  }
  

  console.log('Tracking resumed (Continue) - no time deduction, synced to DB');
}

function startTimer() {
  // Clear any existing timer first
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // Performance optimization: Throttle UI updates to 1 second (monotonic throttle)
  let lastUpdatePerfMs = performance.now();

  timerInterval = setInterval(() => {
    if (sessionStartTime && pauseStartPerfMs == null && isTracking) {
      const sessionDuration = getMonotonicSessionSeconds();
      const totalDuration = baseDurationAtSessionStart + sessionDuration;
      const perfNow = performance.now();
      if (perfNow - lastUpdatePerfMs >= 1000) {
        updateTimerDisplay(totalDuration);
        lastUpdatePerfMs = perfNow;
      }
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


// Capture interval: 5-7 minutes (user expectation). Min used for catch-up threshold.
const CAPTURE_INTERVAL_MIN_MS = 5 * 60 * 1000;
const CAPTURE_INTERVAL_MAX_MS = 7 * 60 * 1000;

function getNextCaptureDelayMs() {
  return CAPTURE_INTERVAL_MIN_MS + Math.floor(Math.random() * (CAPTURE_INTERVAL_MAX_MS - CAPTURE_INTERVAL_MIN_MS + 1));
}

function scheduleNextCapture() {
  if (!isTracking || pauseStartPerfMs != null || !timeEntryId) return;
  const delay = getNextCaptureDelayMs(); // 5–7 min for all cycles (including after camera was in use)
  if (cameraSkippedDueToInUse) cameraSkippedDueToInUse = false;
  captureTimeoutId = setTimeout(() => {
    captureTimeoutId = null;
    if (isTracking && timeEntryId) {
      captureScreenshotAndCamera()
        .then(() => { scheduleNextCapture(); })
        .catch(err => {
          console.warn('Periodic capture failed, will retry on next interval:', err);
          scheduleNextCapture();
        });
    }
  }, delay);
  console.log(`Next capture in ${Math.round(delay / 60000)} min`);
}

function startPeriodicCaptures() {
  // Clear any existing interval/timeout to prevent duplicates
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (captureTimeoutId) {
    clearTimeout(captureTimeoutId);
    captureTimeoutId = null;
  }

  // Capture immediately on start
  captureScreenshotAndCamera()
    .then(() => { scheduleNextCapture(); })
    .catch(err => {
      console.warn('Initial capture failed, will retry on next interval:', err);
      scheduleNextCapture();
    });

  // Start watchdog: restart capture loop if it was lost (e.g. after app was in background and timers throttled)
  if (captureWatchdogInterval) {
    clearInterval(captureWatchdogInterval);
    captureWatchdogInterval = null;
  }
  const WATCHDOG_MS = 60 * 1000; // Check every 1 minute
  const STUCK_CAPTURE_THRESHOLD_MS = 8 * 60 * 1000; // No successful capture in 8 min = stuck (was 12 – restart sooner)
  captureWatchdogInterval = setInterval(() => {
    if (!isTracking || pauseStartPerfMs != null || !timeEntryId) return;
    const now = Date.now();
    const timeSinceLastCapture = now - lastCaptureTime;
    // If capture is stuck (in progress or scheduled but no capture completed in 12+ min), restart loop
    if (timeSinceLastCapture >= STUCK_CAPTURE_THRESHOLD_MS) {
      console.warn(`Capture appears stuck (last capture ${Math.round(timeSinceLastCapture / 60000)} min ago) - restarting periodic captures`);
      if (captureInProgress) captureInProgress = false;
      if (captureTimeoutId) {
        clearTimeout(captureTimeoutId);
        captureTimeoutId = null;
      }
      startPeriodicCaptures();
      return;
    }
    if (captureTimeoutId !== null || captureInProgress) return; // Loop is running or capture in progress
    console.warn('Capture loop was lost (no scheduled capture) - restarting periodic captures');
    startPeriodicCaptures();
  }, WATCHDOG_MS);

  console.log('Periodic captures started - will capture every 5-7 minutes (after each capture completes)');
}

/**
 * Get a hash of the screenshot content region (excludes taskbar) for "same image" comparison.
 * Returns null if sharp is unavailable or processing fails.
 */
async function getContentHashFromBuffer(buffer) {
  return tf.imageContentHash(buffer, TASKBAR_HEIGHT_PX, COMPARE_RESIZE_WIDTH)
}

/**
 * Returns true if the screenshot appears to be a black (or near-black) screen.
 * Uses a downscaled sample to avoid high memory use.
 */
async function isBlackScreenBuffer(buffer) {
  return tf.imageIsBlackScreen(buffer)
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

  captureInProgress = true;
  try {
    await captureScreenshotAndCameraImpl();
  } finally {
    captureInProgress = false;
    // Mark cycle complete so watchdog and catch-up use "last completed" time, not start time
    lastCaptureTime = Date.now();
  }
}

async function captureScreenshotAndCameraImpl() {
  console.log('Capturing screenshot and camera (always on)');

  // Try to capture all screens with multiple fallback strategies
  let screensCaptured = 0;
  const timestamp = Date.now();

  try {
    // Performance optimization: Use cached display configuration if available
    let displays = [];
    const now = Date.now();
    
    // Check if we have a valid cached display configuration
    if (cachedDisplays && (now - displayCacheTimestamp) < DISPLAY_CACHE_DURATION) {
      displays = cachedDisplays;
      console.log(`Using cached display configuration: ${displays.length} display(s)`);
    } else {
      // Strategy 1: Try to get all displays using listDisplays()
      try {
        if (typeof screenshot.listDisplays === 'function') {
          displays = await screenshot.listDisplays();
          console.log(`Found ${displays.length} display(s) using listDisplays()`);
          
          // Cache the display configuration
          if (displays && displays.length > 0) {
            cachedDisplays = displays;
            displayCacheTimestamp = now;
          }
        }
      } catch (listError) {
        console.warn('Could not list displays, falling back to all screens capture:', listError.message || listError);
      }
    }

    // Strategy 2: If listDisplays failed or returned empty, try capturing screens by index
    // Performance optimization: Limit to 4 screens max and break early on consecutive failures
    if (!displays || displays.length === 0) {
      console.log('Attempting to capture screens by index (fallback method)...');
      let consecutiveFailures = 0;
      const MAX_SCREENS = 4; // Optimized: Limit to 4 screens (most users have 1-2)
      
      for (let screenIndex = 0; screenIndex < MAX_SCREENS; screenIndex++) {
        try {
          const testBuffer = await screenshot({ screen: screenIndex, format: 'png' });
          if (testBuffer && testBuffer.length > 0) {
            displays.push({ id: screenIndex, name: `Screen ${screenIndex}` });
            console.log(`Found screen at index ${screenIndex}`);
            consecutiveFailures = 0; // Reset on success
          } else {
            consecutiveFailures++;
          }
        } catch (screenError) {
          consecutiveFailures++;
          // If screen 0 fails, break immediately (no primary screen)
          if (screenIndex === 0) {
            break;
          }
          // If 2 consecutive failures after finding screens, likely no more screens
          if (consecutiveFailures >= 2 && displays.length > 0) {
            break;
          }
        }
      }
    }

    // Strategy 3: If no displays found, try primary screen capture
    if (displays.length === 0) {
      console.log('No displays detected, attempting primary screen capture...');
      try {
        const primaryBuffer = await screenshot({ format: 'png' });
        if (primaryBuffer && primaryBuffer.length > 0) {
          displays = [{ id: 0, name: 'Primary Screen' }];
          console.log('Captured primary screen');
        }
      } catch (primaryError) {
        console.warn('Primary screen capture failed:', primaryError.message || primaryError);
      }
    }

    // Strategy 4: If screenshot-desktop completely fails, use Electron's desktopCapturer
    if (displays.length === 0) {
      console.log('screenshot-desktop failed, trying Electron desktopCapturer fallback...');
      try {
        const sources = await ipcRenderer.invoke('get-desktop-sources', {
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        });
        
        if (sources && sources.length > 0) {
          console.log(`Found ${sources.length} screen source(s) using Electron desktopCapturer`);
          for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            const screenshotBuffer = await captureScreenshotWithElectron(source.id);
            if (screenshotBuffer) {
              // Screen comparer: on first screen, check black and unchanged then maybe auto-stop
              if (i === 0 && sharp) {
                const black = await isBlackScreenBuffer(screenshotBuffer);
                if (black) {
                  console.log('Screen comparer: black screen detected - stopping tracker');
                  await stopTracking();
                  if (statusDisplay) statusDisplay.textContent = 'Stopped: Screen is black';
                  await ipcRenderer.invoke('show-overlay', {
                    title: 'Black screen',
                    message: 'Your screen appears off or black. Tracking has been stopped.',
                    icon: '🖥️',
                    isStopped: true
                  });
                  return;
                }
                const contentHash = await getContentHashFromBuffer(screenshotBuffer);
                if (contentHash !== null) {
                  if (contentHash === lastContentHashForComparer) consecutiveSameScreenCount++;
                  else consecutiveSameScreenCount = 0;
                  lastContentHashForComparer = contentHash;
                  const cooldownPassed = sessionStartPerfMs != null && (performance.now() - sessionStartPerfMs) >= SCREEN_COMPARER_COOLDOWN_MS;
                  const isActive = (Date.now() - lastActivityTime) < ACTIVE_FOR_SCREEN_COMPARE_MS;
                  if (consecutiveSameScreenCount >= CONSECUTIVE_SAME_THRESHOLD && cooldownPassed && isActive) {
                    console.log('Screen comparer: screen unchanged for consecutive captures - stopping tracker');
                    await stopTracking();
                    if (statusDisplay) statusDisplay.textContent = 'Stopped: Screen unchanged';
                    await ipcRenderer.invoke('show-overlay', {
                      title: 'Screen unchanged',
                      message: 'Your screen has not changed. Tracking has been stopped.',
                      icon: '🖥️',
                      isStopped: true
                    });
                    return;
                  }
                }
              }
              await uploadScreenshot(screenshotBuffer, `screen-${i}`, timestamp);
              screensCaptured++;
            }
          }
        }
      } catch (electronError) {
        console.warn('Electron desktopCapturer fallback also failed:', electronError.message || electronError);
      }
    } else {
      // Capture each detected screen
      for (let i = 0; i < displays.length; i++) {
        const display = displays[i];
        try {
          let screenshotBuffer;
          
          if (display.id !== undefined) {
            // Use screen index
            screenshotBuffer = await screenshot({ screen: display.id, format: 'png' });
          } else {
            // Fallback to primary screen
            screenshotBuffer = await screenshot({ format: 'png' });
          }

          if (screenshotBuffer && screenshotBuffer.length > 0) {
            // Performance optimization: Update cache if we successfully captured
            if (!cachedDisplays || cachedDisplays.length !== displays.length) {
              cachedDisplays = displays;
              displayCacheTimestamp = Date.now();
            }

            // Screen comparer: on first screen only, check black and unchanged then maybe auto-stop
            if (i === 0 && sharp) {
              const black = await isBlackScreenBuffer(screenshotBuffer);
              if (black) {
                console.log('Screen comparer: black screen detected - stopping tracker');
                await stopTracking();
                if (statusDisplay) statusDisplay.textContent = 'Stopped: Screen is black';
                await ipcRenderer.invoke('show-overlay', {
                  title: 'Black screen',
                  message: 'Your screen appears off or black. Tracking has been stopped.',
                  icon: '🖥️',
                  isStopped: true
                });
                return;
              }
              const contentHash = await getContentHashFromBuffer(screenshotBuffer);
              if (contentHash !== null) {
                if (contentHash === lastContentHashForComparer) consecutiveSameScreenCount++;
                else consecutiveSameScreenCount = 0;
                lastContentHashForComparer = contentHash;
                const cooldownPassed = sessionStartPerfMs != null && (performance.now() - sessionStartPerfMs) >= SCREEN_COMPARER_COOLDOWN_MS;
                const isActive = (Date.now() - lastActivityTime) < ACTIVE_FOR_SCREEN_COMPARE_MS;
                if (consecutiveSameScreenCount >= CONSECUTIVE_SAME_THRESHOLD && cooldownPassed && isActive) {
                  console.log('Screen comparer: screen unchanged for consecutive captures - stopping tracker');
                  await stopTracking();
                  if (statusDisplay) statusDisplay.textContent = 'Stopped: Screen unchanged';
                  await ipcRenderer.invoke('show-overlay', {
                    title: 'Screen unchanged',
                    message: 'Your screen has not changed. Tracking has been stopped.',
                    icon: '🖥️',
                    isStopped: true
                  });
                  return;
                }
              }
            }

            await uploadScreenshot(screenshotBuffer, `screen-${i}`, timestamp);
            screensCaptured++;
            console.log(`✓ Captured screen ${i + 1}/${displays.length}: ${display.name || `Screen ${i}`}`);
          }
        } catch (screenCaptureError) {
          console.warn(`Error capturing screen ${i + 1}:`, screenCaptureError.message || screenCaptureError);
          // Continue with other screens even if one fails
        }
      }
    }

    if (screensCaptured > 0) {
      console.log(`✓ Successfully captured ${screensCaptured} screen(s)`);
    } else {
      console.warn('⚠ No screens were captured - all methods failed');
    }

    // Capture camera (continue even if screenshot had issues)
    await captureCamera();

  } catch (error) {
    console.warn('Error capturing screenshots (continuing with camera):', error.message || error);
    try {
      await captureCamera();
    } catch (cameraError) {
      console.warn('Error capturing camera:', cameraError.message || cameraError);
    }
  }
}

// Helper: run a promise with a timeout so API/network hangs don't block the capture loop
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label || 'Operation'} timed out after ${ms}ms`)), ms)
    )
  ]);
}

const CAMERA_UPLOAD_TIMEOUT_MS = 45000; // 45s – avoid capture loop hanging on slow API
const UPLOAD_TIMEOUT_MS = 60000; // 60s so rate-limited API can still succeed
const UPLOAD_RETRY_DELAY_MS = 1000; // Delay before single retry (screenshot and camera): first try, one retry, then exit

/** Screenshot storage HTTP API (screenshot-storage-server). Set in .env for production. */
function getScreenshotStorageServerBaseUrl() {
  return String(tf.env.SCREENSHOT_STORAGE_SERVER_URL || 'https://timeflowstorage.mechlintech.com').replace(
    /\/$/,
    ''
  );
}

/**
 * Upload image to local/cloud screenshot server: timeflow-screenshots/{screenshots|camera}/{uuid}/file.png
 * Matches Supabase storage_path shape so the web app can resolve URLs via VITE_SCREENSHOT_STORAGE_BASE_URL.
 */
async function uploadBufferToScreenshotServer(buffer, { type, uuid, fileBaseName }) {
  const base = getScreenshotStorageServerBaseUrl();
  const formData = new FormData();
  formData.append('type', type);
  formData.append('uuid', uuid);
  formData.append('filename', fileBaseName);
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const blob = new Blob([bytes], { type: 'image/png' });
  formData.append('file', blob, fileBaseName);

  let accessToken = null;
  try {
    const { data } = await supabase.auth.getSession();
    accessToken = data?.session?.access_token || null;
  } catch (_) {
    /* ignore */
  }

  const headers = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Screenshot server upload failed (${res.status}): ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Screenshot server returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// Screenshot: first attempt, one retry on failure, then exit (no further retries to avoid data inconsistency)
async function uploadScreenshot(screenshotBuffer, screenIdentifier, timestamp) {
  if (!screenshotBuffer || screenshotBuffer.length === 0) {
    throw new Error('Screenshot buffer is empty');
  }

  const screenshotPath = path.join(os.tmpdir(), `screenshot-${timestamp}-${screenIdentifier}.png`);
  fs.writeFileSync(screenshotPath, screenshotBuffer);

  if (!fs.existsSync(screenshotPath)) {
    throw new Error('Screenshot file was not created');
  }

  try {
    const fileBaseName = `${timestamp}-${screenIdentifier}-screenshot.png`;
    const storagePathForDb = `screenshots/${currentUser.id}/${fileBaseName}`;
    const screenshotFile = fs.readFileSync(screenshotPath);

    const runUpload = () =>
      withTimeout(
        uploadBufferToScreenshotServer(screenshotFile, {
          type: 'screenshots',
          uuid: currentUser.id,
          fileBaseName,
        }),
        UPLOAD_TIMEOUT_MS,
        'Screenshot storage upload'
      );

    let uploadOk = false;
    try {
      await runUpload();
      uploadOk = true;
    } catch (e) {
      console.warn('Screenshot upload failed, retrying once:', e.message || e);
      await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAY_MS));
      try {
        await runUpload();
        uploadOk = true;
      } catch (e2) {
        console.warn('Screenshot upload retry failed, skipping this capture:', e2.message || e2);
      }
    }

    if (!uploadOk) {
      return;
    }

    const { error: insertError } = await supabase.from('screenshots').insert({
      time_entry_id: timeEntryId,
      storage_path: storagePathForDb,
      type: 'screenshot',
      taken_at: new Date().toISOString(),
    });
    if (insertError) {
      console.error('Error inserting screenshot record:', insertError);
    } else {
      writeUserLog('screenshot', `${getActivityDisplayName()} saved a screenshot`, {
        api_action: 'Upload screenshot',
        api_table: 'screenshots',
        api_operation: 'insert',
        time_entry_id: timeEntryId,
        storage_path: storagePathForDb,
        capture_type: 'screenshot'
      });
    }
  } finally {
    if (fs.existsSync(screenshotPath)) {
      try {
        fs.unlinkSync(screenshotPath);
      } catch (unlinkError) {
        console.warn('Error deleting temp screenshot file:', unlinkError);
      }
    }
  }
}

// Helper function to capture screenshot using Electron's desktopCapturer
async function captureScreenshotWithElectron(sourceId) {
  try {
    // Request desktop capture stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      }
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // Required for autoplay in some browsers

    // Wait for video to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Video load timeout'));
      }, 10000);

      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        video.play().then(resolve).catch(reject);
      };
      video.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });

    // Create canvas and draw video frame
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Stop the stream immediately
    stream.getTracks().forEach(track => {
      track.stop();
    });
    video.srcObject = null;

    // Convert canvas to buffer using toDataURL (more reliable than toBlob in Electron)
    return new Promise((resolve) => {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        // Convert data URL to buffer
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        resolve(buffer);
      } catch (error) {
        console.warn('Error converting canvas to buffer:', error);
        resolve(null);
      }
    });
  } catch (error) {
    console.warn('Error capturing screenshot with Electron desktopCapturer:', error.message || error);
    return null;
  }
}

// Get camera stream with fallbacks for Windows 11 (e.g. HP TrueVision not reporting facingMode).
// Tries: (1) facingMode 'user', (2) each video device by deviceId, (3) video: true.
async function getCameraStreamWithFallback(timeoutMs) {
  const timeout = timeoutMs || 10000;
  const baseConstraints = {
    width: { ideal: 640, max: 1280 },
    height: { ideal: 480, max: 720 }
  };

  const tryGetUserMedia = (constraints) =>
    Promise.race([
      navigator.mediaDevices.getUserMedia(constraints),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Camera access timeout')), timeout))
    ]);

  try {
    const stream = await tryGetUserMedia({
      video: { ...baseConstraints, facingMode: 'user' }
    });
    if (stream) return stream;
  } catch (firstErr) {
    const isOverconstrained = firstErr.name === 'OverconstrainedError' || (firstErr.message && firstErr.message.includes('Constraint'));
    const isNotFound = firstErr.name === 'NotFoundError' || firstErr.name === 'DevicesNotFoundError';
    if (!isOverconstrained && !isNotFound) throw firstErr;

    console.warn('Camera (facingMode user) failed, trying by deviceId (Windows 11 fallback):', firstErr.message || firstErr.name);
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter(d => d.kind === 'videoinput');
  for (const device of videoInputs) {
    if (!device.deviceId) continue;
    try {
      const stream = await tryGetUserMedia({
        video: { ...baseConstraints, deviceId: device.deviceId ? { exact: device.deviceId } : undefined }
      });
      if (stream) {
        console.log('Camera obtained by deviceId (e.g. HP TrueVision on Windows 11):', device.label || device.deviceId);
        return stream;
      }
    } catch (_) {
      continue;
    }
  }

  return tryGetUserMedia({ video: true });
}

/** One-off face check before starting tracker. Returns true if face detected. Releases stream. */
async function checkFaceBeforeStart() {
  let stream = null;
  let video = null;
  try {
    stream = await getCameraStreamWithFallback(8000);
    video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.muted = true;
    video.setAttribute('playsinline', 'true');
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    document.body.appendChild(video);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Video timeout')), 5000);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(t);
        video.play().then(() => setTimeout(resolve, 250)).catch(reject);
      }, { once: true });
      video.onerror = () => { clearTimeout(t); reject(new Error('Video error')); };
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const hasFace = await detectFaceInCanvas(canvas);
    return hasFace;
  } catch (err) {
    console.warn('Face check before start failed:', err.message);
    return true; // do not block start on errors
  } finally {
    if (stream && stream.getTracks) stream.getTracks().forEach(t => { t.stop(); });
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
        if (video.parentNode) video.parentNode.removeChild(video);
      } catch (_) {}
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
  
  console.log('Capturing camera (always on)');

  let stream = null;
  let video = null;

  try {
    console.log('Starting camera capture...');
    
    stream = await getCameraStreamWithFallback(10000);
    
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

    // Face check every 5–7 min: stop tracker if no face detected
    const faceDetected = await detectFaceInCanvas(canvas);
    if (!faceDetected) {
      console.log('Face detection: no face in camera - stopping tracker');
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(track => { try { track.stop(); } catch (e) {} });
      }
      if (video) {
        try { video.pause(); video.srcObject = null; if (video.parentNode) video.parentNode.removeChild(video); } catch (_) {}
      }
      video = null;
      stream = null;
      await stopTracking();
      if (statusDisplay) statusDisplay.textContent = 'Stopped: Camera covered or blur';
      await ipcRenderer.invoke('show-overlay', {
        title: 'Camera covered or blur',
        message: 'Your camera appears covered or blurry. Tracking has been stopped.',
        icon: '📷',
        isStopped: true
      });
      return;
    }

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

          const cameraTs = Date.now();
          const cameraBaseName = `${cameraTs}-camera.png`;
          const storagePathForDb = `camera/${currentUser.id}/${cameraBaseName}`;
          const cameraFile = fs.readFileSync(cameraPath);

          console.log(`Uploading camera capture to screenshot server: ${storagePathForDb}`);

          const runCameraUpload = () =>
            withTimeout(
              uploadBufferToScreenshotServer(cameraFile, {
                type: 'camera',
                uuid: currentUser.id,
                fileBaseName: cameraBaseName,
              }),
              CAMERA_UPLOAD_TIMEOUT_MS,
              'Camera storage upload'
            );

          let uploadOk = false;
          try {
            await runCameraUpload();
            uploadOk = true;
          } catch (cameraError) {
            console.warn('Camera upload failed, retrying once:', cameraError.message || cameraError);
            await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAY_MS));
            try {
              await runCameraUpload();
              uploadOk = true;
            } catch (cameraError2) {
              console.warn(
                'Camera upload retry failed, skipping this capture:',
                cameraError2.message || cameraError2
              );
            }
          }

          if (!uploadOk) {
            try {
              fs.unlinkSync(cameraPath);
            } catch (_) {}
            resolve();
            return;
          }

          console.log('Camera capture uploaded successfully:', storagePathForDb);

          const { error: insertError } = await supabase.from('screenshots').insert({
            time_entry_id: timeEntryId,
            storage_path: storagePathForDb,
            type: 'camera',
            taken_at: new Date().toISOString(),
          });

          if (insertError) {
            console.error('Error inserting camera record:', insertError);
          } else {
            console.log('Camera record inserted successfully');
            writeUserLog('camera', `${getActivityDisplayName()} saved a camera photo`, {
              api_action: 'Upload camera photo',
              api_table: 'screenshots',
              api_operation: 'insert',
              time_entry_id: timeEntryId,
              storage_path: storagePathForDb,
              capture_type: 'camera'
            });
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
    
    const likelyInUse = errorName === 'NotReadableError' ||
      /Could not start video source|in use|resource.*busy|device.*busy|overconstrained|timeout/i.test(errorMessage);
    if (likelyInUse) {
      // Camera in use (e.g. Teams/video call) – next capture in 90s so we resume when call ends
      console.warn('Camera is in use or temporarily unavailable:', errorMessage);
      cameraSkippedDueToInUse = true;
    } else if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
      // User disabled camera in Windows mid-session – stop tracking to prevent abuse
      console.warn('Camera permission revoked during tracking – stopping tracker:', errorMessage);
      await stopTracking();
      if (statusDisplay) statusDisplay.textContent = 'Stopped: Camera access disabled';
      await ipcRenderer.invoke('show-overlay', {
        title: 'Camera access disabled',
        message: 'Camera was turned off in Windows settings during tracking. Tracking has been stopped. Re-enable "Allow desktop apps to access your camera" to track again.',
        icon: '📷',
        isStopped: true
      });
      return;
    } else if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
      console.warn('No camera device found:', errorMessage);
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
  
  // Sync every 1 minute so user time is never lost (2 min was causing reported 4h -> 2-3h when app was in background or under load)
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
    if (pauseStartPerfMs != null) return;

    const sessionDuration = getMonotonicSessionSeconds();

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

        // Performance optimization: Only update if there's a meaningful change (more than 5 seconds)
        // AND if the calculated duration is greater than saved (never reduce)
        // This reduces unnecessary database writes
        if (Math.abs(maxDuration - savedDuration) > 5 && totalDuration > savedDuration) {
          console.log(`Real-time update: Updating duration from ${savedDuration}s to ${maxDuration}s`);
          const { error: updateError } = await supabase
            .from('time_entries')
            .update({
              duration: maxDuration,
              end_time: null, // Always NULL during active tracking
              updated_at: new Date().toISOString(),
              app_version: appVersion // Track which version of the tracker updated this entry
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
  }, 60000); // Every 1 minute - ensures time is never lost when app is in background or under load
  // First sync after 30s so we don't wait a full minute for initial persist
  setTimeout(() => {
    if (!currentUser || !currentDayCycle || !isTracking || isStoppingTracking || !timeEntryId || !sessionStartTime || pauseStartPerfMs != null) return;
    const sessionDuration = getMonotonicSessionSeconds();
    const totalDuration = baseDurationAtSessionStart + sessionDuration;
    saveToLocalStorage(currentUser.id, currentDayCycle.dateString, { duration: totalDuration, timeEntryId: timeEntryId });
    if (isOnline) syncCurrentDuration().catch(() => {});
  }, 30000);
}

// Helper function to sync current duration to Supabase
async function syncCurrentDuration() {
  if (!isTracking || !timeEntryId || !sessionStartTime) return false;

  try {
    const sessionDuration = getMonotonicSessionSeconds();
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
        
        // CRITICAL FIX: If inactive time was deducted (pausedDuration > 0), trust our calculated duration
        // The saved duration might still include inactive time if sync hasn't completed yet
        let maxDuration;
        if (pausedDuration > 0) {
          // Inactive time was deducted - our calculated totalDuration is correct
          // Only use savedDuration if it's actually higher (shouldn't happen after sync, but safety check)
          maxDuration = Math.max(totalDuration, savedDuration);
          console.log(`⚠️ syncCurrentDuration: Inactive time deducted - using calculated: ${totalDuration}s, saved: ${savedDuration}s`);
        } else {
          // No inactive time deducted - use normal max logic
          maxDuration = Math.max(savedDuration, totalDuration);
        }

        // Update if there's a meaningful change (more than 1 second)
        if (Math.abs(maxDuration - savedDuration) > 1) {
          const { error: updateError } = await supabase
            .from('time_entries')
            .update({
              duration: maxDuration,
              updated_at: new Date().toISOString(),
              app_version: appVersion // Track which version of the tracker updated this entry
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

  dailyResetCheckInterval = setInterval(async () => {
    if (!currentUser) return;

    const newDayCycle = getCurrentDayCycle();
    
    // Check if day cycle has changed - works even if currentDayCycle is null
    const dayCycleChanged = !currentDayCycle || currentDayCycle.dateString !== newDayCycle.dateString;
    
    if (dayCycleChanged) {
      // New day detected - stop current tracking (saves to old day's session), then reset for new day
      const wasTracking = isTracking;
      console.log('🔄 New day detected (date change) - resetting tracking:', {
        old: currentDayCycle ? currentDayCycle.dateString : 'null',
        new: newDayCycle.dateString,
        wasTracking
      });
      
      if (wasTracking) {
        console.log('Stopping active tracking due to day cycle change');
        await stopTracking();
      }
      
      // Clear ALL old local storage entries
      clearAllOldLocalStorage(currentUser.id, newDayCycle.dateString);
      if (currentDayCycle) {
        clearLocalStorage(currentUser.id, currentDayCycle.dateString);
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
      
      if (!wasTracking) {
        statusDisplay.textContent = 'Not Tracking';
        statusDisplay.classList.remove('tracking');
      } else if (selectedProjectId && selectedTaskId) {
        // Auto-start tracker for the new day so user doesn't have to click Start again
        console.log('🔄 Auto-starting tracker for new day');
        await startTracking();
        console.log('✅ Day cycle reset complete - auto-started for new day');
      } else {
        statusDisplay.textContent = 'Not Tracking';
        statusDisplay.classList.remove('tracking');
        console.log('✅ Day cycle reset complete - timer reset to 00:00:00 (project/task not selected, not auto-starting)');
      }
    }
  }, 60000); // Optimized: Check every 60 seconds (reduced from 30 seconds for better performance)
}

/**
 * Immediate screenshot + camera evidence for a DevTools access attempt.
 * Does not require tracking to be active. Skips face/black-screen auto-stop.
 * Returns paths/ids for activity log metadata.
 */
async function captureDevToolsEvidence() {
  const evidence = {
    screenshot_storage_path: null,
    screenshot_id: null,
    camera_storage_path: null,
    camera_id: null,
    screenshot_error: null,
    camera_error: null,
    time_entry_id: typeof timeEntryId !== 'undefined' ? timeEntryId : null,
    capture_reason: 'devtools_attempt',
  };

  if (!currentUser || !currentUser.id) {
    evidence.screenshot_error = 'not_logged_in';
    evidence.camera_error = 'not_logged_in';
    return evidence;
  }

  const timestamp = Date.now();
  let entryId = evidence.time_entry_id;

  if (!entryId) {
    try {
      const { data: latest } = await supabase
        .from('time_entries')
        .select('id')
        .eq('user_id', currentUser.id)
        .order('start_time', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest && latest.id) {
        entryId = latest.id;
        evidence.time_entry_id = entryId;
      }
    } catch (_) {
      /* ignore */
    }
  }

  // --- Screenshot (primary display) ---
  try {
    let screenshotBuffer = null;
    try {
      screenshotBuffer = await screenshot({ format: 'png' });
    } catch (primaryErr) {
      console.warn('DevTools evidence primary screenshot failed, trying Electron:', primaryErr.message || primaryErr);
      try {
        const sources = await ipcRenderer.invoke('get-desktop-sources', {
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 },
        });
        if (sources && sources.length > 0) {
          screenshotBuffer = await captureScreenshotWithElectron(sources[0].id);
        }
      } catch (electronErr) {
        throw electronErr;
      }
    }

    if (!screenshotBuffer || screenshotBuffer.length === 0) {
      throw new Error('Empty screenshot buffer');
    }

    const fileBaseName = `${timestamp}-devtools-screenshot.png`;
    const storagePathForDb = `screenshots/${currentUser.id}/${fileBaseName}`;
    const tmpPath = path.join(os.tmpdir(), fileBaseName);
    fs.writeFileSync(tmpPath, screenshotBuffer);

    try {
      const fileBytes = fs.readFileSync(tmpPath);
      const runUpload = () =>
        withTimeout(
          uploadBufferToScreenshotServer(fileBytes, {
            type: 'screenshots',
            uuid: currentUser.id,
            fileBaseName,
          }),
          UPLOAD_TIMEOUT_MS,
          'DevTools screenshot upload'
        );

      let uploadOk = false;
      try {
        await runUpload();
        uploadOk = true;
      } catch (e) {
        await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAY_MS));
        await runUpload();
        uploadOk = true;
      }

      if (uploadOk) {
        evidence.screenshot_storage_path = storagePathForDb;
        const row = {
          storage_path: storagePathForDb,
          type: 'screenshot',
          taken_at: new Date().toISOString(),
          user_id: currentUser.id,
        };
        if (entryId) row.time_entry_id = entryId;

        const { data: inserted, error: insertError } = await supabase
          .from('screenshots')
          .insert(row)
          .select('id')
          .maybeSingle();

        if (insertError) {
          console.warn('DevTools screenshot DB insert failed:', insertError.message || insertError);
          evidence.screenshot_error = insertError.message || 'insert_failed';
        } else if (inserted && inserted.id) {
          evidence.screenshot_id = inserted.id;
        }
      }
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('DevTools screenshot evidence failed:', err.message || err);
    evidence.screenshot_error = err.message || String(err);
  }

  // --- Camera ---
  let stream = null;
  let video = null;
  try {
    stream = await getCameraStreamWithFallback(8000);
    video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.setAttribute('playsinline', 'true');
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    document.body.appendChild(video);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Camera video timeout')), 5000);
      const onReady = () => {
        clearTimeout(timeout);
        video.play().then(() => setTimeout(resolve, 300)).catch(reject);
      };
      video.addEventListener('loadedmetadata', onReady, { once: true });
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Camera video error'));
      };
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    if (stream && stream.getTracks) {
      stream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
      });
    }
    stream = null;
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
        if (video.parentNode) video.parentNode.removeChild(video);
      } catch (_) {}
      video = null;
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 0.95));
    if (!blob) throw new Error('Camera canvas empty');

    const buffer = Buffer.from(await blob.arrayBuffer());
    if (!buffer.length) throw new Error('Camera buffer empty');

    const cameraBaseName = `${timestamp}-devtools-camera.png`;
    const storagePathForDb = `camera/${currentUser.id}/${cameraBaseName}`;
    const cameraPath = path.join(os.tmpdir(), cameraBaseName);
    fs.writeFileSync(cameraPath, buffer);

    try {
      const cameraFile = fs.readFileSync(cameraPath);
      const runCameraUpload = () =>
        withTimeout(
          uploadBufferToScreenshotServer(cameraFile, {
            type: 'camera',
            uuid: currentUser.id,
            fileBaseName: cameraBaseName,
          }),
          CAMERA_UPLOAD_TIMEOUT_MS,
          'DevTools camera upload'
        );

      try {
        await runCameraUpload();
      } catch (e) {
        await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAY_MS));
        await runCameraUpload();
      }

      evidence.camera_storage_path = storagePathForDb;
      const row = {
        storage_path: storagePathForDb,
        type: 'camera',
        taken_at: new Date().toISOString(),
        user_id: currentUser.id,
      };
      if (entryId) row.time_entry_id = entryId;

      const { data: inserted, error: insertError } = await supabase
        .from('screenshots')
        .insert(row)
        .select('id')
        .maybeSingle();

      if (insertError) {
        console.warn('DevTools camera DB insert failed:', insertError.message || insertError);
        evidence.camera_error = insertError.message || 'insert_failed';
      } else if (inserted && inserted.id) {
        evidence.camera_id = inserted.id;
      }
    } finally {
      if (fs.existsSync(cameraPath)) {
        try { fs.unlinkSync(cameraPath); } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('DevTools camera evidence failed:', err.message || err);
    evidence.camera_error = err.message || String(err);
    if (stream && stream.getTracks) {
      stream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
      });
    }
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
        if (video.parentNode) video.parentNode.removeChild(video);
      } catch (_) {}
    }
  }

  return evidence;
}

// --- DevTools deterrent: block shortcuts, warn, log to activity ---
(function setupDevToolsGuard() {
  let lastLogAt = 0;
  let captureInFlight = false;

  function showWarning() {
    const modal = document.getElementById('devtools-warning-modal');
    if (modal) modal.classList.remove('hidden');
  }

  function hideWarning() {
    const modal = document.getElementById('devtools-warning-modal');
    if (modal) modal.classList.add('hidden');
  }

  function collectClientInfo(extra) {
    const nav = navigator || {};
    const scr = screen || {};
    return Object.assign({
      href: location && location.href,
      pathname: location && location.pathname,
      language: nav.language || null,
      platform: nav.platform || null,
      user_agent: nav.userAgent || null,
      hardware_concurrency: nav.hardwareConcurrency || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset_min: new Date().getTimezoneOffset(),
      screen_width: scr.width || null,
      screen_height: scr.height || null,
      window_inner_width: window.innerWidth,
      window_inner_height: window.innerHeight,
      window_outer_width: window.outerWidth,
      window_outer_height: window.outerHeight,
      device_pixel_ratio: window.devicePixelRatio,
      app_version: typeof appVersion !== 'undefined' ? appVersion : null,
      recorded_at_client: new Date().toISOString(),
      source: 'desktop',
      api_action: 'DevTools / inspector access attempt',
      api_table: 'user_logs',
      api_operation: 'security_event',
    }, extra || {});
  }

  async function report(trigger, extra) {
    showWarning();
    const now = Date.now();
    if (now - lastLogAt < 8000) return;
    lastLogAt = now;

    if (!currentUser || !currentUser.id) return;

    let evidence = {};
    if (!captureInFlight) {
      captureInFlight = true;
      try {
        evidence = await captureDevToolsEvidence();
      } catch (err) {
        console.warn('DevTools evidence capture failed:', err && err.message);
        evidence = { capture_error: (err && err.message) || String(err) };
      } finally {
        captureInFlight = false;
      }
    }

    const info = collectClientInfo(Object.assign({
      trigger: trigger,
      actor_id: currentUser.id,
      actor_email: currentUser.email || null,
      actor_name: getActivityDisplayName(),
      actor_role: currentUser.role || null,
    }, extra || {}, evidence || {}));

    writeUserLog(
      'devtools_attempt',
      `${getActivityDisplayName()} attempted to open developer tools (${trigger}). Action captured.`,
      info
    );
  }

  document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    const blocked =
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['i', 'j', 'c', 'k'].includes(key)) ||
      (e.metaKey && e.altKey && ['i', 'j', 'c'].includes(key)) ||
      ((e.ctrlKey || e.metaKey) && key === 'u');
    if (!blocked) return;
    e.preventDefault();
    e.stopPropagation();
    void report('keyboard_shortcut', {
      key: e.key,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
    });
  }, true);

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void report('context_menu');
  }, true);

  const modal = document.getElementById('devtools-warning-modal');
  if (modal) {
    modal.addEventListener('click', () => hideWarning());
  }

  if (window.timeflow && window.timeflow.ipc && typeof window.timeflow.ipc.on === 'function') {
    try {
      window.timeflow.ipc.on('devtools-blocked', (_event, payload) => {
        void report((payload && payload.trigger) || 'main_process_block', payload || {});
      });
    } catch (err) {
      console.warn('DevTools IPC listener failed:', err && err.message);
    }
  }
})();

