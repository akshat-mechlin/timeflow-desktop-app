-- Database Connection Test Script
-- Run this in Supabase SQL Editor to diagnose issues

-- ============================================
-- 1. Check if tables exist
-- ============================================
SELECT 
    table_name,
    CASE 
        WHEN table_name IN ('projects', 'tasks', 'project_user_assignments') THEN '✓ Exists'
        ELSE '✗ Missing'
    END as status
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('projects', 'tasks', 'project_user_assignments', 'profiles', 'time_entries')
ORDER BY table_name;

-- ============================================
-- 2. Check RLS status
-- ============================================
SELECT 
    tablename,
    CASE 
        WHEN rowsecurity THEN 'Enabled'
        ELSE 'Disabled'
    END as rls_status
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('projects', 'tasks', 'project_user_assignments')
ORDER BY tablename;

-- ============================================
-- 3. Check RLS policies
-- ============================================
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd
FROM pg_policies 
WHERE tablename IN ('projects', 'tasks', 'project_user_assignments')
ORDER BY tablename, policyname;

-- ============================================
-- 4. Check if you have a profile
-- ============================================
SELECT 
    id,
    email,
    full_name,
    created_at
FROM profiles
WHERE id = auth.uid();

-- ============================================
-- 5. Check your project assignments
-- ============================================
SELECT 
    pua.id as assignment_id,
    pua.project_id,
    pua.user_id,
    p.name as project_name,
    p.description as project_description
FROM project_user_assignments pua
LEFT JOIN projects p ON p.id = pua.project_id
WHERE pua.user_id = auth.uid();

-- ============================================
-- 6. Check all projects (if you're admin)
-- ============================================
-- Uncomment to see all projects (may fail due to RLS)
-- SELECT id, name, description, created_by FROM projects;

-- ============================================
-- 7. Check all tasks for your projects
-- ============================================
SELECT 
    t.id,
    t.project_id,
    t.name as task_name,
    t.description,
    p.name as project_name
FROM tasks t
JOIN projects p ON p.id = t.project_id
WHERE EXISTS (
    SELECT 1 FROM project_user_assignments pua
    WHERE pua.project_id = t.project_id
    AND pua.user_id = auth.uid()
)
ORDER BY p.name, t.name;

-- ============================================
-- 8. Test query (similar to what the app uses)
-- ============================================
-- This simulates what the application does
SELECT 
    pua.project_id,
    p.id,
    p.name,
    p.description
FROM project_user_assignments pua
JOIN projects p ON p.id = pua.project_id
WHERE pua.user_id = auth.uid();

