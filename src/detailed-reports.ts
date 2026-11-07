import type {
  DetailedReportDetailLevel,
  Env,
  ReportStorageBackend,
  Strategy
} from "./types";

import {
  nowIso,
  parsePositiveInt
} from "./utils";
import { recordQuotaUsage } from "./quota";


const RETAIN_READY_REPORTS =
  2;


/*
 * 400 KiB hard cap.
 *
 * 500 sites
 * x 2 strategies
 * x 2 retained reports
 * x 400 KiB
 * ~= 781 MiB maximum retained payload storage.
 */
export const MAX_DETAILED_REPORT_BYTES =
  400 * 1024;

export function getReportStorageBackend(env: Env): ReportStorageBackend {
  const configured = (env.REPORT_STORAGE || "").trim().toLowerCase();
  if (configured === "r2" && env.R2_REPORTS) {
    return "r2";
  }
  if (configured === "kv") {
    return "kv";
  }
  return "d1";
}

export async function putReportPayload(
  env: Env,
  storageKey: string,
  payloadJson: string,
  sizeBytes: number,
  metadata: {
    siteId: number;
    strategy: Strategy;
    testRunId: number;
    detailLevel: DetailedReportDetailLevel;
  }
): Promise<void> {
  const backend = getReportStorageBackend(env);

  if (backend === "d1") {
    const at = nowIso();
    await env.DB.prepare(
      `INSERT INTO report_payloads (storage_key, payload_json, size_bytes, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(storage_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         size_bytes = excluded.size_bytes,
         created_at = excluded.created_at`
    )
      .bind(storageKey, payloadJson, sizeBytes, at)
      .run();
    await recordQuotaUsage(env.DB, "d1_writes", 1);
    return;
  }

  if (backend === "r2" && env.R2_REPORTS) {
    await env.R2_REPORTS.put(storageKey, payloadJson, {
      customMetadata: {
        siteId: String(metadata.siteId),
        strategy: metadata.strategy,
        testRunId: String(metadata.testRunId),
        detailLevel: metadata.detailLevel
      }
    });
    return;
  }

  if (!env.REPORTS) {
    throw new Error("REPORT_STORAGE is configured as 'kv' but REPORTS KV namespace is not bound");
  }

  await env.REPORTS.put(storageKey, payloadJson, {
    metadata: {
      siteId: String(metadata.siteId),
      strategy: metadata.strategy,
      testRunId: String(metadata.testRunId),
      detailLevel: metadata.detailLevel
    }
  });
  await recordQuotaUsage(env.DB, "kv_writes", 1);
}

export async function getReportPayload(
  env: Env,
  storageKey: string
): Promise<string | null> {
  const backend = getReportStorageBackend(env);

  if (backend === "d1") {
    try {
      const row = await env.DB.prepare(
        "SELECT payload_json FROM report_payloads WHERE storage_key = ? LIMIT 1"
      )
        .bind(storageKey)
        .first<{ payload_json: string }>();
      if (row?.payload_json) return row.payload_json;
    } catch {}
    if (env.REPORTS) {
      try {
        const fromKv = await env.REPORTS.get(storageKey, "text");
        if (fromKv) {
          try {
            await env.DB.prepare(
              `INSERT INTO report_payloads (storage_key, payload_json, size_bytes, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(storage_key) DO NOTHING`
            )
              .bind(storageKey, fromKv, fromKv.length, nowIso())
              .run();
          } catch {}
          return fromKv;
        }
      } catch {}
    }
    return null;
  }

  if (backend === "r2" && env.R2_REPORTS) {
    const obj = await env.R2_REPORTS.get(storageKey);
    return obj ? await obj.text() : null;
  }

  if (env.REPORTS) {
    return await env.REPORTS.get(storageKey, "text");
  }

  return null;
}

export async function deleteReportPayload(
  env: Env,
  storageKey: string
): Promise<void> {
  const backend = getReportStorageBackend(env);

  if (backend === "d1") {
    try {
      await env.DB.prepare("DELETE FROM report_payloads WHERE storage_key = ?")
        .bind(storageKey)
        .run();
      await recordQuotaUsage(env.DB, "d1_writes", 1);
    } catch {}
    return;
  }

  if (backend === "r2" && env.R2_REPORTS) {
    await env.R2_REPORTS.delete(storageKey);
    return;
  }

  if (env.REPORTS) {
    await env.REPORTS.delete(storageKey);
  }
}


