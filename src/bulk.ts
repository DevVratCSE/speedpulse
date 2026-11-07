import type { Env, Strategy } from "./types";

import {
  refreshBulkScanJob
} from "./control-plane";

import {
  computeNextScheduleAt,
  normalizeSchedule,
  scheduleIntervalHours
} from "./schedule-engine";

import {
  nowIso
} from "./utils";

const MAX_BULK_SITES = 500;

/*
 * 9 fixed SQL parameters + 90 IDs = 99 parameters,
 * keeping each statement below D1's 100-parameter limit.
 */
const SITE_CHUNK_SIZE = 90;

export class BulkScheduleInputError
  extends Error {}

export interface BulkScheduleInput {
  siteIds?: unknown;
  strategies?: unknown;
  schedule?: unknown;
}

export interface BulkScheduleResult {
  bulkJobId: number;
  status:
    | "success"
    | "partial"
    | "failed";
  sitesRequested: number;
  targetsRequested: number;
  completed: number;
  skipped: number;
  schedule: {
    type:
      | "manual"
      | "interval"
      | "daily"
      | "weekly";
    timezone: string;
    config: unknown;
    nextDueAt: string | null;
    spreadApplied: boolean;
  };
}

export interface BulkJobRow {
  id: number;
  action: string;
  status: string;
  total_count: number;
  completed_count: number;
  failed_count: number;
  skipped_count: number;
  parameters_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function normalizeSiteIds(
  value: unknown
): number[] {
  if (!Array.isArray(value)) {
    throw new BulkScheduleInputError(
      "siteIds must be an array"
    );
  }

  if (value.length === 0) {
    throw new BulkScheduleInputError(
      "siteIds cannot be empty"
    );
  }

  const ids: number[] = [];

  for (const raw of value) {
    const id = Number(raw);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      throw new BulkScheduleInputError(
        "siteIds must contain positive integer IDs"
      );
    }

    ids.push(id);
  }

  const unique =
    Array.from(
      new Set(ids)
    );

  if (
    unique.length >
    MAX_BULK_SITES
  ) {
    throw new BulkScheduleInputError(
      `A maximum of ${MAX_BULK_SITES} sites can be updated at once`
    );
  }

  return unique;
}

function normalizeStrategies(
  value: unknown
): Strategy[] {
  let values: unknown[];

  if (value === "both") {
    values = [
      "mobile",
      "desktop"
    ];
  } else if (
    value === "mobile" ||
    value === "desktop"
  ) {
    values = [value];
  } else if (
    Array.isArray(value)
  ) {
    values = value;
  } else {
    throw new BulkScheduleInputError(
      "strategies must be mobile, desktop, both, or an array"
    );
  }

  const strategies =
    Array.from(
      new Set(
        values.map(
          (item) => String(item)
        )
      )
    );

  if (
    strategies.length === 0 ||
    strategies.some(
      (strategy) =>
        strategy !== "mobile" &&
        strategy !== "desktop"
    )
  ) {
    throw new BulkScheduleInputError(
      "strategies may contain only mobile and desktop"
    );
  }

  return strategies as Strategy[];
}

function chunks<T>(
  values: T[],
  size: number
): T[][] {
  const result: T[][] = [];

  for (
    let i = 0;
    i < values.length;
    i += size
  ) {
    result.push(
      values.slice(
        i,
        i + size
      )
    );
  }

  return result;
}

