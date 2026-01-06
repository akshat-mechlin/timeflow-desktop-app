# Version Management - Quick Setup Guide

## ✅ Migration Complete!

The database tables have been successfully created:
- ✅ `app_versions` table
- ✅ `user_version_tracking` table

## Current Status

- **Current Version**: 1.3.0 (matches your package.json)
- **Minimum Required Version**: 1.3.0
- **Force Update**: Disabled (users can still use older versions)
- **Download URL**: `https://your-download-url.com/latest` (needs to be updated)

## Next Steps

### 1. Update Download URL

Update the download URL to point to where you host your app releases:

```sql
UPDATE app_versions 
SET download_url = 'https://your-actual-download-url.com/latest'
WHERE version = '1.3.0';
```

### 2. When Releasing a New Version (e.g., v1.4.0)

**Step 1:** Update `package.json`:
```json
{
  "version": "1.4.0"
}
```

**Step 2:** Build the new version:
```bash
npm run build:win
```

**Step 3:** Upload to your download server

**Step 4:** Update database to enforce the new version:

```sql
-- Insert new version record
INSERT INTO app_versions (version, minimum_required_version, download_url, force_update, is_active)
VALUES (
    '1.4.0',                    -- New version
    '1.4.0',                    -- Minimum required (blocks older versions)
    'https://your-url.com/v1.4.0',  -- Download URL
    true,                        -- Force update (blocks old versions)
    true                         -- Active
);
```

### 3. View Version Statistics

```sql
-- See which versions are being used
SELECT 
    app_version,
    COUNT(DISTINCT user_id) as user_count,
    MAX(last_seen_at) as most_recent_usage
FROM user_version_tracking
GROUP BY app_version
ORDER BY most_recent_usage DESC;

-- Find users on old versions
SELECT 
    uvt.app_version,
    u.email,
    u.full_name,
    uvt.last_seen_at
FROM user_version_tracking uvt
JOIN users u ON uvt.user_id = u.id
WHERE uvt.app_version < '1.4.0'
ORDER BY uvt.last_seen_at DESC;
```

## How It Works

1. **On App Startup**: The app checks if the current version meets the minimum requirement
2. **If Outdated**: Shows an update modal and blocks app access
3. **After Login**: Tracks which version the user is using
4. **Version Comparison**: Uses semantic versioning (1.4.0 > 1.3.0)

## Testing

To test the version enforcement:

1. **Temporarily set a higher minimum version**:
```sql
UPDATE app_versions 
SET minimum_required_version = '1.5.0', force_update = true
WHERE is_active = true;
```

2. **Restart your app** - it should show the update modal

3. **Revert back**:
```sql
UPDATE app_versions 
SET minimum_required_version = '1.3.0', force_update = false
WHERE is_active = true;
```

## Important Notes

- The app will **gracefully degrade** if version check fails (allows app to continue)
- Version tracking only works **after user login**
- Update the `download_url` before releasing to users
- Set `force_update = true` only when you want to block old versions

## Support

If you encounter issues:
1. Check app console logs for version check errors
2. Verify the `app_versions` table has an active record
3. Ensure RLS policies allow reads (they should by default)