export type DetailedReportStoreStatus =
  | "stored"
  | "existing"
  | "disabled"
  | "budget_exhausted"
  | "oversize";


export interface DetailedReportMetadataRow {
  id: number;
  site_id: number;
  strategy: Strategy;
  test_run_id: number;

  storage_key: string;

  captured_at: string;

  size_bytes: number;

  detail_level:
    DetailedReportDetailLevel;

  final_url:
    | string
    | null;

  lighthouse_version:
    | string
    | null;

  state:
    | "ready"
    | "cleanup_pending";

  cleanup_error:
    | string
    | null;

  created_at: string;
  updated_at: string;
}


export interface DetailedReportListRow
  extends DetailedReportMetadataRow {
  crux_status:
    | "available"
    | "no_record"
    | "provider_error"
    | null;

  crux_error:
    | string
    | null;

  performance_score:
    | number
    | null;

  accessibility_score:
    | number
    | null;

  seo_score:
    | number
    | null;

  best_practices_score:
    | number
    | null;

  fcp_ms:
    | number
    | null;

  lcp_ms:
    | number
    | null;

  tbt_ms:
    | number
    | null;

  cls:
    | number
    | null;

  speed_index_ms:
    | number
    | null;

  field_lcp_ms:
    | number
    | null;

  field_inp_ms:
    | number
    | null;

  field_cls:
    | number
    | null;
}


export interface DetailedReportStoreResult {
  status:
    DetailedReportStoreStatus;

  report:
    | DetailedReportMetadataRow
    | null;

  reason:
    | string
    | null;
}


interface CleanupKeyRow {
  id:
    | number
    | null;

  storage_key: string;
}


interface CleanupTaskRow {
  id: number;

  report_id:
    | number
    | null;

  storage_key: string;

  reason: string;

  attempts: number;
}


function reportKey(
  siteId: number,
  strategy: Strategy,
  testRunId: number
): string {
  return (
    `reports/${siteId}/` +
    `${strategy}/` +
    `${testRunId}.json`
  );
}


function usageDate(
  at = nowIso()
): string {
  return at.slice(
    0,
    10
  );
}


export function getDetailedReportWriteBudget(
  env: Env
): number {
  const backend = getReportStorageBackend(env);
  if (backend === "d1") {
    return parsePositiveInt(
      env.DETAILED_REPORTS_DAILY_WRITE_BUDGET,
      50000,
      100000
    );
  }
  if (backend === "r2") {
    return parsePositiveInt(
      env.DETAILED_REPORTS_DAILY_WRITE_BUDGET,
      30000,
      50000
    );
  }
  return parsePositiveInt(
    env.DETAILED_REPORTS_DAILY_WRITE_BUDGET,
    800,
    1000
  );
}


export function getDetailedReportDeleteBudget(
  env: Env
): number {
  const backend = getReportStorageBackend(env);
  if (backend === "d1") {
    return parsePositiveInt(
      env.DETAILED_REPORTS_DAILY_DELETE_BUDGET,
      50000,
      100000
    );
  }
  if (backend === "r2") {
    return parsePositiveInt(
      env.DETAILED_REPORTS_DAILY_DELETE_BUDGET,
      50000,
      100000
    );
  }
  return parsePositiveInt(
    env.DETAILED_REPORTS_DAILY_DELETE_BUDGET,
    800,
    1000
  );
}


