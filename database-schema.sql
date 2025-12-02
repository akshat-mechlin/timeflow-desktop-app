-- Database Schema for Time Tracker Application
-- This file documents the required database structure for the application

-- ============================================
-- 1. PROFILES TABLE
-- ============================================
-- Stores user profile information
-- This table should be linked to Supabase Auth users

CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT,
    email TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only read/update their own profile
CREATE POLICY "Users can view own profile" ON profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
    FOR UPDATE USING (auth.uid() = id);

-- ============================================
-- 2. PROJECTS TABLE
-- ============================================
-- Stores project information

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view projects they are assigned to
CREATE POLICY "Users can view assigned projects" ON projects
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM project_user_assignments
            WHERE project_user_assignments.project_id = projects.id
            AND project_user_assignments.user_id = auth.uid()
        )
    );

-- ============================================
-- 3. PROJECT_USER_ASSIGNMENTS TABLE
-- ============================================
-- Tracks which users are assigned to which projects

CREATE TABLE IF NOT EXISTS project_user_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, user_id)
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_project_user_assignments_user_id ON project_user_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_project_user_assignments_project_id ON project_user_assignments(project_id);

-- Enable Row Level Security
ALTER TABLE project_user_assignments ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own assignments
CREATE POLICY "Users can view own assignments" ON project_user_assignments
    FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- 4. TASKS TABLE
-- ============================================
-- Stores tasks within projects

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);

-- Enable Row Level Security
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view tasks for projects they are assigned to
CREATE POLICY "Users can view tasks for assigned projects" ON tasks
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM project_user_assignments
            WHERE project_user_assignments.project_id = tasks.project_id
            AND project_user_assignments.user_id = auth.uid()
        )
    );

-- ============================================
-- 5. TIME_ENTRIES TABLE
-- ============================================
-- Stores time tracking entries for each user

CREATE TABLE IF NOT EXISTS time_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    duration INTEGER NOT NULL DEFAULT 0, -- Duration in seconds
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_time_entries_user_id ON time_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_task_id ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_start_time ON time_entries(start_time);
CREATE INDEX IF NOT EXISTS idx_time_entries_updated_at ON time_entries(updated_at);

-- Enable Row Level Security
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only access their own time entries
CREATE POLICY "Users can view own time entries" ON time_entries
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own time entries" ON time_entries
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own time entries" ON time_entries
    FOR UPDATE USING (auth.uid() = user_id);

-- ============================================
-- 6. SCREENSHOTS TABLE
-- ============================================
-- Stores references to captured screenshots and camera images

CREATE TABLE IF NOT EXISTS screenshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    time_entry_id UUID NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL, -- Path in Supabase Storage
    type TEXT NOT NULL CHECK (type IN ('screenshot', 'camera')),
    taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_screenshots_time_entry_id ON screenshots(time_entry_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_taken_at ON screenshots(taken_at);

-- Enable Row Level Security
ALTER TABLE screenshots ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only access screenshots for their own time entries
CREATE POLICY "Users can view own screenshots" ON screenshots
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM time_entries
            WHERE time_entries.id = screenshots.time_entry_id
            AND time_entries.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert own screenshots" ON screenshots
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM time_entries
            WHERE time_entries.id = screenshots.time_entry_id
            AND time_entries.user_id = auth.uid()
        )
    );

-- ============================================
-- 7. STORAGE BUCKETS
-- ============================================
-- These need to be created in Supabase Storage (not SQL)

-- Bucket: 'screenshots'
-- - Public: false (private)
-- - Allowed MIME types: image/png, image/jpeg
-- - File size limit: 10MB
-- - Contains:
--   - Screenshots: screenshots/{user_id}/*
--   - Camera captures: camera/{user_id}/*

-- Storage Policies (create via Supabase Dashboard or SQL):
-- Users can upload to their own folders:
--   - screenshots/{user_id}/* (for desktop screenshots)
--   - camera/{user_id}/* (for camera captures)

-- ============================================
-- 8. FUNCTIONS & TRIGGERS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for profiles table
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for time_entries table
CREATE TRIGGER update_time_entries_updated_at
    BEFORE UPDATE ON time_entries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for projects table
CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for tasks table
CREATE TRIGGER update_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 9. HELPER FUNCTIONS (Optional)
-- ============================================

-- Function to get total duration for a user on a specific date
CREATE OR REPLACE FUNCTION get_user_duration_for_date(
    p_user_id UUID,
    p_date DATE
)
RETURNS INTEGER AS $$
DECLARE
    total_duration INTEGER;
BEGIN
    SELECT COALESCE(SUM(duration), 0) INTO total_duration
    FROM time_entries
    WHERE user_id = p_user_id
    AND DATE(start_time AT TIME ZONE 'Asia/Kolkata') = p_date;
    
    RETURN total_duration;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

