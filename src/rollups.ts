import type { Strategy, MetricsDailyRollupRow, RetentionPruneResult } from "./types";
import { nowIso } from "./utils";
import { recordQuotaUsage } from "./quota";

export const RAW_DATA_RETENTION_DAYS = 90;
export const DEFAULT_PRUNE_BATCH_SIZE = 100;

/**
 * Computes the requested percentile (0 - 100) from an array of numbers.
 * Uses linear interpolation between closest ranks.
 */
export function computePercentile(
  values: (number | null | undefined)[],
  percentile: number
): number | null {
  const nums = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);

  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];

  const p = Math.max(0, Math.min(100, percentile));
  const index = (p / 100) * (nums.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  const interpolated = nums[lower] * (1 - weight) + nums[upper] * weight;
  return Math.round(interpolated * 1000) / 1000;
}

function roundInt(val: number | null): number | null {
  return val === null ? null : Math.round(val);
}

function roundDec(val: number | null, decimals = 1): number | null {
  if (val === null) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Computes and upserts daily rollup metrics for a given site, strategy, and date.
 * rollupDate format: "YYYY-MM-DD".
 */
export async function rollupSiteDayMetrics(
  db: D1Database,
  siteId: number,
  strategy: Strategy,
  rollupDate: string
): Promise<boolean> {
  const dayStart = `${rollupDate}T00:00:00.000Z`;
  const nextDay = new Date(new Date(dayStart).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const dayEnd = `${nextDay}T00:00:00.000Z`;

  const rows = await db
    .prepare(
      `SELECT *
       FROM metrics
       WHERE site_id = ?
         AND strategy = ?
         AND recorded_at >= ?
         AND recorded_at < ?
       ORDER BY recorded_at ASC`
    )
    .bind(siteId, strategy, dayStart, dayEnd)
    .all<any>();

  const records = rows.results || [];
  if (records.length === 0) {
    return false;
  }

  const perfMedian = roundInt(computePercentile(records.map((r) => r.performance_score), 50));
  const a11yMedian = roundInt(computePercentile(records.map((r) => r.accessibility_score), 50));
  const seoMedian = roundInt(computePercentile(records.map((r) => r.seo_score), 50));
  const bpMedian = roundInt(computePercentile(records.map((r) => r.best_practices_score), 50));

  const perfP75 = roundInt(computePercentile(records.map((r) => r.performance_score), 75));
  const a11yP75 = roundInt(computePercentile(records.map((r) => r.accessibility_score), 75));
  const seoP75 = roundInt(computePercentile(records.map((r) => r.seo_score), 75));
  const bpP75 = roundInt(computePercentile(records.map((r) => r.best_practices_score), 75));

  const fcpMedian = roundDec(computePercentile(records.map((r) => r.fcp_ms), 50), 1);
  const lcpMedian = roundDec(computePercentile(records.map((r) => r.lcp_ms), 50), 1);
  const tbtMedian = roundDec(computePercentile(records.map((r) => r.tbt_ms), 50), 1);
  const clsMedian = roundDec(computePercentile(records.map((r) => r.cls), 50), 3);
  const siMedian = roundDec(computePercentile(records.map((r) => r.speed_index_ms), 50), 1);

  const fcpP75 = roundDec(computePercentile(records.map((r) => r.fcp_ms), 75), 1);
  const lcpP75 = roundDec(computePercentile(records.map((r) => r.lcp_ms), 75), 1);
  const tbtP75 = roundDec(computePercentile(records.map((r) => r.tbt_ms), 75), 1);
  const clsP75 = roundDec(computePercentile(records.map((r) => r.cls), 75), 3);
  const siP75 = roundDec(computePercentile(records.map((r) => r.speed_index_ms), 75), 1);

  // Latest CrUX field data of the day
  let fieldLcp: number | null = null;
  let fieldInp: number | null = null;
  let fieldCls: number | null = null;
  let fieldDataSource: string | null = null;

  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.field_lcp_ms !== null && r.field_lcp_ms !== undefined) {
      fieldLcp = r.field_lcp_ms;
      fieldInp = r.field_inp_ms;
      fieldCls = r.field_cls;
      fieldDataSource = r.field_data_source;
      break;
    }
  }

  const at = nowIso();
  await db
    .prepare(
      `INSERT INTO metrics_daily_rollup (
         site_id, strategy, rollup_date, recorded_at,
         total_runs, successful_runs,
         performance_score, accessibility_score, seo_score, best_practices_score,
         performance_score_p75, accessibility_score_p75, seo_score_p75, best_practices_score_p75,
         fcp_ms, lcp_ms, tbt_ms, cls, speed_index_ms,
         fcp_ms_p75, lcp_ms_p75, tbt_ms_p75, cls_p75, speed_index_ms_p75,
         field_lcp_ms, field_inp_ms, field_cls, field_data_source,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?,
         ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?
       )
       ON CONFLICT(site_id, strategy, rollup_date) DO UPDATE SET
         total_runs = excluded.total_runs,
         successful_runs = excluded.successful_runs,
         performance_score = excluded.performance_score,
         accessibility_score = excluded.accessibility_score,
         seo_score = excluded.seo_score,
         best_practices_score = excluded.best_practices_score,
         performance_score_p75 = excluded.performance_score_p75,
         accessibility_score_p75 = excluded.accessibility_score_p75,
         seo_score_p75 = excluded.seo_score_p75,
         best_practices_score_p75 = excluded.best_practices_score_p75,
         fcp_ms = excluded.fcp_ms,
         lcp_ms = excluded.lcp_ms,
         tbt_ms = excluded.tbt_ms,
         cls = excluded.cls,
         speed_index_ms = excluded.speed_index_ms,
         fcp_ms_p75 = excluded.fcp_ms_p75,
         lcp_ms_p75 = excluded.lcp_ms_p75,
         tbt_ms_p75 = excluded.tbt_ms_p75,
         cls_p75 = excluded.cls_p75,
         speed_index_ms_p75 = excluded.speed_index_ms_p75,
         field_lcp_ms = excluded.field_lcp_ms,
         field_inp_ms = excluded.field_inp_ms,
         field_cls = excluded.field_cls,
         field_data_source = excluded.field_data_source,
         updated_at = excluded.updated_at`
    )
    .bind(
      siteId,
      strategy,
      rollupDate,
      dayStart,
      records.length,
      records.length,
      perfMedian,
      a11yMedian,
      seoMedian,
      bpMedian,
      perfP75,
      a11yP75,
      seoP75,
      bpP75,
      fcpMedian,
      lcpMedian,
      tbtMedian,
      clsMedian,
      siMedian,
      fcpP75,
      lcpP75,
      tbtP75,
      clsP75,
      siP75,
      fieldLcp,
      fieldInp,
      fieldCls,
      fieldDataSource,
      at,
      at
    )
    .run();

  await recordQuotaUsage(db, "d1_writes", 1);
  return true;
}

