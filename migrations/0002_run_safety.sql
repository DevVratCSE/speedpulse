-- Recover abandoned runs older than 20 minutes.
UPDATE test_runs
SET status = 'failed',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    error_message = COALESCE(
      error_message,
      'Recovered stale running test during run-safety migration'
    )
WHERE status = 'running'
  AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 minutes');

-- Only one active run per site + strategy.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_strategy
ON test_runs(site_id, strategy)
WHERE status = 'running';

-- Improve dashboard success-count queries.
CREATE INDEX IF NOT EXISTS idx_runs_status_completed
ON test_runs(status, completed_at DESC);