export async function applyBulkSchedule(
  db: D1Database,
  input: BulkScheduleInput,
  at = nowIso()
): Promise<BulkScheduleResult> {
  const siteIds =
    normalizeSiteIds(
      input.siteIds
    );

  const strategies =
    normalizeStrategies(
      input.strategies
    );

  let schedule;

  try {
    schedule =
      normalizeSchedule(
        input.schedule
      );
  } catch (error) {
    throw new BulkScheduleInputError(
      error instanceof Error
        ? error.message
        : String(error)
    );
  }


  /*
   * The base value remains useful to clients as the nominal schedule
   * time. Actual interval targets receive deterministic per-target
   * jitter below.
   */
  const baseNextDueAt =
    computeNextScheduleAt(
      schedule,
      at
    );


  const intervalHours =
    scheduleIntervalHours(
      schedule
    );


  const targetsRequested =
    siteIds.length *
    strategies.length;


  const parameters = {
    siteIds,
    strategies,
    schedule,
    deterministicSpread:
      schedule.type ===
      "interval"
  };


  const created =
    await db.prepare(
      `INSERT INTO bulk_jobs (
         action,
         status,
         total_count,
         completed_count,
         failed_count,
         skipped_count,
         parameters_json,
         created_at,
         started_at,
         updated_at
       )
       VALUES (
         'schedule.update',
         'running',
         ?,
         0,
         0,
         0,
         ?,
         ?,
         ?,
         ?
       )`
    )
      .bind(
        targetsRequested,
        JSON.stringify(
          parameters
        ),
        at,
        at,
        at
      )
      .run();


  const bulkJobId =
    Number(
      created
        .meta
        .last_row_id
    );


  if (!bulkJobId) {
    throw new Error(
      "Failed to create bulk job"
    );
  }


  let completed = 0;


  try {
    /*
     * Each target computes its own next_due_at. D1 batch keeps this
     * efficient without building SQL statements containing hundreds
     * of bound CASE parameters.
     */
    const updateChunkSize =
      50;


    for (
      const strategy of
      strategies
    ) {
      for (
        const group of
        chunks(
          siteIds,
          updateChunkSize
        )
      ) {
        const statements =
          group.map(
            (siteId) => {
              const targetNextDueAt =
                computeNextScheduleAt(
                  schedule,
                  at,
                  siteId,
                  strategy
                );


              return db.prepare(
                `UPDATE scan_targets

                    SET
                      schedule_type=?,

                      schedule_config_json=?,

                      timezone=?,

                      enabled=CASE
                        WHEN ? IS NULL
                          THEN 0

                        WHEN EXISTS (
                          SELECT 1
                          FROM sites s
                          WHERE
                            s.id=
                              scan_targets.site_id
                            AND
                            s.active != 0
                        )
                          THEN 1

                        ELSE 0
                      END,

                      interval_hours=?,

                      next_due_at=CASE
                        WHEN ? IS NULL
                          THEN NULL

                        WHEN EXISTS (
                          SELECT 1
                          FROM sites s
                          WHERE
                            s.id=
                              scan_targets.site_id
                            AND
                            s.active != 0
                        )
                          THEN ?

                        ELSE NULL
                      END,

                      updated_at=?

                  WHERE strategy=?
                    AND site_id=?`
              )
                .bind(
                  schedule.type,

                  JSON.stringify(
                    schedule.config
                  ),

                  schedule.timezone,

                  targetNextDueAt,

                  intervalHours,

                  targetNextDueAt,

                  targetNextDueAt,

                  at,

                  strategy,

                  siteId
                );
            }
          );


        const results =
          await db.batch(
            statements
          );


        completed +=
          results.reduce(
            (
              sum,
              result
            ) =>
              sum +
              Number(
                result
                  .meta
                  .changes ||
                0
              ),
            0
          );
      }
    }


    const skipped =
      Math.max(
        0,
        targetsRequested -
        completed
      );


    const status:
      "success" |
      "partial" =
        skipped === 0
          ? "success"
          : "partial";


    await db.prepare(
      `UPDATE bulk_jobs
          SET status=?,
              completed_count=?,
              failed_count=0,
              skipped_count=?,
              completed_at=?,
              updated_at=?
        WHERE id=?`
    )
      .bind(
        status,
        completed,
        skipped,
        at,
        at,
        bulkJobId
      )
      .run();


    return {
      bulkJobId,

      status,

      sitesRequested:
        siteIds.length,

      targetsRequested,

      completed,

      skipped,

      schedule: {
        type:
          schedule.type,

        timezone:
          schedule.timezone,

        config:
          schedule.config,

        nextDueAt:
          baseNextDueAt,

        spreadApplied:
          schedule.type ===
          "interval" &&
          targetsRequested > 1
      }
    };
  } catch (error) {
    const failed =
      Math.max(
        0,
        targetsRequested -
        completed
      );


    const status:
      "partial" |
      "failed" =
        completed > 0
          ? "partial"
          : "failed";


    await db.prepare(
      `UPDATE bulk_jobs
          SET status=?,
              completed_count=?,
              failed_count=?,
              skipped_count=0,
              completed_at=?,
              updated_at=?
        WHERE id=?`
    )
      .bind(
        status,
        completed,
        failed,
        at,
        at,
        bulkJobId
      )
      .run();


    throw error;
  }
}


export async function listRecentBulkJobs(
  db: D1Database,
  limit = 20
): Promise<BulkJobRow[]> {
  const safeLimit =
    Math.max(
      1,
      Math.min(
        100,
        Math.floor(limit) || 20
      )
    );

  const result =
    await db.prepare(
      `SELECT
         id,
         action,
         status,
         total_count,
         completed_count,
         failed_count,
         skipped_count,
         parameters_json,
         created_at,
         started_at,
         completed_at,
         updated_at
       FROM bulk_jobs
       ORDER BY id DESC
       LIMIT ?`
    )
      .bind(
        safeLimit
      )
      .all<BulkJobRow>();

  return result.results || [];
}

const BULK_QUEUE_BATCH_SIZE = 90;

export interface BulkRunScansInput {
  siteIds?: unknown;
  strategies?: unknown;
}

