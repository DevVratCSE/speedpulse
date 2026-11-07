-- SpeedPulse Next control plane.
--
-- This migration is intentionally additive.
-- Existing V2 tables remain unchanged so v2.final can still operate
-- against the database if a rollback is required.

-- -------------------------------------------------------------------
-- Bulk operations
-- -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bulk_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  action TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'queued',
        'running',
        'success',
        'partial',
        'failed',
        'cancelled'
      )
    ),

  total_count INTEGER NOT NULL DEFAULT 0
    CHECK (total_count >= 0),

  completed_count INTEGER NOT NULL DEFAULT 0
    CHECK (completed_count >= 0),

  failed_count INTEGER NOT NULL DEFAULT 0
    CHECK (failed_count >= 0),

  skipped_count INTEGER NOT NULL DEFAULT 0
    CHECK (skipped_count >= 0),

  parameters_json TEXT,

  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,

  CHECK (
    completed_count + failed_count + skipped_count <= total_count
  )
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status_created
ON bulk_jobs(status, created_at DESC);


-- -------------------------------------------------------------------
-- Scan execution jobs
--
-- scan_jobs = work SpeedPulse intends to execute
-- test_runs = actual PageSpeed attempts
-- -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scan_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  site_id INTEGER NOT NULL
    REFERENCES sites(id)
    ON DELETE CASCADE,

  strategy TEXT NOT NULL
    CHECK (strategy IN ('mobile', 'desktop')),

  trigger TEXT NOT NULL
    CHECK (
      trigger IN (
        'scheduled',
        'manual',
        'bulk',
        'retry'
      )
    ),

  bulk_job_id INTEGER
    REFERENCES bulk_jobs(id)
    ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'queued',
        'running',
        'success',
        'failed',
        'cancelled'
      )
    ),

  attempt INTEGER NOT NULL DEFAULT 0
    CHECK (attempt >= 0),

  priority INTEGER NOT NULL DEFAULT 100,

  scheduled_for TEXT,

  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,

  test_run_id INTEGER
    REFERENCES test_runs(id)
    ON DELETE SET NULL,

  error_class TEXT,
  error_message TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (
    trigger <> 'bulk'
    OR bulk_job_id IS NOT NULL
  )
);

-- Prevent Cron, manual actions and bulk actions from creating
-- simultaneous active work for the same site + strategy.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_jobs_one_active
ON scan_jobs(site_id, strategy)
WHERE status IN ('pending', 'queued', 'running');

CREATE INDEX IF NOT EXISTS idx_scan_jobs_dispatch
ON scan_jobs(status, scheduled_for, priority DESC, created_at);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_site_history
ON scan_jobs(site_id, strategy, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_bulk
ON scan_jobs(bulk_job_id, status);


-- -------------------------------------------------------------------
-- Scheduling targets
--
-- One target exists per site + strategy.
-- interval_hours=72 means every three days.
-- -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scan_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  site_id INTEGER NOT NULL
    REFERENCES sites(id)
    ON DELETE CASCADE,

  strategy TEXT NOT NULL
    CHECK (strategy IN ('mobile', 'desktop')),

  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),

  interval_hours INTEGER NOT NULL DEFAULT 72
    CHECK (
      interval_hours >= 1
      AND interval_hours <= 8760
    ),

  next_due_at TEXT,

  last_success_at TEXT,
  last_failure_at TEXT,

  priority INTEGER NOT NULL DEFAULT 100,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(site_id, strategy)
);

CREATE INDEX IF NOT EXISTS idx_scan_targets_due
ON scan_targets(enabled, next_due_at, priority DESC);

CREATE INDEX IF NOT EXISTS idx_scan_targets_site
ON scan_targets(site_id, strategy);


-- Every future site automatically receives safe, disabled 72-hour
-- mobile and desktop targets. Application code later decides when
-- monitoring should actually be enabled.
CREATE TRIGGER IF NOT EXISTS trg_sites_create_scan_targets
AFTER INSERT ON sites
BEGIN
  INSERT OR IGNORE INTO scan_targets (
    site_id,
    strategy,
    enabled,
    interval_hours,
    next_due_at,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    'mobile',
    0,
    72,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );

  INSERT OR IGNORE INTO scan_targets (
    site_id,
    strategy,
    enabled,
    interval_hours,
    next_due_at,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    'desktop',
    0,
    72,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;


-- V2 already knows how to deactivate a site. Preserve that safety
-- behaviour for the Next scheduler even if old V2 code performs the
-- update: inactive sites can never remain scheduled in scan_targets.
CREATE TRIGGER IF NOT EXISTS trg_sites_disable_scan_targets
AFTER UPDATE OF active ON sites
WHEN OLD.active <> 0 AND NEW.active = 0
BEGIN
  UPDATE scan_targets
     SET enabled = 0,
         next_due_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE site_id = NEW.id;
END;


-- -------------------------------------------------------------------
-- Application-level health / observability state
--
-- Flexible key/value model avoids schema migrations for every future
-- health indicator.
-- -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_system_state_updated
ON system_state(updated_at DESC);


-- -------------------------------------------------------------------
-- Prepare existing staging/production sites for the Next scheduler.
--
-- Targets are created DISABLED and with next_due_at=NULL.
-- Therefore merely applying this migration can never begin scans.
-- They will be activated later through an explicit controlled step.
-- -------------------------------------------------------------------

INSERT OR IGNORE INTO scan_targets (
  site_id,
  strategy,
  enabled,
  interval_hours,
  next_due_at,
  created_at,
  updated_at
)
SELECT
  id,
  'mobile',
  0,
  72,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sites;

INSERT OR IGNORE INTO scan_targets (
  site_id,
  strategy,
  enabled,
  interval_hours,
  next_due_at,
  created_at,
  updated_at
)
SELECT
  id,
  'desktop',
  0,
  72,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sites;
