PRAGMA foreign_keys = ON;


DELETE FROM sites
WHERE project_id IN (
  SELECT id
  FROM projects
  WHERE name='__checkpoint17_kv_probe__'
);


DELETE FROM projects
WHERE name='__checkpoint17_kv_probe__';


DELETE FROM report_cleanup_tasks
WHERE storage_key LIKE 'probe/%';


DELETE FROM report_daily_usage
WHERE usage_date='2026-01-03';


DROP TABLE IF EXISTS
__checkpoint17_assert;


CREATE TABLE
__checkpoint17_assert (
  ok INTEGER NOT NULL
    CHECK (ok=1)
);


INSERT INTO projects (
  name,
  description,
  updated_at
)
VALUES (
  '__checkpoint17_kv_probe__',
  'temporary KV detailed-report probe',
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
    WHERE name='__checkpoint17_kv_probe__'
    ORDER BY id DESC
    LIMIT 1
  ),

  '__checkpoint17_kv_site__',

  'https://checkpoint17.invalid/',
  'https://checkpoint17.invalid',

  0,

  'manual',
  'manual',

  NULL,
  NULL,

  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    'now'
  )
);


INSERT INTO test_runs (
  site_id,
  strategy,
  source,
  status,
  started_at,
  completed_at,
  crux_status,
  crux_error
)
VALUES
(
  (
    SELECT id
    FROM sites
    WHERE name='__checkpoint17_kv_site__'
  ),
  'mobile',
  'manual',
  'success',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:10.000Z',
  'available',
  NULL
),
(
  (
    SELECT id
    FROM sites
    WHERE name='__checkpoint17_kv_site__'
  ),
  'mobile',
  'manual',
  'success',
  '2026-01-02T00:00:00.000Z',
  '2026-01-02T00:00:10.000Z',
  'no_record',
  NULL
),
(
  (
    SELECT id
    FROM sites
    WHERE name='__checkpoint17_kv_site__'
  ),
  'mobile',
  'manual',
  'success',
  '2026-01-03T00:00:00.000Z',
  '2026-01-03T00:00:10.000Z',
  'provider_error',
  'probe provider error'
);


INSERT INTO detailed_reports (
  site_id,
  strategy,
  test_run_id,
  storage_key,
  captured_at,
  size_bytes,
  detail_level,
  final_url,
  lighthouse_version,
  state,
  cleanup_error,
  created_at,
  updated_at
)

SELECT
  tr.site_id,
  tr.strategy,
  tr.id,

  'probe/' ||
  tr.id ||
  '.json',

  tr.completed_at,

  12345,

  CASE
    WHEN tr.completed_at=
      '2026-01-03T00:00:10.000Z'
      THEN 'summary'
    ELSE 'compact'
  END,

  'https://checkpoint17.invalid/',

  'probe',

  CASE
    WHEN tr.completed_at=
      '2026-01-01T00:00:10.000Z'
      THEN 'cleanup_pending'
    ELSE 'ready'
  END,

  NULL,

  tr.completed_at,
  tr.completed_at

FROM test_runs tr

JOIN sites s
  ON s.id=tr.site_id

WHERE s.name=
  '__checkpoint17_kv_site__';


INSERT INTO report_cleanup_tasks (
  report_id,
  storage_key,
  reason,
  attempts,
  created_at,
  updated_at
)

SELECT
  id,
  storage_key,
  'retention',
  0,
  created_at,
  updated_at

FROM detailed_reports

WHERE state='cleanup_pending';


INSERT INTO report_daily_usage (
  usage_date,
  writes,
  deletes,
  updated_at
)
VALUES (
  '2026-01-03',
  3,
  1,
  '2026-01-03T00:01:00.000Z'
);


/* three report metadata rows */

INSERT INTO __checkpoint17_assert(ok)

SELECT
  CASE
    WHEN COUNT(*)=3
      THEN 1
    ELSE 0
  END

FROM detailed_reports

WHERE site_id=(
  SELECT id
  FROM sites
  WHERE name='__checkpoint17_kv_site__'
);


/* exactly newest two are ready */

INSERT INTO __checkpoint17_assert(ok)

SELECT
  CASE
    WHEN
      SUM(
        CASE
          WHEN state='ready'
            THEN 1
          ELSE 0
        END
      )=2

      AND

      SUM(
        CASE
          WHEN state='cleanup_pending'
            THEN 1
          ELSE 0
        END
      )=1

      THEN 1

    ELSE 0
  END

FROM detailed_reports

WHERE site_id=(
  SELECT id
  FROM sites
  WHERE name='__checkpoint17_kv_site__'
);


/* retention cleanup survives independently */

INSERT INTO __checkpoint17_assert(ok)

SELECT
  CASE
    WHEN COUNT(*)=1
      THEN 1
    ELSE 0
  END

FROM report_cleanup_tasks

WHERE storage_key LIKE 'probe/%';


/* operation accounting */

INSERT INTO __checkpoint17_assert(ok)

SELECT
  CASE
    WHEN writes=3
      AND deletes=1
      THEN 1
    ELSE 0
  END

FROM report_daily_usage

WHERE usage_date='2026-01-03';


DELETE FROM sites
WHERE name='__checkpoint17_kv_site__';


/* metadata cascades */

INSERT INTO __checkpoint17_assert(ok)

SELECT
  CASE
    WHEN COUNT(*)=0
      THEN 1
    ELSE 0
  END

FROM detailed_reports

WHERE storage_key LIKE 'probe/%';


/*
 * Cleanup task intentionally remains after site deletion.
 * This prevents KV values from being orphaned.
 */

INSERT INTO __checkpoint17_assert(ok)

SELECT
  CASE
    WHEN COUNT(*)=1
      THEN 1
    ELSE 0
  END

FROM report_cleanup_tasks

WHERE storage_key LIKE 'probe/%';


DELETE FROM report_cleanup_tasks
WHERE storage_key LIKE 'probe/%';


DELETE FROM report_daily_usage
WHERE usage_date='2026-01-03';


DELETE FROM projects
WHERE name='__checkpoint17_kv_probe__';


DROP TABLE
__checkpoint17_assert;
