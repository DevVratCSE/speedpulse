PRAGMA foreign_keys = ON;


-- Clean leftovers from an interrupted previous probe.
DELETE FROM sites
WHERE project_id IN (
  SELECT id
  FROM projects
  WHERE name =
    '__checkpoint16_probe__'
);

DELETE FROM projects
WHERE name =
  '__checkpoint16_probe__';

DROP TABLE IF EXISTS
  __checkpoint16_assert;


-- Any assertion inserting 0 into this table aborts the probe.
CREATE TABLE
  __checkpoint16_assert (
    ok INTEGER NOT NULL
      CHECK (ok = 1)
  );


-- ---------------------------------------------------------------
-- Create site through the legacy data model.
-- ---------------------------------------------------------------

INSERT INTO projects (
  name,
  description,
  updated_at
)
VALUES (
  '__checkpoint16_probe__',
  'temporary local control-plane regression probe',
  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    'now'
  )
);


INSERT INTO sites (
  project_id,
  name,
  url,
  origin,
  active,
  mobile_frequency,
  desktop_frequency,
  mobile_next_check_at,
  desktop_next_check_at,
  updated_at
)
VALUES (
  (
    SELECT id
    FROM projects
    WHERE name =
      '__checkpoint16_probe__'
    ORDER BY id DESC
    LIMIT 1
  ),

  '__checkpoint16_site__',
  'https://checkpoint16.invalid/',
  'https://checkpoint16.invalid',

  1,
  'daily',
  'manual',

  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    'now'
  ),

  NULL,

  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    'now'
  )
);


-- A daily mobile target must be active immediately.
INSERT INTO
  __checkpoint16_assert (ok)

SELECT
  CASE
    WHEN COUNT(*) = 1
      THEN 1
    ELSE 0
  END

FROM scan_targets
WHERE
  site_id=(
    SELECT id
    FROM sites
    WHERE name =
      '__checkpoint16_site__'
    ORDER BY id DESC
    LIMIT 1
  )
  AND strategy='mobile'
  AND enabled=1
  AND schedule_type='interval'
  AND schedule_config_json=
    '{"minutes":1440}'
  AND timezone='UTC'
  AND interval_hours=24
  AND next_due_at IS NOT NULL;


-- Manual desktop must remain disabled.
INSERT INTO
  __checkpoint16_assert (ok)

SELECT
  CASE
    WHEN COUNT(*) = 1
      THEN 1
    ELSE 0
  END

FROM scan_targets
WHERE
  site_id=(
    SELECT id
    FROM sites
    WHERE name =
      '__checkpoint16_site__'
    ORDER BY id DESC
    LIMIT 1
  )
  AND strategy='desktop'
  AND enabled=0
  AND schedule_type='manual'
  AND schedule_config_json='{}'
  AND next_due_at IS NULL;


-- ---------------------------------------------------------------
-- Give mobile a genuine custom Next schedule.
-- ---------------------------------------------------------------

UPDATE scan_targets

SET
  schedule_type='daily',
  schedule_config_json=
    '{"time":"08:30"}',
  timezone='Asia/Kolkata',
  interval_hours=24,
  enabled=1,
  next_due_at=
    '2099-01-01T03:00:00.000Z'

WHERE
  site_id=(
    SELECT id
    FROM sites
    WHERE name =
      '__checkpoint16_site__'
    ORDER BY id DESC
    LIMIT 1
  )
  AND strategy='mobile';


-- ---------------------------------------------------------------
-- Deactivation must pause, not destroy, custom scheduling.
-- ---------------------------------------------------------------

UPDATE sites

SET
  active=0,
  updated_at=
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now'
    )

WHERE name =
  '__checkpoint16_site__';


INSERT INTO
  __checkpoint16_assert (ok)

SELECT
  CASE
    WHEN COUNT(*) = 1
      THEN 1
    ELSE 0
  END

FROM scan_targets
WHERE
  site_id=(
    SELECT id
    FROM sites
    WHERE name =
      '__checkpoint16_site__'
    ORDER BY id DESC
    LIMIT 1
  )
  AND strategy='mobile'
  AND enabled=0
  AND schedule_type='daily'
  AND schedule_config_json=
    '{"time":"08:30"}'
  AND timezone='Asia/Kolkata'
  AND next_due_at=
    '2099-01-01T03:00:00.000Z';


-- ---------------------------------------------------------------
-- Reactivation must restore automatic custom monitoring.
-- ---------------------------------------------------------------

UPDATE sites

SET
  active=1,
  updated_at=
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now'
    )

WHERE name =
  '__checkpoint16_site__';


INSERT INTO
  __checkpoint16_assert (ok)

SELECT
  CASE
    WHEN COUNT(*) = 1
      THEN 1
    ELSE 0
  END

FROM scan_targets
WHERE
  site_id=(
    SELECT id
    FROM sites
    WHERE name =
      '__checkpoint16_site__'
    ORDER BY id DESC
    LIMIT 1
  )
  AND strategy='mobile'
  AND enabled=1
  AND schedule_type='daily'
  AND schedule_config_json=
    '{"time":"08:30"}'
  AND timezone='Asia/Kolkata'
  AND next_due_at=
    '2099-01-01T03:00:00.000Z';


-- Manual desktop must still be disabled after reactivation.
INSERT INTO
  __checkpoint16_assert (ok)

SELECT
  CASE
    WHEN COUNT(*) = 1
      THEN 1
    ELSE 0
  END

FROM scan_targets
WHERE
  site_id=(
    SELECT id
    FROM sites
    WHERE name =
      '__checkpoint16_site__'
    ORDER BY id DESC
    LIMIT 1
  )
  AND strategy='desktop'
  AND enabled=0
  AND schedule_type='manual'
  AND next_due_at IS NULL;


-- ---------------------------------------------------------------
-- An explicit OLD-UI frequency change intentionally converts the
-- corresponding Next target to the legacy-equivalent schedule.
-- ---------------------------------------------------------------

UPDATE sites

SET
  mobile_frequency='weekly',
  updated_at=
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now'
    )

WHERE name =
  '__checkpoint16_site__';


INSERT INTO
  __checkpoint16_assert (ok)

SELECT
  CASE
    WHEN COUNT(*) = 1
      THEN 1
    ELSE 0
  END

FROM scan_targets
WHERE
  site_id=(
    SELECT id
    FROM sites
    WHERE name =
      '__checkpoint16_site__'
    ORDER BY id DESC
    LIMIT 1
  )
  AND strategy='mobile'
  AND enabled=1
  AND schedule_type='interval'
  AND schedule_config_json=
    '{"minutes":10080}'
  AND timezone='UTC'
  AND interval_hours=168
  AND next_due_at IS NOT NULL;


-- ---------------------------------------------------------------
-- Clean probe data.
-- ---------------------------------------------------------------

DELETE FROM sites
WHERE project_id IN (
  SELECT id
  FROM projects
  WHERE name =
    '__checkpoint16_probe__'
);

DELETE FROM projects
WHERE name =
  '__checkpoint16_probe__';

DROP TABLE
  __checkpoint16_assert;
