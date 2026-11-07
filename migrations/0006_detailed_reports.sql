-- ================================================================
-- SpeedPulse Next
-- Migration 0006
--
-- Workers KV-backed compact Lighthouse detail reports.
--
-- D1 remains the strongly-consistent source of truth for:
--   - report metadata
--   - retention visibility
--   - cleanup tasks
--   - daily KV write/delete budgets
--   - CrUX provider state
--
-- KV stores only the compact report payload.
-- ================================================================


ALTER TABLE test_runs
ADD COLUMN crux_status TEXT
CHECK (
  crux_status IS NULL
  OR crux_status IN (
    'available',
    'no_record',
    'provider_error'
  )
);


ALTER TABLE test_runs
ADD COLUMN crux_error TEXT;


CREATE TABLE detailed_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  site_id INTEGER NOT NULL
    REFERENCES sites(id)
    ON DELETE CASCADE,

  strategy TEXT NOT NULL
    CHECK (
      strategy IN (
        'mobile',
        'desktop'
      )
    ),

  test_run_id INTEGER NOT NULL UNIQUE
    REFERENCES test_runs(id)
    ON DELETE CASCADE,

  storage_key TEXT NOT NULL UNIQUE,

  captured_at TEXT NOT NULL,

  size_bytes INTEGER NOT NULL
    CHECK (
      size_bytes >= 0
      AND size_bytes <= 409600
    ),

  detail_level TEXT NOT NULL
    CHECK (
      detail_level IN (
        'compact',
        'summary'
      )
    ),

  final_url TEXT,

  lighthouse_version TEXT,

  state TEXT NOT NULL
    DEFAULT 'ready'
    CHECK (
      state IN (
        'ready',
        'cleanup_pending'
      )
    ),

  cleanup_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


CREATE INDEX
idx_detailed_reports_site_strategy
ON detailed_reports (
  site_id,
  strategy,
  state,
  captured_at DESC,
  id DESC
);


CREATE INDEX
idx_detailed_reports_cleanup
ON detailed_reports (
  state,
  updated_at
);


CREATE TABLE report_cleanup_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  report_id INTEGER,

  storage_key TEXT NOT NULL UNIQUE,

  reason TEXT NOT NULL,

  attempts INTEGER NOT NULL
    DEFAULT 0
    CHECK (
      attempts >= 0
    ),

  last_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


CREATE INDEX
idx_report_cleanup_tasks_created
ON report_cleanup_tasks (
  created_at,
  id
);


CREATE TABLE report_daily_usage (
  usage_date TEXT PRIMARY KEY,

  writes INTEGER NOT NULL
    DEFAULT 0
    CHECK (
      writes >= 0
    ),

  deletes INTEGER NOT NULL
    DEFAULT 0
    CHECK (
      deletes >= 0
    ),

  updated_at TEXT NOT NULL
);


CREATE INDEX IF NOT EXISTS
idx_scan_jobs_trigger_created
ON scan_jobs (
  trigger,
  created_at
);
