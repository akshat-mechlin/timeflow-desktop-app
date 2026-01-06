# Version Management Guide

This guide explains how to use the version enforcement and tracking system for your TimeFlow desktop application.

## Overview

The version management system allows you to:
1. **Enforce minimum version requirements** - Block users from using outdated versions
2. **Track version usage** - See which users are using which versions
3. **Force updates** - Make updates mandatory when needed

## Database Setup

### Step 1: Run the Migration

Execute the migration file in your Supabase SQL Editor:

```sql
-- Run: migration-version-management.sql
```

This creates two tables:
- `app_versions` - Stores version information and minimum requirements
- `user_version_tracking` - Tracks which users are using which versions

### Step 2: Configure Initial Version

After running the migration, update the default version entry:

```sql
UPDATE app_versions 
SET 
    version = '1.4.0',
    minimum_required_version = '1.4.0',
    download_url = 'https://your-download-url.com/latest',
    force_update = false
WHERE version = '1.4.0';
```

## How It Works

### Version Check Flow

1. **App Startup**: When the app starts, it checks the current version against the minimum required version in the database
2. **Version Comparison**: Uses semantic versioning (e.g., "1.4.0" vs "1.3.0")
3. **Blocking**: If the version is outdated, the app shows an update modal and blocks all functionality
4. **Tracking**: After successful login, the app tracks which version the user is using

### Version Enforcement

The app will block users if:
- Their version is **lower** than `minimum_required_version`
- `force_update` is set to `true` (makes blocking mandatory)

## Managing Versions

### Adding a New Version

When you release a new version (e.g., v1.5.0):

```sql
-- Insert new version record
INSERT INTO app_versions (version, minimum_required_version, download_url, force_update, is_active)
VALUES (
    '1.5.0',                    -- New version
    '1.5.0',                    -- Minimum required (force everyone to update)
    'https://your-download-url.com/v1.5.0',  -- Download URL
    true,                        -- Force update (block old versions)
    true                         -- Active
);
```

### Making Updates Optional

If you want to allow older versions but recommend updates:

```sql
UPDATE app_versions 
SET 
    minimum_required_version = '1.3.0',  -- Allow v1.3.0 and above
    force_update = false                  -- Don't force updates
WHERE version = '1.5.0';
```

### Gradual Rollout

For gradual rollouts, you can set different minimum versions:

```sql
-- Allow v1.4.0 and above, but recommend v1.5.0
UPDATE app_versions 
SET 
    minimum_required_version = '1.4.0',  -- Minimum allowed
    force_update = false                  -- Optional update
WHERE version = '1.5.0';
```

## Tracking Version Usage

### View Version Statistics

See which versions are being used:

```sql
SELECT 
    app_version,
    COUNT(DISTINCT user_id) as user_count,
    MAX(last_seen_at) as most_recent_usage,
    SUM(session_count) as total_sessions
FROM user_version_tracking
GROUP BY app_version
ORDER BY most_recent_usage DESC;
```

### View Users by Version

See which users are on which versions:

```sql
SELECT 
    uvt.app_version,
    uvt.platform,
    p.email,
    p.full_name,
    uvt.last_seen_at,
    uvt.session_count
FROM user_version_tracking uvt
JOIN profiles p ON uvt.user_id = p.id
ORDER BY uvt.last_seen_at DESC;
```

### Find Outdated Versions

Find users still on old versions:

```sql
SELECT 
    uvt.app_version,
    COUNT(DISTINCT uvt.user_id) as user_count,
    STRING_AGG(p.email, ', ') as users
FROM user_version_tracking uvt
JOIN profiles p ON uvt.user_id = p.id
WHERE uvt.app_version < (
    SELECT minimum_required_version 
    FROM app_versions 
    WHERE is_active = true 
    ORDER BY created_at DESC 
    LIMIT 1
)
GROUP BY uvt.app_version
ORDER BY uvt.app_version;
```

## Updating package.json Version

When releasing a new version, update `package.json`:

```json
{
  "version": "1.5.0"
}
```

Then rebuild the application:

```bash
npm run build:win
# or
npm run build:mac
```

## Best Practices

### 1. Version Numbering
- Use semantic versioning: `MAJOR.MINOR.PATCH` (e.g., 1.4.0)
- Increment appropriately:
  - **MAJOR**: Breaking changes
  - **MINOR**: New features, backward compatible
  - **PATCH**: Bug fixes

### 2. Update Strategy
- **Critical Updates**: Set `force_update = true` to block old versions immediately
- **Optional Updates**: Set `force_update = false` to allow older versions
- **Gradual Rollout**: Start with `force_update = false`, then enable after a few days

### 3. Download URLs
- Use a reliable hosting service (GitHub Releases, S3, etc.)
- Ensure URLs are accessible to all users
- Test download links before releasing

### 4. Communication
- Notify users before forcing updates
- Provide release notes in the `release_notes` field
- Give users time to update before forcing

## Troubleshooting

### Users Can't Access App

If users are blocked but shouldn't be:

1. Check the minimum required version:
```sql
SELECT minimum_required_version, force_update 
FROM app_versions 
WHERE is_active = true;
```

2. Verify the user's version matches `package.json`

3. Temporarily allow older versions:
```sql
UPDATE app_versions 
SET minimum_required_version = '1.0.0', force_update = false
WHERE is_active = true;
```

### Version Check Not Working

1. Verify tables exist:
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_name IN ('app_versions', 'user_version_tracking');
```

2. Check RLS policies allow reads:
```sql
SELECT * FROM pg_policies 
WHERE tablename = 'app_versions';
```

3. Check app logs for version check errors

### Tracking Not Working

1. Verify user is logged in (tracking only works after login)
2. Check RLS policies allow inserts:
```sql
SELECT * FROM pg_policies 
WHERE tablename = 'user_version_tracking';
```

3. Check for errors in app console logs

## Example Workflow

### Releasing v1.5.0

1. **Update package.json**:
```json
{ "version": "1.5.0" }
```

2. **Build and test** the new version

3. **Upload** to your download server

4. **Update database**:
```sql
INSERT INTO app_versions (version, minimum_required_version, download_url, force_update, is_active)
VALUES ('1.5.0', '1.5.0', 'https://your-url.com/v1.5.0', true, true);
```

5. **Monitor** version adoption:
```sql
SELECT app_version, COUNT(*) as users 
FROM user_version_tracking 
GROUP BY app_version;
```

6. **After a few days**, if needed, allow older versions:
```sql
UPDATE app_versions 
SET minimum_required_version = '1.4.0', force_update = false
WHERE version = '1.5.0';
```

## Security Considerations

- **RLS Policies**: Ensure only authenticated users can track versions
- **Version Validation**: Always validate version strings to prevent injection
- **Download URLs**: Use HTTPS and verify URLs before opening
- **Admin Access**: Consider restricting version management to admin users only

## Support

For issues or questions:
- Check app console logs for version check errors
- Verify database tables and RLS policies
- Test version comparison logic manually
- Review Supabase logs for database errors


