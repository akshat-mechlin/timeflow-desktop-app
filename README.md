# Time Tracker - Electron Desktop Application

An Electron-based desktop time-tracking application that integrates with Supabase for authentication, data storage, and file uploads.

## Features

- **Email/Password Authentication** - Secure login using Supabase Auth
- **Time Tracking** - Start and stop tracking with real-time duration display
- **Idle Detection** - Automatically pauses tracking after 5 minutes of inactivity
- **Automatic Screenshots** - Captures desktop screenshots every 10 minutes
- **Camera Capture** - Takes webcam snapshots every 10 minutes
- **Real-time Updates** - Continuously syncs tracking data to Supabase

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- A Supabase project with the required tables and storage buckets

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with your Supabase credentials:
```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Running the Application

```bash
npm start
```

## Database Schema

The application uses the following Supabase tables:
- `time_entries` - Stores time tracking sessions
- `screenshots` - Stores references to captured screenshots and camera images
- `activity_logs` - Stores activity metrics (optional)

## Storage Buckets

- `screenshots` - Stores desktop screenshots
- `tracker-application` - Stores camera captures

## Building for Production

```bash
npm run build
```

## Notes

- The application requires camera permissions on first use
- Screenshots and camera captures are uploaded to Supabase storage
- Idle detection shows an overlay modal that appears above all windows
- All tracking data is synced to Supabase in real-time



