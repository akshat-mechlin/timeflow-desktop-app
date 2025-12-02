-- Migration: Add Projects and Tasks Support
-- This migration adds project and task functionality to the time tracker
-- Run this after the base schema is set up

-- ============================================
-- 1. ADD PROJECTS TABLE
-- ============================================
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
-- 2. ADD PROJECT_USER_ASSIGNMENTS TABLE
-- ============================================
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
-- 3. ADD TASKS TABLE
-- ============================================
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
-- 4. UPDATE TIME_ENTRIES TABLE
-- ============================================
-- Add project_id and task_id columns to existing time_entries table
ALTER TABLE time_entries 
ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

-- Create indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_task_id ON time_entries(task_id);

-- ============================================
-- 5. ADD TRIGGERS FOR UPDATED_AT
-- ============================================
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
-- 6. SAMPLE DATA (Optional - for testing)
-- ============================================
-- Uncomment and modify these to create sample projects and tasks for testing

/*
-- Create a sample project
INSERT INTO projects (id, name, description, created_by)
VALUES (
    gen_random_uuid(),
    'Sample Project',
    'This is a sample project for testing',
    (SELECT id FROM profiles LIMIT 1)
)
ON CONFLICT DO NOTHING;

-- Assign the project to a user (replace with actual user_id)
INSERT INTO project_user_assignments (project_id, user_id)
SELECT 
    (SELECT id FROM projects WHERE name = 'Sample Project' LIMIT 1),
    (SELECT id FROM profiles LIMIT 1)
ON CONFLICT DO NOTHING;

-- Create sample tasks
INSERT INTO tasks (project_id, name, description)
SELECT 
    (SELECT id FROM projects WHERE name = 'Sample Project' LIMIT 1),
    'Sample Task 1',
    'This is a sample task'
ON CONFLICT DO NOTHING;

INSERT INTO tasks (project_id, name, description)
SELECT 
    (SELECT id FROM projects WHERE name = 'Sample Project' LIMIT 1),
    'Sample Task 2',
    'This is another sample task'
ON CONFLICT DO NOTHING;
*/

