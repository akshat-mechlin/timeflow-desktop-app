-- Migration: Version Management and Tracking
-- This migration creates tables for app version enforcement and tracking

-- ============================================
-- 1. APP_VERSIONS TABLE
-- ============================================
-- Stores app version information and minimum required version
CREATE TABLE IF NOT EXISTS app_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL UNIQUE, -- e.g., "1.4.0"
    minimum_required_version TEXT NOT NULL, -- Minimum version users must have
    download_url TEXT, -- URL to download the latest version (legacy, use download_urls)
    download_urls JSONB DEFAULT '{}'::jsonb, -- Platform-specific URLs: {"windows": "...", "mac": "...", "default": "..."}
    release_notes TEXT, -- Release notes for this version
    is_active BOOLEAN DEFAULT true, -- Whether this version is currently active
    force_update BOOLEAN DEFAULT false, -- If true, blocks all older versions
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_app_versions_active ON app_versions(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_app_versions_minimum ON app_versions(minimum_required_version);

-- Enable Row Level Security
ALTER TABLE app_versions ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Anyone can read app versions (needed for version check)
CREATE POLICY "Anyone can view app versions" ON app_versions
    FOR SELECT USING (true);

-- RLS Policy: Only authenticated users can insert/update (admin operations)
-- Note: You may want to restrict this further based on user roles
CREATE POLICY "Authenticated users can manage app versions" ON app_versions
    FOR ALL USING (auth.role() = 'authenticated');

-- ============================================
-- 2. USER_VERSION_TRACKING TABLE
-- ============================================
-- Tracks which users are using which versions
CREATE TABLE IF NOT EXISTS user_version_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    app_version TEXT NOT NULL, -- Version the user is using
    platform TEXT, -- e.g., "win32", "darwin", "linux"
    last_seen_at TIMESTAMPTZ DEFAULT NOW(), -- Last time this version was reported
    first_seen_at TIMESTAMPTZ DEFAULT NOW(), -- First time this version was reported
    session_count INTEGER DEFAULT 1, -- Number of sessions with this version
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, app_version) -- One record per user per version
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_user_version_tracking_user_id ON user_version_tracking(user_id);
CREATE INDEX IF NOT EXISTS idx_user_version_tracking_version ON user_version_tracking(app_version);
CREATE INDEX IF NOT EXISTS idx_user_version_tracking_last_seen ON user_version_tracking(last_seen_at);

-- Enable Row Level Security
ALTER TABLE user_version_tracking ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own version tracking
CREATE POLICY "Users can view own version tracking" ON user_version_tracking
    FOR SELECT USING (auth.uid() = user_id);

-- RLS Policy: Users can insert/update their own version tracking
CREATE POLICY "Users can manage own version tracking" ON user_version_tracking
    FOR ALL USING (auth.uid() = user_id);

-- ============================================
-- 3. INSERT DEFAULT VERSION
-- ============================================
-- Insert the current version as minimum required
-- Update this when you release a new version
INSERT INTO app_versions (version, minimum_required_version, download_url, download_urls, force_update, is_active)
VALUES (
    '1.4.0', -- Current version
    '1.4.0', -- Minimum required version (update this when forcing updates)
    'https://your-download-url.com/latest', -- Legacy download URL
    jsonb_build_object(
        'windows', 'https://your-windows-url.com/latest.exe',
        'mac', 'https://your-mac-url.com/latest.dmg',
        'default', 'https://your-download-url.com/latest'
    ), -- Platform-specific download URLs
    false, -- Set to true to force all users to update
    true
)
ON CONFLICT (version) DO NOTHING;

-- ============================================
-- 4. CREATE FUNCTION TO UPDATE UPDATED_AT
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_app_versions_updated_at ON app_versions;
CREATE TRIGGER update_app_versions_updated_at
    BEFORE UPDATE ON app_versions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_version_tracking_updated_at ON user_version_tracking;
CREATE TRIGGER update_user_version_tracking_updated_at
    BEFORE UPDATE ON user_version_tracking
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- VERIFICATION QUERIES
-- ============================================
-- Run these to verify the setup:

-- Check if tables exist
-- SELECT table_name 
-- FROM information_schema.tables 
-- WHERE table_schema = 'public' 
-- AND table_name IN ('app_versions', 'user_version_tracking')
-- ORDER BY table_name;

-- Check current minimum required version
-- SELECT version, minimum_required_version, force_update, is_active
-- FROM app_versions
-- WHERE is_active = true
-- ORDER BY created_at DESC
-- LIMIT 1;

-- Check version usage statistics
-- SELECT 
--     app_version,
--     COUNT(DISTINCT user_id) as user_count,
--     MAX(last_seen_at) as most_recent_usage
-- FROM user_version_tracking
-- GROUP BY app_version
-- ORDER BY most_recent_usage DESC;


