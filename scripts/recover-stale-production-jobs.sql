-- =============================================================================
-- SpeedPulse Production Stale Jobs Recovery Script
-- Target: Jobs 3035 (pending since Oct 15), 3934 (running since Oct 20),
--         4320 (running since Oct 22).
--
-- DO NOT RUN AUTOMATICALLY.
-- Review the preview queries first before executing mutations.
--
-- Usage:
--   wrangler d1 execute <DATABASE_NAME> --remote --file=scripts/recover-stale-production-jobs.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1: PREVIEW CANDIDATE STALE JOBS (READ-ONLY)
-- Inspect the current state of jobs 3035, 3934, 4320.
-- -----------------------------------------------------------------------------
SELECT
  j.id AS job_id,
  j.site_id,
  s.name AS site_name,
  s.url AS site_url,
  j.strategy,
  j.trigger,
  j.status,
  j.attempt,
  j.created_at,
  j.queued_at,
  j.started_at,
  j.completed_at,
  j.test_run_id,
  j.error_class,
  j.error_message
FROM scan_jobs j
JOIN sites s ON s.id = j.site_id
WHERE j.id IN (3035, 3934, 4320);

-- -----------------------------------------------------------------------------
-- STEP 2: PREVIEW ANY LINKED RUNNING TEST RUNS
-- -----------------------------------------------------------------------------
SELECT
  r.id AS run_id,
  r.site_id,
  r.strategy,
  r.status,
  r.started_at,
  r.completed_at,
  r.error_message
FROM test_runs r
WHERE r.id IN (
  SELECT test_run_id
    FROM scan_jobs
   WHERE id IN (3035, 3934, 4320)
     AND test_run_id IS NOT NULL
)
OR (
  r.site_id IN (SELECT site_id FROM scan_jobs WHERE id IN (3035, 3934, 4320))
  AND r.status = 'running'
);

-- -----------------------------------------------------------------------------
-- STEP 3: EXECUTE RECOVERY MUTATIONS
-- Mark the stuck jobs as failed with lease_expired error class.
-- -----------------------------------------------------------------------------
UPDATE scan_jobs
   SET status = 'failed',
       error_class = 'lease_expired',
       error_message = 'Job lease expired (recovered by operator)',
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id IN (3035, 3934, 4320)
   AND status IN ('pending', 'queued', 'running');

-- Clean up any orphaned running test runs linked to these jobs
UPDATE test_runs
   SET status = 'failed',
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       error_message = COALESCE(error_message, 'Job lease expired (recovered by operator)')
 WHERE (
   id IN (
     SELECT test_run_id
       FROM scan_jobs
      WHERE id IN (3035, 3934, 4320)
        AND test_run_id IS NOT NULL
   )
   OR (
     site_id IN (SELECT site_id FROM scan_jobs WHERE id IN (3035, 3934, 4320))
     AND status = 'running'
   )
 )
 AND status = 'running';

-- -----------------------------------------------------------------------------
-- STEP 4: POST-RECOVERY VERIFICATION (READ-ONLY)
-- Confirm jobs are marked 'failed' and targets are now unblocked.
-- -----------------------------------------------------------------------------
SELECT
  j.id AS job_id,
  j.site_id,
  s.name AS site_name,
  j.strategy,
  j.status,
  j.completed_at,
  j.error_class,
  j.error_message
FROM scan_jobs j
JOIN sites s ON s.id = j.site_id
WHERE j.id IN (3035, 3934, 4320);

-- Confirm that targets for these sites are now unblocked for scheduling
SELECT
  t.id AS target_id,
  t.site_id,
  s.name AS site_name,
  t.strategy,
  t.enabled,
  t.next_due_at
FROM scan_targets t
JOIN sites s ON s.id = t.site_id
WHERE t.site_id IN (
  SELECT site_id FROM scan_jobs WHERE id IN (3035, 3934, 4320)
)
AND t.enabled = 1;