/**
 * Backfills un-rolled daily metrics in batches.
 */
export async function backfillDailyRollups(
  db: D1Database,
  limit = 50
): Promise<{ processed: number; completed: boolean }> {
  const candidates = await db
    .prepare(
      `SELECT DISTINCT site_id, strategy, substr(recorded_at, 1, 10) AS rollup_date
       FROM metrics
       WHERE (site_id, strategy, substr(recorded_at, 1, 10)) NOT IN (
         SELECT site_id, strategy, rollup_date FROM metrics_daily_rollup
       )
       ORDER BY recorded_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ site_id: number; strategy: Strategy; rollup_date: string }>();

  let processed = 0;
  for (const row of candidates.results || []) {
    await rollupSiteDayMetrics(db, row.site_id, row.strategy, row.rollup_date);
    processed++;
  }

  const remaining = await db
    .prepare(
      `SELECT COUNT(DISTINCT site_id || ':' || strategy || ':' || substr(recorded_at, 1, 10)) AS cnt
       FROM metrics
       WHERE (site_id, strategy, substr(recorded_at, 1, 10)) NOT IN (
         SELECT site_id, strategy, rollup_date FROM metrics_daily_rollup
       )`
    )
    .first<{ cnt: number }>();

  return {
    processed,
    completed: (remaining?.cnt || 0) === 0
  };
}

/**
 * Prunes raw metrics and test runs older than cutoff (default: 90 days),
 * in small batches per cron tick to avoid locks and stay within CPU budgets.
 * Crucially ensures daily rollups are generated BEFORE raw metrics are pruned.
 */
export async function pruneOldRawMetrics(
  db: D1Database,
  cutoffIsoString?: string,
  batchSize = DEFAULT_PRUNE_BATCH_SIZE
): Promise<RetentionPruneResult> {
  const cutoff =
    cutoffIsoString ||
    new Date(Date.now() - RAW_DATA_RETENTION_DAYS * 86_400_000).toISOString();

  // 1. Safety check: ensure any un-rolled data older than cutoff is rolled up first
  const unrolled = await db
    .prepare(
      `SELECT DISTINCT site_id, strategy, substr(recorded_at, 1, 10) AS rollup_date
       FROM metrics
       WHERE recorded_at < ?
         AND (site_id, strategy, substr(recorded_at, 1, 10)) NOT IN (
           SELECT site_id, strategy, rollup_date FROM metrics_daily_rollup
         )
       LIMIT 10`
    )
    .bind(cutoff)
    .all<{ site_id: number; strategy: Strategy; rollup_date: string }>();

  for (const row of unrolled.results || []) {
    await rollupSiteDayMetrics(db, row.site_id, row.strategy, row.rollup_date);
  }

  // 2. Prune raw metrics older than cutoff in small batches
  const metricsResult = await db
    .prepare(
      `DELETE FROM metrics
       WHERE id IN (
         SELECT id FROM metrics
         WHERE recorded_at < ?
         ORDER BY recorded_at ASC
         LIMIT ?
       )`
    )
    .bind(cutoff, batchSize)
    .run();
  const metricsPruned = Number(metricsResult.meta?.changes || 0);

  // 3. Prune test_runs older than cutoff (excluding runs referenced in site_latest)
  const runsResult = await db
    .prepare(
      `DELETE FROM test_runs
       WHERE id IN (
         SELECT id FROM test_runs
         WHERE started_at < ?
           AND id NOT IN (SELECT test_run_id FROM site_latest)
         ORDER BY started_at ASC
         LIMIT ?
       )`
    )
    .bind(cutoff, batchSize)
    .run();
  const runsPruned = Number(runsResult.meta?.changes || 0);

  // 4. Prune completed or failed scan_jobs older than cutoff
  const jobsResult = await db
    .prepare(
      `DELETE FROM scan_jobs
       WHERE id IN (
         SELECT id FROM scan_jobs
         WHERE status IN ('success', 'failed')
           AND created_at < ?
         ORDER BY created_at ASC
         LIMIT ?
       )`
    )
    .bind(cutoff, batchSize)
    .run();
  const jobsPruned = Number(jobsResult.meta?.changes || 0);

  const totalWrites = (metricsPruned > 0 ? 1 : 0) + (runsPruned > 0 ? 1 : 0) + (jobsPruned > 0 ? 1 : 0);
  if (totalWrites > 0) {
    await recordQuotaUsage(db, "d1_writes", totalWrites);
  }

  return {
    metricsPruned,
    runsPruned,
    jobsPruned,
    cutoff
  };
}

/**
 * Helper to run retention pruning during cron tick.
 */
export async function runRetentionPruneTick(
  db: D1Database,
  cutoffIsoString?: string,
  batchSize = DEFAULT_PRUNE_BATCH_SIZE
): Promise<RetentionPruneResult> {
  return await pruneOldRawMetrics(db, cutoffIsoString, batchSize);
}