export async function migrateKvReportsToD1(
  env: Env,
  limit = 50
): Promise<{
  inspected: number;
  migrated: number;
  missingInKv: number;
  remaining: number;
}> {
  if (!env.REPORTS) {
    return { inspected: 0, migrated: 0, missingInKv: 0, remaining: 0 };
  }

  const rows = await env.DB.prepare(
    `SELECT storage_key, size_bytes, created_at
     FROM detailed_reports
     WHERE state = 'ready'
       AND storage_key NOT IN (SELECT storage_key FROM report_payloads)
     ORDER BY id ASC
     LIMIT ?`
  )
    .bind(limit)
    .all<{ storage_key: string; size_bytes: number; created_at: string }>();

  let migrated = 0;
  let missingInKv = 0;

  for (const row of rows.results || []) {
    try {
      const payload = await env.REPORTS.get(row.storage_key, "text");
      if (payload) {
        await env.DB.prepare(
          `INSERT INTO report_payloads (storage_key, payload_json, size_bytes, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(storage_key) DO UPDATE SET
             payload_json = excluded.payload_json,
             size_bytes = excluded.size_bytes`
        )
          .bind(row.storage_key, payload, payload.length, row.created_at || nowIso())
          .run();
        migrated++;
        await recordQuotaUsage(env.DB, "d1_writes", 1);
      } else {
        missingInKv++;
      }
    } catch {
      missingInKv++;
    }
  }

  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) as cnt
     FROM detailed_reports
     WHERE state = 'ready'
       AND storage_key NOT IN (SELECT storage_key FROM report_payloads)`
  ).first<{ cnt: number }>();

  return {
    inspected: rows.results?.length || 0,
    migrated,
    missingInKv,
    remaining: remainingRow?.cnt || 0
  };
}


export function getDetailedReportCleanupBatchSize(
  env: Env
): number {
  /*
   * Three cleanup attempts every five minutes can service up to
   * 864 queued deletions/day, while reserveDelete() hard-stops
   * actual KV deletes at the 800/day application safety budget.
   */
  return parsePositiveInt(
    env.DETAILED_REPORTS_CLEANUP_PER_CRON,
    3,
    3
  );
}


async function reserveWrite(
  db: D1Database,
  budget: number,
  at: string
): Promise<boolean> {
  const result =
    await db.prepare(
      `INSERT INTO report_daily_usage (
         usage_date,
         writes,
         deletes,
         updated_at
       )
       VALUES (
         ?,
         1,
         0,
         ?
       )

       ON CONFLICT(
         usage_date
       )
       DO UPDATE SET
         writes=
           report_daily_usage.writes + 1,

         updated_at=
           excluded.updated_at

       WHERE
         report_daily_usage.writes < ?`
    )
      .bind(
        usageDate(
          at
        ),
        at,
        budget
      )
      .run();


  return Number(
    result.meta.changes ||
    0
  ) > 0;
}


async function reserveDelete(
  db: D1Database,
  budget: number,
  at: string
): Promise<boolean> {
  const result =
    await db.prepare(
      `INSERT INTO report_daily_usage (
         usage_date,
         writes,
         deletes,
         updated_at
       )
       VALUES (
         ?,
         0,
         1,
         ?
       )

       ON CONFLICT(
         usage_date
       )
       DO UPDATE SET
         deletes=
           report_daily_usage.deletes + 1,

         updated_at=
           excluded.updated_at

       WHERE
         report_daily_usage.deletes < ?`
    )
      .bind(
        usageDate(
          at
        ),
        at,
        budget
      )
      .run();


  return Number(
    result.meta.changes ||
    0
  ) > 0;
}


async function queueCleanupRows(
  db: D1Database,
  rows: CleanupKeyRow[],
  reason: string,
  at = nowIso()
): Promise<void> {
  if (
    rows.length === 0
  ) {
    return;
  }


  const chunkSize =
    50;


  for (
    let index = 0;
    index < rows.length;
    index += chunkSize
  ) {
    const group =
      rows.slice(
        index,
        index +
        chunkSize
      );


    const statements =
      group.map(
        (row) =>
          db.prepare(
            `INSERT OR IGNORE
             INTO report_cleanup_tasks (
               report_id,
               storage_key,
               reason,
               attempts,
               last_error,
               created_at,
               updated_at
             )
             VALUES (
               ?,
               ?,
               ?,
               0,
               NULL,
               ?,
               ?
             )`
          )
            .bind(
              row.id,
              row.storage_key,
              reason,
              at,
              at
            )
      );


    await db.batch(
      statements
    );
  }
}


async function enforceRetention(
  env: Env,
  siteId: number,
  strategy: Strategy
): Promise<void> {
  const old =
    await env.DB.prepare(
      `SELECT
         id,
         storage_key

       FROM detailed_reports

       WHERE site_id=?
         AND strategy=?
         AND state='ready'

       ORDER BY
         captured_at DESC,
         id DESC

       LIMIT 100
       OFFSET ?`
    )
      .bind(
        siteId,
        strategy,
        RETAIN_READY_REPORTS
      )
      .all<{
        id: number;
        storage_key: string;
      }>();


  const rows =
    old.results ||
    [];


  if (
    rows.length === 0
  ) {
    return;
  }


  const at =
    nowIso();


  const statements:
    D1PreparedStatement[] = [];


  for (
    const row of
    rows
  ) {
    statements.push(
      env.DB.prepare(
        `UPDATE detailed_reports
            SET state='cleanup_pending',
                cleanup_error=NULL,
                updated_at=?
          WHERE id=?
            AND state='ready'`
      )
        .bind(
          at,
          row.id
        )
    );


    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE
         INTO report_cleanup_tasks (
           report_id,
           storage_key,
           reason,
           attempts,
           last_error,
           created_at,
           updated_at
         )
         VALUES (
           ?,
           ?,
           'retention',
           0,
           NULL,
           ?,
           ?
         )`
      )
        .bind(
          row.id,
          row.storage_key,
          at,
          at
        )
    );
  }


  /*
   * D1 controls user-visible retention immediately.
   *
   * KV deletion is asynchronous and budgeted separately, so a KV
   * consistency delay cannot make an obsolete report visible again.
   */
  await env.DB.batch(
    statements
  );
}


