ALTER TABLE scan_targets
ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'interval'
CHECK (
  schedule_type IN (
    'manual',
    'interval',
    'daily',
    'weekly'
  )
);

ALTER TABLE scan_targets
ADD COLUMN schedule_config_json TEXT NOT NULL DEFAULT '{"minutes":4320}';

ALTER TABLE scan_targets
ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';


-- Preserve the previous interval_hours value for existing targets.
UPDATE scan_targets
SET schedule_config_json =
  '{"minutes":' || (interval_hours * 60) || '}'
WHERE schedule_type='interval';
