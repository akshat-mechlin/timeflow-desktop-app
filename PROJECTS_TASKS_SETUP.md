# Projects and Tasks Setup Guide

This guide explains how to set up projects and tasks for the Time Tracker application.

## Overview

The application now supports:
- **Projects** - Group related work together
- **Tasks** - Specific work items within a project
- **User Assignments** - Assign users to specific projects
- **Time Tracking** - Track time against specific projects and tasks

## Database Setup

### Option 1: Fresh Installation

If you're setting up the database from scratch, use `database-schema.sql` which includes all tables including projects and tasks.

### Option 2: Existing Database

If you already have a database set up, run the migration file:

1. Open your Supabase project dashboard
2. Go to **SQL Editor**
3. Run `migration-add-projects-tasks.sql`

This will:
- Create the `projects` table
- Create the `project_user_assignments` table
- Create the `tasks` table
- Add `project_id` and `task_id` columns to `time_entries`
- Set up all necessary indexes and RLS policies

## Creating Projects and Tasks

### Via Supabase Dashboard

1. **Create a Project:**
   - Go to **Table Editor** → `projects`
   - Click **Insert** → **Insert row**
   - Fill in:
     - `name` (required) - Project name
     - `description` (optional) - Project description
     - `created_by` (optional) - User ID who created the project
   - Click **Save**

2. **Assign Users to Projects:**
   - Go to **Table Editor** → `project_user_assignments`
   - Click **Insert** → **Insert row**
   - Fill in:
     - `project_id` - The project ID
     - `user_id` - The user's profile ID (from `profiles` table)
   - Click **Save**

3. **Create Tasks:**
   - Go to **Table Editor** → `tasks`
   - Click **Insert** → **Insert row**
   - Fill in:
     - `project_id` - The project this task belongs to
     - `name` (required) - Task name
     - `description` (optional) - Task description
   - Click **Save**

### Via SQL

```sql
-- Create a project
INSERT INTO projects (name, description, created_by)
VALUES ('My Project', 'Project description', 'user-uuid-here')
RETURNING id;

-- Assign a user to the project
INSERT INTO project_user_assignments (project_id, user_id)
VALUES ('project-uuid-here', 'user-uuid-here');

-- Create tasks for the project
INSERT INTO tasks (project_id, name, description)
VALUES 
    ('project-uuid-here', 'Task 1', 'First task'),
    ('project-uuid-here', 'Task 2', 'Second task');
```

## Application Usage

### For Users

1. **Login** to the application
2. **Select a Project** from the dropdown (only shows projects assigned to you)
3. **Select a Task** from the dropdown (shows tasks for the selected project)
4. **Start Tracking** - The start button will be enabled once both are selected
5. **Time is tracked** against the selected project and task

### Features

- Projects are filtered to show only those assigned to the logged-in user
- Tasks are filtered to show only those for the selected project
- Project and task selections are saved with time entries
- Selections are restored when loading existing time entries
- Project and task dropdowns are disabled while tracking is active

## Data Structure

### Projects Table
- `id` - UUID (Primary Key)
- `name` - TEXT (Required)
- `description` - TEXT (Optional)
- `created_by` - UUID (References profiles.id)
- `created_at` - TIMESTAMPTZ
- `updated_at` - TIMESTAMPTZ

### Tasks Table
- `id` - UUID (Primary Key)
- `project_id` - UUID (References projects.id, Required)
- `name` - TEXT (Required)
- `description` - TEXT (Optional)
- `created_at` - TIMESTAMPTZ
- `updated_at` - TIMESTAMPTZ

### Project User Assignments Table
- `id` - UUID (Primary Key)
- `project_id` - UUID (References projects.id, Required)
- `user_id` - UUID (References profiles.id, Required)
- `assigned_at` - TIMESTAMPTZ
- Unique constraint on (project_id, user_id)

### Updated Time Entries Table
- Now includes:
  - `project_id` - UUID (References projects.id, Optional)
  - `task_id` - UUID (References tasks.id, Optional)

## Security

- Row Level Security (RLS) is enabled on all tables
- Users can only see projects they are assigned to
- Users can only see tasks for projects they are assigned to
- Users can only create time entries for projects/tasks they have access to

## Troubleshooting

### Issue: "No projects found"
- Verify the user is assigned to at least one project in `project_user_assignments`
- Check that RLS policies are correctly set up
- Verify the user is authenticated

### Issue: "No tasks found"
- Verify tasks exist for the selected project
- Check that the project_id in tasks matches the selected project
- Verify RLS policies allow the user to see tasks

### Issue: "Cannot start tracking"
- Ensure both project and task are selected
- Check that camera and screenshot permissions are granted
- Verify the user has access to the selected project

## Next Steps

After setting up projects and tasks:
1. Create projects for your organization
2. Assign users to relevant projects
3. Create tasks within each project
4. Users can now track time against specific projects and tasks