export async function storeDetailedReport(
  env: Env,
  input: {
    siteId: number;
    strategy: Strategy;
    testRunId: number;
    capturedAt: string;
    finalUrl: string;

    lighthouseVersion:
      | string
      | null;

    payloadJson: string;

    sizeBytes: number;

    detailLevel:
      DetailedReportDetailLevel;
  }
): Promise<
  DetailedReportStoreResult
> {
  if (
    env.DETAILED_REPORTS_ENABLED !==
    "1"
  ) {
    return {
      status:
        "disabled",

      report:
        null,

      reason:
        "Detailed reports are disabled"
    };
  }


  const existing =
    await env.DB.prepare(
      `SELECT *
       FROM detailed_reports
       WHERE test_run_id=?
       LIMIT 1`
    )
      .bind(
        input.testRunId
      )
      .first<
        DetailedReportMetadataRow
      >();


  if (existing) {
    return {
      status:
        "existing",

      report:
        existing,

      reason:
        null
    };
  }


  if (
    input.sizeBytes >
    MAX_DETAILED_REPORT_BYTES
  ) {
    console.warn(
      "detailed_report.oversize",
      JSON.stringify({
        siteId:
          input.siteId,

        strategy:
          input.strategy,

        testRunId:
          input.testRunId,

        sizeBytes:
          input.sizeBytes,

        maximum:
          MAX_DETAILED_REPORT_BYTES
      })
    );


    return {
      status:
        "oversize",

      report:
        null,

      reason:
        `Detailed report exceeded ${MAX_DETAILED_REPORT_BYTES} byte application limit`
    };
  }


  const at =
    nowIso();


  const writeBudget =
    getDetailedReportWriteBudget(
      env
    );


  const reserved =
    await reserveWrite(
      env.DB,
      writeBudget,
      at
    );


  if (!reserved) {
    console.warn(
      "detailed_report.write_budget_exhausted",
      JSON.stringify({
        siteId:
          input.siteId,

        strategy:
          input.strategy,

        testRunId:
          input.testRunId,

        budget:
          writeBudget
      })
    );


    return {
      status:
        "budget_exhausted",

      report:
        null,

      reason:
        "Daily detailed-report KV write budget reached"
    };
  }


  const storageKey =
    reportKey(
      input.siteId,
      input.strategy,
      input.testRunId
    );


  await putReportPayload(
    env,
    storageKey,
    input.payloadJson,
    input.sizeBytes,
    {
      siteId: input.siteId,
      strategy: input.strategy,
      testRunId: input.testRunId,
      detailLevel: input.detailLevel
    }
  );


  try {
    await env.DB.prepare(
      `INSERT INTO detailed_reports (
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
       VALUES (
         ?,
         ?,
         ?,
         ?,
         ?,
         ?,
         ?,
         ?,
         ?,
         'ready',
         NULL,
         ?,
         ?
       )`
    )
      .bind(
        input.siteId,
        input.strategy,
        input.testRunId,
        storageKey,
        input.capturedAt,
        input.sizeBytes,
        input.detailLevel,
        input.finalUrl,
        input.lighthouseVersion,
        at,
        at
      )
      .run();
  } catch (error) {
    /*
     * KV has already accepted the object but no valid metadata row
     * exists. Queue it for asynchronous deletion instead of risking
     * another unbudgeted provider request.
     */
    try {
      await queueCleanupRows(
        env.DB,
        [{
          id:
            null,

          storage_key:
            storageKey
        }],
        "metadata_insert_failed",
        at
      );
    } catch (
      cleanupError
    ) {
      console.error(
        "detailed_report.orphan_queue_failed",
        cleanupError
      );
    }


    throw error;
  }


  await enforceRetention(
    env,
    input.siteId,
    input.strategy
  );


  const row =
    await env.DB.prepare(
      `SELECT *
       FROM detailed_reports
       WHERE test_run_id=?
       LIMIT 1`
    )
      .bind(
        input.testRunId
      )
      .first<
        DetailedReportMetadataRow
      >();


  if (!row) {
    throw new Error(
      "Detailed report metadata could not be read back"
    );
  }


  return {
    status:
      "stored",

    report:
      row,

    reason:
      null
  };
}


