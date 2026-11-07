/**
 * Shared scan execution policy.
 *
 * scan_jobs and test_runs represent different layers of the same
 * physical scan. They must use the same stale-running lease or a
 * recovered Queue job can collide with an apparently live test_run.
 */
export const SCAN_RUN_LEASE_MS =
  5 * 60 * 1000;


/**
 * Dispatch lease for jobs waiting in pending or queued state.
 *
 * 15 minutes (900,000 ms).
 * Covers initial Queue delivery latency + 3 execution attempts (3 * 60s = 180s)
 * + 3 retry delays (3 * 120s = 360s) + queue buffering/delivery margin (360s).
 * Any job remaining pending or queued past this window is definitively abandoned.
 */
export const SCAN_DISPATCH_LEASE_MS =
  15 * 60 * 1000;


/*
 * CHECKPOINT-19:
 *
 * Keep the Cloudflare Queue retry delay in one shared place.
 *
 * Queue execution uses this value and the Queue workspace exposes
 * it so the browser can calculate an approximate retry countdown
 * without duplicating runtime policy.
 */
export const SCAN_QUEUE_RETRY_DELAY_SECONDS =
  120;
