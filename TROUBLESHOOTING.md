# Troubleshooting: Projects and Tasks Not Showing

If you're unable to see the project and task dropdowns, follow these steps:

## Step 1: Check Browser Console

1. Open the application
2. Press `F12` or `Ctrl+Shift+I` to open Developer Tools
3. Go to the **Console** tab
4. Look for any error messages

Common errors to look for:
- `project-select element not found!`
- `Error fetching project assignments: ...`
- `No projects found for user: ...`

## Step 2: Verify Database Tables Exist

Run this query in Supabase SQL Editor to check if tables exist:

```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('projects', 'tasks', 'project_user_assignments');
```

If any tables are missing, run the migration:
- For new setup: Run `database-schema.sql`
- For existing setup: Run `migration-add-projects-tasks.sql`

## Step 3: Check if User Has Projects Assigned

Run this query (replace `YOUR_USER_ID` with your actual user ID):

```sql
SELECT 
    pua.user_id,
    pua.project_id,
    p.name as project_name
FROM project_user_assignments pua
JOIN projects p ON p.id = pua.project_id
WHERE pua.user_id = 'YOUR_USER_ID';
```

If this returns no rows, you need to:
1. Create a project
2. Assign the user to the project

## Step 4: Create Test Data

If you need to create test data, run this SQL (replace `YOUR_USER_ID`):

```sql
-- Create a test project
INSERT INTO projects (name, description, created_by)
VALUES ('Test Project', 'A test project', 'YOUR_USER_ID')
RETURNING id;

-- Note the project ID from above, then assign user
INSERT INTO project_user_assignments (project_id, user_id)
VALUES ('PROJECT_ID_FROM_ABOVE', 'YOUR_USER_ID');

-- Create a test task (use the project ID from above)
INSERT INTO tasks (project_id, name, description)
VALUES ('PROJECT_ID_FROM_ABOVE', 'Test Task', 'A test task');
```

## Step 5: Check RLS Policies

Verify Row Level Security policies are set up correctly:

```sql
-- Check if RLS is enabled
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('projects', 'tasks', 'project_user_assignments');

-- Check policies exist
SELECT schemaname, tablename, policyname 
FROM pg_policies 
WHERE tablename IN ('projects', 'tasks', 'project_user_assignments');
```

## Step 6: Verify Authentication

Make sure you're logged in. Check the console for:
- `Session found, user: your-email@example.com`
- `Loading projects for user: user-id`

## Common Issues and Solutions

### Issue: "No projects assigned"
**Solution:** Create projects and assign them to users via `project_user_assignments` table.

### Issue: "Error fetching project assignments"
**Solution:** 
- Check RLS policies are correct
- Verify the user is authenticated
- Check network connection
- Verify Supabase credentials are correct

### Issue: Dropdowns are empty
**Solution:**
- Check if projects exist in the database
- Verify user is assigned to projects
- Check browser console for errors
- Verify RLS policies allow the user to see projects

### Issue: Elements not found error
**Solution:**
- Clear browser cache
- Restart the application
- Check that `index.html` has the correct element IDs

## Quick Test

To quickly test if everything is working:

1. **Check console logs:**
   - Should see: `Loading projects for user: ...`
   - Should see: `Loaded projects: [...]`

2. **Check UI:**
   - Project dropdown should show "Select a project..." or list of projects
   - If no projects: Should show "No projects assigned"

3. **Test with sample data:**
   - Create one project
   - Assign it to your user
   - Create one task for that project
   - Refresh the app
   - You should see the project in the dropdown

## Still Having Issues?

1. Check the browser console for specific error messages
2. Verify all database tables and RLS policies are set up
3. Ensure you have at least one project assigned to your user
4. Try logging out and logging back in
5. Clear browser cache and restart the app

