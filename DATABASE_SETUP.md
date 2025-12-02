# Database Setup Guide

This document provides instructions for setting up the database schema for the Time Tracker application.

## Prerequisites

- A Supabase project (https://supabase.com)
- Access to Supabase SQL Editor
- Access to Supabase Storage settings

## Setup Steps

### 1. Run the Schema SQL

1. Open your Supabase project dashboard
2. Go to **SQL Editor**
3. Create a new query
4. Copy and paste the contents of `database-schema.sql`
5. Run the query to create all tables, policies, and functions

### 2. Create Storage Buckets

#### Bucket: `screenshots`
1. Go to **Storage** in Supabase Dashboard
2. Click **New bucket**
3. Name: `screenshots`
4. **Public bucket**: OFF (private)
5. Click **Create bucket**
6. Create a folder named `camera` inside this bucket (for camera captures)

### 3. Configure Storage Policies

For each bucket, you need to set up policies that allow users to:
- Upload files to their own folder
- Read their own files

#### For `screenshots` bucket:

```sql
-- Policy: Users can upload screenshots to their own folder
-- Path structure: screenshots/{user_id}/*
CREATE POLICY "Users can upload own screenshots"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'screenshots' AND
    (storage.foldername(name))[2] = auth.uid()::text
);

-- Policy: Users can read their own screenshots
-- Path structure: screenshots/{user_id}/*
CREATE POLICY "Users can read own screenshots"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'screenshots' AND
    (storage.foldername(name))[2] = auth.uid()::text
);

-- Policy: Users can upload camera captures to their own camera folder
-- Path structure: camera/{user_id}/*
CREATE POLICY "Users can upload own camera images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'camera' AND
    (storage.foldername(name))[2] = auth.uid()::text
);

-- Policy: Users can read their own camera images
-- Path structure: camera/{user_id}/*
CREATE POLICY "Users can read own camera images"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'screenshots' AND
    (storage.foldername(name))[1] = 'camera' AND
    (storage.foldername(name))[2] = auth.uid()::text
);
```

### 4. Verify Setup

Run these queries to verify everything is set up correctly:

```sql
-- Check if tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('profiles', 'time_entries', 'screenshots');

-- Check if RLS is enabled
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('profiles', 'time_entries', 'screenshots');

-- Check if storage buckets exist
SELECT name, public 
FROM storage.buckets 
WHERE name IN ('screenshots', 'tracker-application');
```

## Database Schema Overview

### Tables

1. **profiles**
   - Stores user profile information
   - Linked to Supabase Auth users
   - Fields: `id`, `full_name`, `email`, `created_at`, `updated_at`

2. **time_entries**
   - Stores time tracking sessions
   - Fields: `id`, `user_id`, `start_time`, `end_time`, `duration`, `created_at`, `updated_at`
   - Duration is stored in seconds

3. **screenshots**
   - Stores references to captured screenshots and camera images
   - Fields: `id`, `time_entry_id`, `storage_path`, `type`, `taken_at`, `created_at`
   - Type can be: `'screenshot'` or `'camera'`

### Security

- All tables have Row Level Security (RLS) enabled
- Users can only access their own data
- Storage buckets are private with user-specific folder access

## Troubleshooting

### Issue: "relation does not exist"
- Make sure you ran the `database-schema.sql` file completely
- Check that you're connected to the correct database

### Issue: "permission denied"
- Verify RLS policies are created correctly
- Check that the user is authenticated
- Ensure storage policies allow the operation

### Issue: "bucket does not exist"
- Create the storage buckets manually in the Supabase Dashboard
- Verify bucket names match exactly: `screenshots` and `tracker-application`

### Issue: "storage upload fails"
- Check storage bucket policies
- Verify the folder structure matches: `screenshots/{user_id}/*` and `camera/{user_id}/*` (both in screenshots bucket)
- Check file size limits (should be at least 10MB)

## Migration Notes

If you need to modify the schema:

1. Always test changes in a development environment first
2. Create migration scripts with version numbers
3. Backup your database before running migrations
4. Update this document with any schema changes

## Support

For issues or questions:
- Check Supabase documentation: https://supabase.com/docs
- Review the application code in `renderer.js` for expected schema structure