export interface BulkRunScansResult {
  bulkJobId: number;
  status: "queued" | "partial";
  sitesRequested: number;
  targetsRequested: number;
  queued: number;
  skipped: number;
}

export async function queueBulkScans(
  env: Env,
  input: BulkRunScansInput,
  at = nowIso()
): Promise<BulkRunScansResult> {
  const siteIds =
    normalizeSiteIds(
      input.siteIds
    );

  const strategies =
    normalizeStrategies(
      input.strategies
    );

  const total =
    siteIds.length *
    strategies.length;

  const created =
    await env.DB.prepare(
      `INSERT INTO bulk_jobs (
         action,
         status,
         total_count,
         completed_count,
         failed_count,
         skipped_count,
         parameters_json,
         created_at,
         started_at,
         updated_at
       )
       VALUES (
         'scan.run',
         'running',
         ?,
         0,
         0,
         0,
         ?,
         ?,
         ?,
         ?
       )`
    )
      .bind(
        total,
        JSON.stringify({
          siteIds,
          strategies
        }),
        at,
        at,
        at
      )
      .run();

  const bulkJobId =
    Number(
      created.meta.last_row_id
    );

  if (!bulkJobId) {
    throw new Error(
      "Failed to create bulk scan job"
    );
  }

  for (
    const strategy
    of strategies
  ) {
    for (
      const group
      of chunks(
        siteIds,
        SITE_CHUNK_SIZE
      )
    ) {
      const placeholders =
        group
          .map(() => "?")
          .join(",");

      /*
       * INSERT OR IGNORE makes the active-job
       * unique index our final race-condition guard.
       */
      await env.DB.prepare(
        `INSERT OR IGNORE INTO scan_jobs (
           site_id,
           strategy,
           trigger,
           bulk_job_id,
           status,
           attempt,
           priority,
           scheduled_for,
           created_at,
           updated_at
         )

         SELECT
           s.id,
           ?,
           'bulk',
           ?,
           'pending',
           0,
           100,
           ?,
           ?,
           ?

         FROM sites s

         WHERE s.active != 0
           AND s.id IN (
             ${placeholders}
           )`
      )
        .bind(
          strategy,
          bulkJobId,
          at,
          at,
          at,
          ...group
        )
        .run();
    }
  }

  const jobsResult =
    await env.DB.prepare(
      `SELECT
         id,
         site_id,
         strategy

       FROM scan_jobs

       WHERE bulk_job_id=?
         AND status='pending'

       ORDER BY id`
    )
      .bind(
        bulkJobId
      )
      .all<{
        id: number;
        site_id: number;
        strategy: Strategy;
      }>();

  const jobs =
    jobsResult.results || [];

  const skipped =
    Math.max(
      0,
      total -
      jobs.length
    );

  if (jobs.length === 0) {
    await env.DB.prepare(
      `UPDATE bulk_jobs
          SET
            status='partial',
            skipped_count=?,
            completed_at=?,
            updated_at=?
        WHERE id=?`
    )
      .bind(
        skipped,
        at,
        at,
        bulkJobId
      )
      .run();

    return {
      bulkJobId,
      status: "partial",
      sitesRequested:
        siteIds.length,
      targetsRequested:
        total,
      queued: 0,
      skipped
    };
  }

  await env.DB.prepare(
    `UPDATE bulk_jobs
        SET
          status='queued',
          skipped_count=?,
          updated_at=?
      WHERE id=?`
  )
    .bind(
      skipped,
      at,
      bulkJobId
    )
    .run();

  try {
    for (
      const group
      of chunks(
        jobs,
        BULK_QUEUE_BATCH_SIZE
      )
    ) {
      await env.SCAN_QUEUE.sendBatch(
        group.map(
          (job) => ({
            body: {
              jobId: job.id,
              siteId: job.site_id,
              strategy:
                job.strategy
            }
          })
        )
      );

      const ids =
        group.map(
          (job) => job.id
        );

      const placeholders =
        ids
          .map(() => "?")
          .join(",");

      /*
       * Consumer may already have claimed
       * a pending job, so only transition
       * rows that are still pending.
       */
      await env.DB.prepare(
        `UPDATE scan_jobs
            SET
              status='queued',
              queued_at=?,
              updated_at=?
          WHERE status='pending'
            AND id IN (
              ${placeholders}
            )`
      )
        .bind(
          at,
          at,
          ...ids
        )
        .run();
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * Any messages not confirmed written to
     * Queue remain pending. Convert those
     * orphaned rows to terminal failure.
     */
    await env.DB.prepare(
      `UPDATE scan_jobs
          SET
            status='failed',
            completed_at=?,
            error_class=
              'QUEUE_SEND_FAILED',
            error_message=?,
            updated_at=?
        WHERE bulk_job_id=?
          AND status='pending'`
    )
      .bind(
        at,
        message.slice(
          0,
          900
        ),
        at,
        bulkJobId
      )
      .run();

    await refreshBulkScanJob(
      env.DB,
      bulkJobId,
      at
    );

    throw error;
  }

  return {
    bulkJobId,
    status: "queued",
    sitesRequested:
      siteIds.length,
    targetsRequested:
      total,
    queued:
      jobs.length,
    skipped
  };
}

export interface BulkMonitoringInput {
  siteIds?: unknown;
  strategies?: unknown;
  enabled?: unknown;
}

export interface BulkMonitoringResult {
  bulkJobId: number;
  status:
    | "success"
    | "partial";
  sitesRequested: number;
  targetsRequested: number;
  completed: number;
  skipped: number;
  enabled: boolean;
}

export async function applyBulkMonitoring(
  db: D1Database,
  input: BulkMonitoringInput,
  at = nowIso()
): Promise<BulkMonitoringResult> {
  const siteIds =
    normalizeSiteIds(
      input.siteIds
    );

  const strategies =
    normalizeStrategies(
      input.strategies
    );

  if (
    typeof input.enabled !==
    "boolean"
  ) {
    throw new BulkScheduleInputError(
      "enabled must be true or false"
    );
  }

  const enabled =
    input.enabled;

  const total =
    siteIds.length *
    strategies.length;

  const created =
    await db.prepare(
      `INSERT INTO bulk_jobs (
         action,
         status,
         total_count,
         completed_count,
         failed_count,
         skipped_count,
         parameters_json,
         created_at,
         started_at,
         updated_at
       )
       VALUES (
         ?,
         'running',
         ?,
         0,
         0,
         0,
         ?,
         ?,
         ?,
         ?
       )`
    )
      .bind(
        enabled
          ? "monitoring.enable"
          : "monitoring.disable",
        total,
        JSON.stringify({
          siteIds,
          strategies,
          enabled
        }),
        at,
        at,
        at
      )
      .run();

  const bulkJobId =
    Number(
      created.meta.last_row_id
    );

  if (!bulkJobId) {
    throw new Error(
      "Failed to create bulk monitoring job"
    );
  }

  let completed = 0;

  for (
    const strategy
    of strategies
  ) {
    for (
      const group
      of chunks(
        siteIds,
        SITE_CHUNK_SIZE
      )
    ) {
      const placeholders =
        group
          .map(() => "?")
          .join(",");

      let countQuery: string;

      if (enabled) {
        countQuery =
          `SELECT COUNT(*) AS count
           FROM scan_targets st
           JOIN sites s
             ON s.id=st.site_id
           WHERE
             st.strategy=?
             AND
             st.site_id IN (
               ${placeholders}
             )
             AND
             st.schedule_type !=
               'manual'
             AND
             s.active != 0`;
      } else {
        countQuery =
          `SELECT COUNT(*) AS count
           FROM scan_targets
           WHERE
             strategy=?
             AND
             site_id IN (
               ${placeholders}
             )`;
      }

      const count =
        await db.prepare(
          countQuery
        )
          .bind(
            strategy,
            ...group
          )
          .first<{
            count: number;
          }>();

      completed +=
        Number(
          count?.count || 0
        );

      if (enabled) {
        await db.prepare(
          `UPDATE scan_targets
              SET
                enabled=1,
                next_due_at=
                  COALESCE(
                    next_due_at,
                    ?
                  ),
                updated_at=?

            WHERE
              strategy=?
              AND
              site_id IN (
                ${placeholders}
              )
              AND
              schedule_type !=
                'manual'
              AND
              EXISTS (
                SELECT 1
                FROM sites s
                WHERE
                  s.id=
                    scan_targets.site_id
                  AND
                  s.active != 0
              )`
        )
          .bind(
            at,
            at,
            strategy,
            ...group
          )
          .run();
      } else {
        await db.prepare(
          `UPDATE scan_targets
              SET
                enabled=0,
                next_due_at=NULL,
                updated_at=?

            WHERE
              strategy=?
              AND
              site_id IN (
                ${placeholders}
              )`
        )
          .bind(
            at,
            strategy,
            ...group
          )
          .run();
      }
    }
  }

  const skipped =
    Math.max(
      0,
      total -
      completed
    );

  const status:
    "success" | "partial" =
    skipped === 0
      ? "success"
      : "partial";

  await db.prepare(
    `UPDATE bulk_jobs
        SET
          status=?,
          completed_count=?,
          failed_count=0,
          skipped_count=?,
          completed_at=?,
          updated_at=?
      WHERE id=?`
  )
    .bind(
      status,
      completed,
      skipped,
      at,
      at,
      bulkJobId
    )
    .run();

  return {
    bulkJobId,
    status,
    sitesRequested:
      siteIds.length,
    targetsRequested:
      total,
    completed,
    skipped,
    enabled
  };
}