export async function listDetailedReports(
  db: D1Database,
  siteId: number,
  strategy: Strategy
): Promise<
  DetailedReportListRow[]
> {
  const result =
    await db.prepare(
      `SELECT
         dr.*,

         tr.crux_status,
         tr.crux_error,

         m.performance_score,
         m.accessibility_score,
         m.seo_score,
         m.best_practices_score,

         m.fcp_ms,
         m.lcp_ms,
         m.tbt_ms,
         m.cls,
         m.speed_index_ms,

         m.field_lcp_ms,
         m.field_inp_ms,
         m.field_cls

       FROM detailed_reports dr

       JOIN test_runs tr
         ON tr.id=
           dr.test_run_id

       LEFT JOIN metrics m
         ON m.test_run_id=
           dr.test_run_id

       WHERE dr.site_id=?
         AND dr.strategy=?
         AND dr.state='ready'

       ORDER BY
         dr.captured_at DESC,
         dr.id DESC

       LIMIT 2`
    )
      .bind(
        siteId,
        strategy
      )
      .all<
        DetailedReportListRow
      >();


  return result.results ||
    [];
}


const COMPARISON_KEYS = [
  "performance_score",
  "accessibility_score",
  "seo_score",
  "best_practices_score",
  "fcp_ms",
  "lcp_ms",
  "tbt_ms",
  "cls",
  "speed_index_ms",
  "field_lcp_ms",
  "field_inp_ms",
  "field_cls"
] as const;


function metricDelta(
  latest:
    DetailedReportListRow,

  previous:
    DetailedReportListRow,

  key:
    typeof COMPARISON_KEYS[number]
): number | null {
  const latestValue =
    latest[
      key
    ];


  const previousValue =
    previous[
      key
    ];


  if (
    latestValue === null ||
    latestValue === undefined ||
    previousValue === null ||
    previousValue === undefined
  ) {
    return null;
  }


  const a =
    Number(
      latestValue
    );


  const b =
    Number(
      previousValue
    );


  if (
    !Number.isFinite(
      a
    ) ||
    !Number.isFinite(
      b
    )
  ) {
    return null;
  }


  return (
    Math.round(
      (
        a -
        b
      ) *
      1000
    ) /
    1000
  );
}


export async function getDetailedReportComparison(
  db: D1Database,
  siteId: number,
  strategy: Strategy
) {
  const reports =
    await listDetailedReports(
      db,
      siteId,
      strategy
    );


  const latest =
    reports[
      0
    ] ||
    null;


  const previous =
    reports[
      1
    ] ||
    null;


  const deltas:
    Record<
      string,
      number | null
    > = {};


  if (
    latest &&
    previous
  ) {
    for (
      const key of
      COMPARISON_KEYS
    ) {
      deltas[
        key
      ] =
        metricDelta(
          latest,
          previous,
          key
        );
    }
  }


  return {
    latest,
    previous,
    deltas
  };
}


