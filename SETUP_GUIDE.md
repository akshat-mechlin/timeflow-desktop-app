# Mechlin TimeFlow - Setup & Installation Guide

This guide explains how to install and use Mechlin TimeFlow on different Windows devices.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Installation](#installation)
3. [First-Time Setup](#first-time-setup)
4. [Using the Application](#using-the-application)
5. [Distribution Methods](#distribution-methods)
6. [Troubleshooting](#troubleshooting)

---

## System Requirements

### Minimum Requirements
- **Operating System:** Windows 10 (64-bit) or Windows 11
- **RAM:** 4 GB minimum (8 GB recommended)
- **Storage:** 500 MB free disk space
- **Internet Connection:** Required for authentication and data sync
- **Camera:** Optional (for camera capture feature)
- **Permissions:** 
  - Camera access (if using camera capture)
  - Screen capture permissions

### Supported Architectures
- Windows x64 (64-bit) - Recommended
- Windows ia32 (32-bit) - Supported but not recommended

---

## Installation

### Method 1: Installer (Recommended)

1. **Download the installer:**
   - Get `Mechlin TimeFlow Setup 1.2.0.exe` from your distribution source

2. **Run the installer:**
   - Double-click the installer file
   - If Windows SmartScreen appears:
     - Click **"More info"**
     - Click **"Run anyway"**
     - See [SMARTSCREEN_FIX.md](./SMARTSCREEN_FIX.md) for details

3. **Follow the installation wizard:**
   - Choose installation directory (default: `C:\Program Files\Mechlin TimeFlow`)
   - Select whether to create desktop shortcut
   - Click "Install"

4. **Launch the application:**
   - From Start Menu: Search for "Mechlin TimeFlow"
   - From Desktop: Double-click the shortcut (if created)
   - From Installation Directory: Run `Mechlin TimeFlow.exe`

### Method 2: Portable Version

1. **Download the portable version:**
   - Get `Mechlin TimeFlow 1.2.0.exe` (portable)

2. **Extract/Run:**
   - Place the file in any folder
   - Double-click to run (no installation required)
   - All data is stored in the same directory

**Note:** Portable version doesn't create Start Menu entries or desktop shortcuts.

---

## First-Time Setup

### Step 1: Launch the Application

1. Open Mechlin TimeFlow
2. You'll see the login screen

### Step 2: Login Options

You have two login options:

#### Option A: Email/Password Login

1. Enter your email address
2. Enter your password
3. Click "Login"
4. You'll be redirected to the dashboard

#### Option B: Azure SSO Login

1. Click "Login with Azure SSO" button
2. Your browser will open to `https://timeflow.mechlintech.com`
3. Complete Azure SSO authentication
4. You'll be automatically logged into the application

**Note:** For Azure SSO to work, ensure:
- Your website at `timeflow.mechlintech.com` is configured correctly
- The website redirects back to the Electron app after login
- See [AZURE_SSO_SETUP.md](./AZURE_SSO_SETUP.md) for technical details

### Step 3: Select Project and Task

1. After login, you'll see the dashboard
2. **Select a Project:**
   - Use the "Project" dropdown
   - Only projects assigned to you will appear
3. **Select a Task:**
   - Use the "Task" dropdown
   - Select the task you want to track time for

### Step 4: Start Tracking

1. Click the "Start" button
2. The timer will begin counting
3. Screenshots and camera captures will start automatically (every 10 minutes)

---

## Using the Application

### Main Features

#### Time Tracking
- **Start:** Click the play button to start tracking
- **Stop:** Click the stop button to pause/stop tracking
- **Duration:** Real-time display of tracked time
- **Auto-sync:** Duration syncs to Supabase every 10 minutes and on stop

#### Inactivity Detection
- **Automatic Pause:** After 5 minutes of inactivity, a modal appears
- **Options:**
  - **Continue:** Resume tracking (if you were active)
  - **Stop:** Stop tracking and save current session

#### Screenshots & Camera
- **Screenshots:** Captured every 10 minutes automatically
- **Camera:** Webcam snapshots every 10 minutes (if camera is available)
- **Storage:** All files uploaded to Supabase storage

#### Project & Task Management
- **Project Selection:** Choose from assigned projects
- **Task Selection:** Select specific tasks within projects
- **Last Selection:** Your last selected project/task is remembered

### Window Controls

- **Minimize:** Click the minimize button (top-right)
- **Close:** Click the red X button (top-right)
- **Drag Window:** Click and drag the header area

### Logout

1. Click "Logout" button in the top-right
2. You'll be returned to the login screen
3. Your session data is saved

---

## Distribution Methods

### For IT Administrators

#### Method 1: Network Share
1. Place installer on a network share
2. Share the path with users
3. Users can download and install

#### Method 2: Group Policy (Enterprise)
1. Create a Group Policy Object (GPO)
2. Add the installer as a software package
3. Deploy to target computers

#### Method 3: Software Distribution Tool
- Use tools like:
  - Microsoft Intune
  - SCCM (System Center Configuration Manager)
  - PDQ Deploy
  - Chocolatey

#### Method 4: USB/Removable Media
1. Copy installer to USB drive
2. Distribute to users
3. Users run installer from USB

### For End Users

#### Download from:
- Company intranet
- Shared network drive
- Email attachment
- Cloud storage (OneDrive, Google Drive, etc.)

---

## Troubleshooting

### Common Issues

#### 1. Windows SmartScreen Warning

**Problem:** "Windows protected your PC" warning appears

**Solution:**
- Click "More info"
- Click "Run anyway"
- See [SMARTSCREEN_FIX.md](./SMARTSCREEN_FIX.md) for details

#### 2. Application Won't Start

**Possible Causes:**
- Missing dependencies
- Antivirus blocking
- Corrupted installation

**Solutions:**
1. Reinstall the application
2. Check antivirus exclusions
3. Run as Administrator (right-click → Run as administrator)

#### 3. Login Fails

**Possible Causes:**
- Incorrect credentials
- No internet connection
- Supabase service unavailable

**Solutions:**
1. Verify internet connection
2. Check email/password
3. Try Azure SSO if email login fails
4. Contact administrator if issue persists

#### 4. Camera Not Working

**Possible Causes:**
- Camera permissions not granted
- Camera in use by another application
- No camera available

**Solutions:**
1. Grant camera permissions when prompted
2. Close other applications using camera
3. Check Windows Privacy settings → Camera

#### 5. Screenshots Not Capturing

**Possible Causes:**
- Screen capture permissions not granted
- Antivirus blocking

**Solutions:**
1. Check Windows Privacy settings → Screen capture
2. Add application to antivirus exclusions

#### 6. Azure SSO Not Working

**Possible Causes:**
- Website not configured correctly
- Browser blocking redirect
- Network/firewall issues

**Solutions:**
1. Ensure website is accessible
2. Check browser popup blockers
3. Verify network connectivity
4. See [AZURE_SSO_SETUP.md](./AZURE_SSO_SETUP.md) for technical details

### Getting Help

If you encounter issues not listed here:

1. Check the application console (if available)
2. Review [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
3. Contact your IT administrator
4. Check Supabase dashboard for connection issues

---

## Additional Information

### Data Storage

- **Local Storage:** Session data, preferences stored locally
- **Cloud Storage:** All time entries, screenshots, camera captures stored in Supabase
- **Privacy:** All data is encrypted in transit and at rest

### Updates

- **Manual Updates:** Download and install new version
- **Automatic Updates:** Not currently implemented
- **Version Check:** Current version shown in application

### Uninstallation

1. Go to Windows Settings → Apps
2. Find "Mechlin TimeFlow"
3. Click "Uninstall"
4. Or use Control Panel → Programs and Features

**Note:** Uninstalling does not delete your data in Supabase.

---

## Quick Start Checklist

- [ ] Download installer
- [ ] Install application
- [ ] Launch application
- [ ] Login (Email/Password or Azure SSO)
- [ ] Select project and task
- [ ] Start tracking
- [ ] Grant camera permissions (if needed)
- [ ] Verify screenshots are being captured

---

## Support

For technical support or questions:
- Contact your IT administrator
- Check documentation files in the application directory
- Review Supabase dashboard for data issues

---

**Version:** 1.2.0  
**Last Updated:** 2024

