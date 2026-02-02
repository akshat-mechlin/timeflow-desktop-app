-- Add only get_tracker_required_version() on main.
-- Main already has: system_settings table + tracker_required_version row.
-- This migration does not create or change any table or row.

CREATE OR REPLACE FUNCTION public.get_tracker_required_version()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COALESCE(setting_value #>> '{}', setting_value::text)
  FROM system_settings
  WHERE setting_key = 'tracker_required_version'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_tracker_required_version() TO anon;
GRANT EXECUTE ON FUNCTION public.get_tracker_required_version() TO authenticated;