export async function getDetailedReportJsonResponse(
  env: Env,
  reportId: number
): Promise<Response> {
  const row =
    await env.DB.prepare(
      `SELECT
         id,
         site_id,
         strategy,
         test_run_id,
         storage_key,
         detail_level

       FROM detailed_reports

       WHERE id=?
         AND state='ready'

       LIMIT 1`
    )
      .bind(
        reportId
      )
      .first<{
        id: number;
        site_id: number;
        strategy: Strategy;
        test_run_id: number;
        storage_key: string;

        detail_level:
          DetailedReportDetailLevel;
      }>();


  if (!row) {
    return new Response(
      JSON.stringify({
        ok:
          false,

        error:
          "Detailed report not found"
      }),
      {
        status:
          404,

        headers: {
          "content-type":
            "application/json; charset=utf-8",

          "cache-control":
            "no-store"
        }
      }
    );
  }


  const payload =
    await getReportPayload(
      env,
      row.storage_key
    );


  if (
    payload === null
  ) {
    return new Response(
      JSON.stringify({
        ok:
          false,

        error:
          "Detailed report payload not available yet"
      }),
      {
        status:
          503,

        headers: {
          "content-type":
            "application/json; charset=utf-8",

          "cache-control":
            "no-store",

          "retry-after":
            "10"
        }
      }
    );
  }


  return new Response(
    payload,
    {
      status:
        200,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "private, no-store",

        "content-disposition":
          `inline; filename="speedpulse-${row.site_id}-${row.strategy}-${row.test_run_id}.json"`,

        "x-speedpulse-report-id":
          String(
            row.id
          ),

        "x-speedpulse-detail-level":
          row.detail_level
      }
    }
  );
}


export async function queueDetailedReportsForSiteDeletion(
  db: D1Database,
  siteId: number
): Promise<number> {
  const result =
    await db.prepare(
      `SELECT
         id,
         storage_key

       FROM detailed_reports

       WHERE site_id=?`
    )
      .bind(
        siteId
      )
      .all<{
        id: number;
        storage_key: string;
      }>();


  const rows =
    result.results ||
    [];


  await queueCleanupRows(
    db,
    rows,
    "site_deleted"
  );


  return rows.length;
}


export async function queueDetailedReportsForProjectDeletion(
  db: D1Database,
  projectId: number
): Promise<number> {
  const result =
    await db.prepare(
      `SELECT
         dr.id,
         dr.storage_key

       FROM detailed_reports dr

       JOIN sites s
         ON s.id=
           dr.site_id

       WHERE s.project_id=?`
    )
      .bind(
        projectId
      )
      .all<{
        id: number;
        storage_key: string;
      }>();


  const rows =
    result.results ||
    [];


  await queueCleanupRows(
    db,
    rows,
    "project_deleted"
  );


  return rows.length;
}


export async function processDetailedReportCleanup(
  env: Env,
  requestedLimit?: number
): Promise<{
  requested: number;
  deleted: number;
  failed: number;
  remaining: number;
  deleteBudget: number;
  deleteBudgetUsed: number;
  budgetExhausted: boolean;
}> {
  const configured =
    getDetailedReportCleanupBatchSize(
      env
    );


  const limit =
    Math.max(
      1,
      Math.min(
        3,
        requestedLimit ||
        configured
      )
    );


  const tasks =
    await env.DB.prepare(
      `SELECT
         id,
         report_id,
         storage_key,
         reason,
         attempts

       FROM report_cleanup_tasks

       ORDER BY
         created_at,
         id

       LIMIT ?`
    )
      .bind(
        limit
      )
      .all<
        CleanupTaskRow
      >();


  let deleted = 0;
  let failed = 0;

  let budgetExhausted =
    false;


  const deleteBudget =
    getDetailedReportDeleteBudget(
      env
    );


  for (
    const task of
    tasks.results ||
    []
  ) {
    const at =
      nowIso();


    const reserved =
      await reserveDelete(
        env.DB,
        deleteBudget,
        at
      );


    if (!reserved) {
      budgetExhausted =
        true;

      break;
    }


    try {
      await deleteReportPayload(
        env,
        task.storage_key
      );


      const statements:
        D1PreparedStatement[] = [];


      if (
        task.report_id
      ) {
        statements.push(
          env.DB.prepare(
            `DELETE FROM detailed_reports
             WHERE id=?
               AND state='cleanup_pending'`
          )
            .bind(
              task.report_id
            )
        );
      }


      statements.push(
        env.DB.prepare(
          `DELETE FROM report_cleanup_tasks
           WHERE id=?`
        )
          .bind(
            task.id
          )
      );


      await env.DB.batch(
        statements
      );


      deleted++;
    } catch (error) {
      failed++;


      const message =
        error instanceof Error
          ? error.message
          : String(
              error
            );


      try {
        await env.DB.prepare(
          `UPDATE report_cleanup_tasks
              SET attempts=
                    attempts + 1,
                  last_error=?,
                  updated_at=?
            WHERE id=?`
        )
          .bind(
            message.slice(
              0,
              900
            ),
            at,
            task.id
          )
          .run();


        if (
          task.report_id
        ) {
          await env.DB.prepare(
            `UPDATE detailed_reports
                SET cleanup_error=?,
                    updated_at=?
              WHERE id=?`
          )
            .bind(
              message.slice(
                0,
                900
              ),
              at,
              task.report_id
            )
            .run();
        }
      } catch (
        updateError
      ) {
        console.error(
          "detailed_report.cleanup_state_failed",
          updateError
        );
      }


      console.error(
        "detailed_report.cleanup_failed",
        JSON.stringify({
          taskId:
            task.id,

          reportId:
            task.report_id,

          storageKey:
            task.storage_key,

          error:
            message
        })
      );
    }
  }


  const remainingRow =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM report_cleanup_tasks`
    )
      .first<{
        count: number;
      }>();


  const usage =
    await env.DB.prepare(
      `SELECT deletes
       FROM report_daily_usage
       WHERE usage_date=?`
    )
      .bind(
        usageDate()
      )
      .first<{
        deletes: number;
      }>();


  return {
    requested:
      (
        tasks.results ||
        []
      ).length,

    deleted,
    failed,

    remaining:
      Number(
        remainingRow
          ?.count ||
        0
      ),

    deleteBudget,

    deleteBudgetUsed:
      Number(
        usage?.deletes ||
        0
      ),

    budgetExhausted
  };
}


export async function getDetailedReportHealth(
  env: Env
): Promise<{
  ready: number;
  cleanupPending: number;
  cleanupTasks: number;

  bytesReady: number;
  bytesCleanupPending: number;

  writesToday: number;
  deletesToday: number;

  writeBudget: number;
  deleteBudget: number;

  maximumPayloadBytes: number;
}> {
  const [
    reportCounts,
    cleanupCount,
    usage
  ] =
    await Promise.all([
      env.DB.prepare(
        `SELECT
           SUM(
             CASE
               WHEN state='ready'
                 THEN 1
               ELSE 0
             END
           ) AS ready,

           SUM(
             CASE
               WHEN state='cleanup_pending'
                 THEN 1
               ELSE 0
             END
           ) AS cleanup_pending,

           COALESCE(
             SUM(
               CASE
                 WHEN state='ready'
                   THEN size_bytes
                 ELSE 0
               END
             ),
             0
           ) AS bytes_ready,

           COALESCE(
             SUM(
               CASE
                 WHEN state='cleanup_pending'
                   THEN size_bytes
                 ELSE 0
               END
             ),
             0
           ) AS bytes_cleanup_pending

         FROM detailed_reports`
      )
        .first<{
          ready: number;
          cleanup_pending: number;
          bytes_ready: number;
          bytes_cleanup_pending: number;
        }>(),


      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM report_cleanup_tasks`
      )
        .first<{
          count: number;
        }>(),


      env.DB.prepare(
        `SELECT
           writes,
           deletes

         FROM report_daily_usage

         WHERE usage_date=?`
      )
        .bind(
          usageDate()
        )
        .first<{
          writes: number;
          deletes: number;
        }>()
    ]);


  return {
    ready:
      Number(
        reportCounts
          ?.ready ||
        0
      ),

    cleanupPending:
      Number(
        reportCounts
          ?.cleanup_pending ||
        0
      ),

    cleanupTasks:
      Number(
        cleanupCount
          ?.count ||
        0
      ),

    bytesReady:
      Number(
        reportCounts
          ?.bytes_ready ||
        0
      ),

    bytesCleanupPending:
      Number(
        reportCounts
          ?.bytes_cleanup_pending ||
        0
      ),

    writesToday:
      Number(
        usage?.writes ||
        0
      ),

    deletesToday:
      Number(
        usage?.deletes ||
        0
      ),

    writeBudget:
      getDetailedReportWriteBudget(
        env
      ),

    deleteBudget:
      getDetailedReportDeleteBudget(
        env
      ),

    maximumPayloadBytes:
      MAX_DETAILED_REPORT_BYTES
  };
}
