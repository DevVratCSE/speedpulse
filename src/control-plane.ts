import type { Env, Strategy } from "./types";
import {
  SCAN_DISPATCH_LEASE_MS,
  SCAN_QUEUE_RETRY_DELAY_SECONDS,
  SCAN_RUN_LEASE_MS
} from "./scan-policy";
import { nowIso } from "./utils";

export type ScanTrigger =
  | "scheduled"
  | "manual"
  | "bulk"
  | "retry";

export type ScanJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface ScanJobRow {
  id: number;
  site_id: number;
  strategy: Strategy;
  trigger: ScanTrigger;
  bulk_job_id: number | null;
  status: ScanJobStatus;
  attempt: number;
  priority: number;
  scheduled_for: string | null;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  test_run_id: number | null;
  error_class: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DueTargetRow {
  target_id: number;
  site_id: number;
  site_name: string;
  url: string;
  origin: string;
  strategy: Strategy;
  interval_hours: number;
  next_due_at: string;
  priority: number;
}

export interface ScanTargetDiagnosticRow {
  target_id: number;
  site_id: number;
  project_name: string;
  site_name: string;
  url: string;
  active: number;
  strategy: Strategy;
  enabled: number;
  interval_hours: number;
  next_due_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  priority: number;
}

export interface RecentScanJobRow extends ScanJobRow {
  site_name: string;
  project_name: string;
}

export type CreateScanJobResult =
  | {
      created: true;
      reason: null;
      job: ScanJobRow;
    }
  | {
      created: false;
      reason: "already_active";
      job: ScanJobRow;
    }
  | {
      created: false;
      reason: "site_not_found" | "site_inactive";
      job: null;
    };

function clampLimit(
  value: number,
  fallback = 50,
  maximum = 100
): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), maximum);
}

function clampPriority(value: number | undefined): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(-1000, Math.min(1000, Math.trunc(value!)));
}

function uniqueConstraint(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  return message.toLowerCase().includes("unique constraint");
}

function parseSystemValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function deterministicJitterMinutes(
  siteId: number,
  strategy: Strategy,
  maximumMinutes = 30
): number {
  const text = `${siteId}:${strategy}`;

  let hash = 2166136261;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const width = maximumMinutes * 2 + 1;

  return (hash >>> 0) % width - maximumMinutes;
}

export function computeNextDueAt(
  completedAt: string,
  intervalHours: number,
  siteId: number,
  strategy: Strategy
): string {
  const parsed = Date.parse(completedAt);
  const base = Number.isFinite(parsed) ? parsed : Date.now();

  const hours = Math.max(1, Math.trunc(intervalHours));
  const jitterMinutes = deterministicJitterMinutes(
    siteId,
    strategy
  );

  return new Date(
    base +
      hours * 60 * 60 * 1000 +
      jitterMinutes * 60 * 1000
  ).toISOString();
}

export async function getActiveJob(
  db: D1Database,
  siteId: number,
  strategy: Strategy
): Promise<ScanJobRow | null> {
  return await db.prepare(
    `SELECT *
       FROM scan_jobs
      WHERE site_id=?
        AND strategy=?
        AND status IN ('pending','queued','running')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`
  )
    .bind(siteId, strategy)
    .first<ScanJobRow>();
}

export async function createScanJob(
  db: D1Database,
  input: {
    siteId: number;
    strategy: Strategy;
    trigger: ScanTrigger;
    bulkJobId?: number | null;
    priority?: number;
    scheduledFor?: string | null;
  }
): Promise<CreateScanJobResult> {
  const site = await db.prepare(
    `SELECT id, active
       FROM sites
      WHERE id=?`
  )
    .bind(input.siteId)
    .first<{ id: number; active: number }>();

  if (!site) {
    return {
      created: false,
      reason: "site_not_found",
      job: null
    };
  }

  if (!site.active) {
    return {
      created: false,
      reason: "site_inactive",
      job: null
    };
  }

  if (
    input.trigger === "bulk" &&
    !input.bulkJobId
  ) {
    throw new Error(
      "bulk scan jobs require bulkJobId"
    );
  }

  const active = await getActiveJob(
    db,
    input.siteId,
    input.strategy
  );

  if (active) {
    return {
      created: false,
      reason: "already_active",
      job: active
    };
  }

  const createdAt = nowIso();
  const priority = clampPriority(input.priority);
  const scheduledFor =
    input.scheduledFor === undefined
      ? createdAt
      : input.scheduledFor;

  try {
    const inserted = await db.prepare(
      `INSERT INTO scan_jobs (
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
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
    )
      .bind(
        input.siteId,
        input.strategy,
        input.trigger,
        input.bulkJobId ?? null,
        priority,
        scheduledFor,
        createdAt,
        createdAt
      )
      .run();

    const jobId = Number(inserted.meta.last_row_id);

    const job = await db.prepare(
      "SELECT * FROM scan_jobs WHERE id=?"
    )
      .bind(jobId)
      .first<ScanJobRow>();

    if (!job) {
      throw new Error(
        "scan job was inserted but could not be read back"
      );
    }

    return {
      created: true,
      reason: null,
      job
    };
  } catch (error) {
    /*
     * The database unique index is the final concurrency guard.
     * If another request won the race between our SELECT and INSERT,
     * return that active job rather than creating duplicate work.
     */
    if (uniqueConstraint(error)) {
      const winner = await getActiveJob(
        db,
        input.siteId,
        input.strategy
      );

      if (winner) {
        return {
          created: false,
          reason: "already_active",
          job: winner
        };
      }
    }

    throw error;
  }
}

export async function listDueTargets(
  db: D1Database,
  limit = 25,
  at = nowIso()
): Promise<DueTargetRow[]> {
  const safeLimit = clampLimit(limit, 25, 100);

  const result = await db.prepare(
    `SELECT
       t.id AS target_id,
       t.site_id,
       s.name AS site_name,
       s.url,
       s.origin,
       t.strategy,
       t.interval_hours,
       t.next_due_at,
       t.priority
     FROM scan_targets t
     JOIN sites s
       ON s.id=t.site_id
     WHERE t.enabled=1
       AND s.active=1
       AND t.next_due_at IS NOT NULL
       AND t.next_due_at <= ?
       AND NOT EXISTS (
         SELECT 1
           FROM scan_jobs j
          WHERE j.site_id=t.site_id
            AND j.strategy=t.strategy
            AND j.status IN ('pending','queued','running')
       )
     ORDER BY
       t.next_due_at ASC,
       t.priority DESC,
       t.id ASC
     LIMIT ?`
  )
    .bind(at, safeLimit)
    .all<DueTargetRow>();

  return result.results || [];
}

export async function countScheduledJobsSince(
  db: D1Database,
  sinceIso: string
): Promise<number> {
  const row =
    await db.prepare(
      `SELECT COUNT(*) AS count
       FROM scan_jobs
       WHERE trigger='scheduled'
         AND created_at >= ?`
    )
      .bind(
        sinceIso
      )
      .first<{
        count: number;
      }>();

  return Number(
    row?.count ||
    0
  );
}


export async function countDueTargets(
  db: D1Database,
  at = nowIso()
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM scan_targets t

       JOIN sites s
         ON s.id=t.site_id

      WHERE t.enabled=1
        AND s.active=1
        AND t.next_due_at IS NOT NULL
        AND t.next_due_at <= ?

        AND NOT EXISTS (
          SELECT 1
            FROM scan_jobs j
           WHERE j.site_id=t.site_id
             AND j.strategy=t.strategy
             AND j.status IN (
               'pending',
               'queued',
               'running'
             )
        )`
  )
    .bind(at)
    .first<{
      count: number;
    }>();

  return Number(
    row?.count || 0
  );
}


export async function scheduleNextSuccess(
  db: D1Database,
  siteId: number,
  strategy: "mobile" | "desktop",
  completedAt = nowIso()
): Promise<string | null> {
  const target = await db.prepare(
    `SELECT
       st.enabled,
       st.interval_hours,
       st.schedule_type,
       st.schedule_config_json,
       st.timezone,
       s.active
     FROM scan_targets st
     JOIN sites s
       ON s.id=st.site_id
     WHERE st.site_id=?
       AND st.strategy=?`
  )
    .bind(
      siteId,
      strategy
    )
    .first<{
      enabled: number;
      interval_hours: number;
      schedule_type: string;
      schedule_config_json: string;
      timezone: string;
      active: number;
    }>();

  if (!target) {
    return null;
  }

  let nextDueAt: string | null = null;

  if (
    target.enabled !== 0 &&
    target.active !== 0
  ) {
    const {
      normalizeSchedule,
      computeNextScheduleAt
    } = await import("./schedule-engine");

    let schedule;

    try {
      schedule = normalizeSchedule({
        type: target.schedule_type,
        timezone: target.timezone,
        config: JSON.parse(
          target.schedule_config_json
        )
      });
    } catch {
      /*
       * Backward-compatible fallback for old rows.
       */
      schedule = normalizeSchedule({
        type: "interval",
        timezone: "UTC",
        config: {
          minutes: Math.max(
            5,
            target.interval_hours * 60
          )
        }
      });
    }

    nextDueAt = computeNextScheduleAt(
      schedule,
      completedAt,
      siteId,
      strategy
    );
  }

  await db.prepare(
    `UPDATE scan_targets
        SET last_success_at=?,
            last_failure_at=NULL,
            next_due_at=?,
            updated_at=?
      WHERE site_id=?
        AND strategy=?`
  )
    .bind(
      completedAt,
      nextDueAt,
      completedAt,
      siteId,
      strategy
    )
    .run();

  return nextDueAt;
}

export async function recordTargetFailure(
  db: D1Database,
  siteId: number,
  strategy: Strategy,
  failedAt = nowIso(),
  retryHours = 6
): Promise<{
  updated: boolean;
  nextDueAt: string | null;
}> {
  const target = await db.prepare(
    `SELECT enabled
       FROM scan_targets
      WHERE site_id=?
        AND strategy=?`
  )
    .bind(siteId, strategy)
    .first<{ enabled: number }>();

  if (!target) {
    return {
      updated: false,
      nextDueAt: null
    };
  }

  const parsed = Date.parse(failedAt);
  const base = Number.isFinite(parsed)
    ? parsed
    : Date.now();

  const safeRetryHours = Math.max(
    1,
    Math.min(72, Math.trunc(retryHours))
  );

  const nextDueAt = target.enabled
    ? new Date(
        base + safeRetryHours * 60 * 60 * 1000
      ).toISOString()
    : null;

  await db.prepare(
    `UPDATE scan_targets
        SET last_failure_at=?,
            next_due_at=?,
            updated_at=?
      WHERE site_id=?
        AND strategy=?`
  )
    .bind(
      failedAt,
      nextDueAt,
      failedAt,
      siteId,
      strategy
    )
    .run();

  return {
    updated: true,
    nextDueAt
  };
}

export async function updateSystemState(
  db: D1Database,
  key: string,
  value: unknown,
  updatedAt = nowIso()
): Promise<void> {
  const safeKey = key.trim().slice(0, 120);

  if (!safeKey) {
    throw new Error("system state key is required");
  }

  const valueJson = JSON.stringify(value ?? null);

  await db.prepare(
    `INSERT INTO system_state (
       key,
       value_json,
       updated_at
     )
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json=excluded.value_json,
       updated_at=excluded.updated_at`
  )
    .bind(
      safeKey,
      valueJson,
      updatedAt
    )
    .run();
}

/**
 * Retrieves the effective Google PageSpeed API key, checking:
 * 1. env.GOOGLE_API_KEY (Cloudflare Worker secret / .dev.vars)
 * 2. D1 system_state table (in-app configuration via Settings UI)
 */
export async function getEffectiveGoogleApiKey(
  env: Env
): Promise<string | undefined> {
  const envKey = (env.GOOGLE_API_KEY || "").trim();
  if (envKey) return envKey;

  try {
    const row = await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key = 'google_api_key' LIMIT 1"
    ).first<{ value_json: string }>();

    if (row?.value_json) {
      const parsed = JSON.parse(row.value_json);
      if (typeof parsed === "string" && parsed.trim().length > 0) {
        return parsed.trim();
      }
    }
  } catch {}

  return undefined;
}

export async function getSystemHealth(
  db: D1Database,
  at = nowIso()
): Promise<{
  at: string;
  counts: {
    enabledTargets: number;
    dueTargets: number;
    activeJobs: number;
    pendingJobs: number;
    queuedJobs: number;
    runningJobs: number;
    failedJobs24h: number;
  };
  state: Record<
    string,
    {
      value: unknown;
      updatedAt: string;
    }
  >;
}> {
  const parsed = Date.parse(at);
  const base = Number.isFinite(parsed)
    ? parsed
    : Date.now();

  const last24Hours = new Date(
    base - 24 * 60 * 60 * 1000
  ).toISOString();

  const [countResult, stateResult] = await db.batch([
    db.prepare(
      `SELECT
        (
          SELECT COUNT(*)
          FROM scan_targets t
          JOIN sites s ON s.id=t.site_id
          WHERE t.enabled=1
            AND s.active=1
        ) AS enabled_targets,

        (
          SELECT COUNT(*)
          FROM scan_targets t
          JOIN sites s ON s.id=t.site_id
          WHERE t.enabled=1
            AND s.active=1
            AND t.next_due_at IS NOT NULL
            AND t.next_due_at <= ?
            AND NOT EXISTS (
              SELECT 1
              FROM scan_jobs j
              WHERE j.site_id=t.site_id
                AND j.strategy=t.strategy
                AND j.status IN (
                  'pending',
                  'queued',
                  'running'
                )
            )
        ) AS due_targets,

        (
          SELECT COUNT(*)
          FROM scan_jobs
          WHERE status IN ('pending','queued','running')
        ) AS active_jobs,

        (
          SELECT COUNT(*)
          FROM scan_jobs
          WHERE status='pending'
        ) AS pending_jobs,

        (
          SELECT COUNT(*)
          FROM scan_jobs
          WHERE status='queued'
        ) AS queued_jobs,

        (
          SELECT COUNT(*)
          FROM scan_jobs
          WHERE status='running'
        ) AS running_jobs,

        (
          SELECT COUNT(*)
          FROM scan_jobs
          WHERE status='failed'
            AND completed_at IS NOT NULL
            AND completed_at >= ?
        ) AS failed_jobs_24h`
    ).bind(at, last24Hours),

    db.prepare(
      `SELECT key, value_json, updated_at
         FROM system_state
        ORDER BY key`
    )
  ]);

  const counts =
    (countResult.results?.[0] || {}) as Record<
      string,
      unknown
    >;

  const state: Record<
    string,
    {
      value: unknown;
      updatedAt: string;
    }
  > = {};

  for (
    const row of
      (stateResult.results || []) as Array<{
        key: string;
        value_json: string;
        updated_at: string;
      }>
  ) {
    state[row.key] = {
      value: parseSystemValue(row.value_json),
      updatedAt: row.updated_at
    };
  }

  return {
    at,
    counts: {
      enabledTargets: Number(
        counts.enabled_targets || 0
      ),
      dueTargets: Number(
        counts.due_targets || 0
      ),
      activeJobs: Number(
        counts.active_jobs || 0
      ),
      pendingJobs: Number(
        counts.pending_jobs || 0
      ),
      queuedJobs: Number(
        counts.queued_jobs || 0
      ),
      runningJobs: Number(
        counts.running_jobs || 0
      ),
      failedJobs24h: Number(
        counts.failed_jobs_24h || 0
      )
    },
    state
  };
}



/*
 * ================================================================
 * CHECKPOINT-19: main Queue workspace
 * ================================================================
 *
 * scan_jobs is the logical operational record.
 *
 * test_runs remains the provider-attempt history and is deliberately
 * not used as the primary Queue table because retries would otherwise
 * look like independent user scans.
 */

export interface QueueWorkspaceJobRow
  extends RecentScanJobRow {
  project_id: number;
  site_url: string;
}


export interface QueueDurationHint {
  averageMs:
    | number
    | null;

  sampleCount: number;
}


export interface QueueWorkspaceData {
  at: string;

  retryDelaySeconds: number;

  counts: {
    activeJobs: number;
    runningJobs: number;
    waitingJobs: number;
    retryingJobs: number;
    failedJobs24h: number;
  };

  activeJobs:
    QueueWorkspaceJobRow[];

  recentJobs:
    QueueWorkspaceJobRow[];

  activeTruncated:
    boolean;

  durationHints: {
    mobile:
      QueueDurationHint;

    desktop:
      QueueDurationHint;
  };
}


export async function getQueueWorkspace(
  db: D1Database,
  recentLimit = 60,
  at = nowIso()
): Promise<QueueWorkspaceData> {
  const safeRecentLimit =
    clampLimit(
      recentLimit,
      60,
      100
    );


  /*
   * Active work should never normally approach this in the current
   * free-tier design, but the hard cap protects Worker/D1 response
   * size if a future bulk action becomes very large.
   */
  const activeLimit =
    200;


  const parsed =
    Date.parse(
      at
    );


  const base =
    Number.isFinite(
      parsed
    )
      ? parsed
      : Date.now();


  const last24Hours =
    new Date(
      base -
      24 *
      60 *
      60 *
      1000
    ).toISOString();


  const [
    countResult,
    activeResult,
    recentResult,
    durationResult
  ] =
    await db.batch([
      /*
       * Exact Queue state counts.
       *
       * Retrying is a logical UI state represented in D1 as:
       *
       *   status='queued'
       *   attempt > 0
       *   error_class='TRANSIENT_SCAN_ERROR'
       *
       * Waiting excludes those delayed transient retries.
       */
      db.prepare(
        `SELECT

          (
            SELECT COUNT(*)
            FROM scan_jobs

            WHERE status IN (
              'pending',
              'queued',
              'running'
            )
          )
            AS active_jobs,

          (
            SELECT COUNT(*)
            FROM scan_jobs
            WHERE status='running'
          )
            AS running_jobs,

          (
            SELECT COUNT(*)
            FROM scan_jobs

            WHERE
              status='pending'

              OR (
                status='queued'

                AND NOT (
                  attempt > 0

                  AND
                  COALESCE(
                    error_class,
                    ''
                  )='TRANSIENT_SCAN_ERROR'
                )
              )
          )
            AS waiting_jobs,

          (
            SELECT COUNT(*)
            FROM scan_jobs

            WHERE
              status='queued'

              AND
              attempt > 0

              AND
              COALESCE(
                error_class,
                ''
              )='TRANSIENT_SCAN_ERROR'
          )
            AS retrying_jobs,

          (
            SELECT COUNT(*)
            FROM scan_jobs

            WHERE
              status='failed'

              AND
              completed_at IS NOT NULL

              AND
              completed_at >= ?
          )
            AS failed_jobs_24h`
      )
        .bind(
          last24Hours
        ),


      /*
       * Current operational work.
       *
       * Running first, then delayed retries, then first-attempt
       * waiting jobs.
       */
      db.prepare(
        `SELECT
           j.*,

           s.project_id
             AS project_id,

           s.name
             AS site_name,

           s.url
             AS site_url,

           p.name
             AS project_name

         FROM scan_jobs j

         JOIN sites s
           ON s.id=j.site_id

         JOIN projects p
           ON p.id=s.project_id

         WHERE
           j.status IN (
             'pending',
             'queued',
             'running'
           )

         ORDER BY

           CASE

             WHEN
               j.status='running'
               THEN 0

             WHEN
               j.status='queued'
               AND
               j.attempt > 0
               AND
               COALESCE(
                 j.error_class,
                 ''
               )='TRANSIENT_SCAN_ERROR'
               THEN 1

             WHEN
               j.status='queued'
               THEN 2

             ELSE 3

           END,

           j.priority DESC,
           j.created_at ASC,
           j.id ASC

         LIMIT ?`
      )
        .bind(
          activeLimit
        ),


      /*
       * Recently completed logical scans.
       */
      db.prepare(
        `SELECT
           j.*,

           s.project_id
             AS project_id,

           s.name
             AS site_name,

           s.url
             AS site_url,

           p.name
             AS project_name

         FROM scan_jobs j

         JOIN sites s
           ON s.id=j.site_id

         JOIN projects p
           ON p.id=s.project_id

         WHERE
           j.status IN (
             'success',
             'failed',
             'cancelled'
           )

         ORDER BY
           COALESCE(
             j.completed_at,
             j.updated_at
           ) DESC,
           j.id DESC

         LIMIT ?`
      )
        .bind(
          safeRecentLimit
        ),


      /*
       * Lightweight ETA hint.
       *
       * We intentionally estimate provider processing duration from
       * successful logical jobs using started_at -> completed_at.
       *
       * Retry waiting time is NOT included here. Retrying jobs show
       * their own explicit retry countdown instead.
       *
       * Extremely short or stale/outlier runs are excluded.
       */
      db.prepare(
        `SELECT
           strategy,

           COUNT(*)
             AS sample_count,

           CAST(
             ROUND(
               AVG(
                 duration_ms
               )
             )
             AS INTEGER
           )
             AS average_ms

         FROM (
           SELECT
             strategy,

             (
               julianday(
                 completed_at
               )
               -
               julianday(
                 started_at
               )
             )
             *
             86400000
               AS duration_ms

           FROM scan_jobs

           WHERE
             status='success'

             AND
             started_at IS NOT NULL

             AND
             completed_at IS NOT NULL

             AND
             (
               (
                 julianday(
                   completed_at
                 )
                 -
                 julianday(
                   started_at
                 )
               )
               *
               86400000
             )
             BETWEEN 1000 AND 300000

           ORDER BY
             completed_at DESC

           LIMIT 80
         )

         GROUP BY
           strategy`
      )
    ]);


  const rawCounts =
    (
      countResult
        .results?.[0] ||
      {}
    ) as Record<
      string,
      unknown
    >;


  const activeJobs =
    (
      activeResult.results ||
      []
    ) as unknown as
      QueueWorkspaceJobRow[];


  const recentJobs =
    (
      recentResult.results ||
      []
    ) as unknown as
      QueueWorkspaceJobRow[];


  const durationHints: {
    mobile:
      QueueDurationHint;

    desktop:
      QueueDurationHint;
  } = {
    mobile: {
      averageMs:
        null,

      sampleCount:
        0
    },

    desktop: {
      averageMs:
        null,

      sampleCount:
        0
    }
  };


  for (
    const row of
      (
        durationResult.results ||
        []
      ) as Array<{
        strategy:
          Strategy;

        sample_count:
          number;

        average_ms:
          number | null;
      }>
  ) {
    if (
      row.strategy !==
        "mobile" &&
      row.strategy !==
        "desktop"
    ) {
      continue;
    }


    const average =
      Number(
        row.average_ms
      );


    durationHints[
      row.strategy
    ] = {
      averageMs:
        Number.isFinite(
          average
        ) &&
        average > 0
          ? Math.round(
              average
            )
          : null,

      sampleCount:
        Number(
          row.sample_count ||
          0
        )
    };
  }


  const activeJobsCount =
    Number(
      rawCounts
        .active_jobs ||
      0
    );


  return {
    at,

    retryDelaySeconds:
      SCAN_QUEUE_RETRY_DELAY_SECONDS,

    counts: {
      activeJobs:
        activeJobsCount,

      runningJobs:
        Number(
          rawCounts
            .running_jobs ||
          0
        ),

      waitingJobs:
        Number(
          rawCounts
            .waiting_jobs ||
          0
        ),

      retryingJobs:
        Number(
          rawCounts
            .retrying_jobs ||
          0
        ),

      failedJobs24h:
        Number(
          rawCounts
            .failed_jobs_24h ||
          0
        )
    },

    activeJobs,

    recentJobs,

    activeTruncated:
      activeJobsCount >
      activeJobs.length,

    durationHints
  };
}


/*
 * ================================================================
 * CHECKPOINT-20: site recent logical scans
 * ================================================================
 *
 * IMPORTANT DATA MODEL BOUNDARY
 *
 * scan_jobs = one logical SpeedPulse scan
 * test_runs = individual provider attempts
 *
 * A logical scan may produce multiple failed test_runs before a
 * later retry succeeds. The normal site UI must therefore read
 * scan_jobs here, never test_runs, otherwise one click can appear
 * as three separate scans.
 */

export interface SiteRecentLogicalScanRow
  extends ScanJobRow {
  detailed_report_id:
    | number
    | null;

  detailed_report_captured_at:
    | string
    | null;

  detailed_report_size_bytes:
    | number
    | null;

  detailed_report_level:
    | string
    | null;
}


export async function listRecentSiteScanJobs(
  db: D1Database,
  siteId: number,
  strategy: Strategy,
  limit = 2
): Promise<
  SiteRecentLogicalScanRow[]
> {
  /*
   * Checkpoint-20 intentionally caps this API at two logical jobs.
   *
   * The long-running metrics/history table remains untouched.
   */
  const safeLimit =
    Math.max(
      1,
      Math.min(
        2,
        Math.trunc(
          limit ||
          2
        )
      )
    );


  const result =
    await db.prepare(
      `SELECT
         j.*,

         (
           SELECT
             dr.id

           FROM detailed_reports dr

           WHERE
             dr.test_run_id=
               j.test_run_id

             AND
             dr.site_id=
               j.site_id

             AND
             dr.strategy=
               j.strategy

             AND
             dr.state='ready'

           ORDER BY
             dr.id DESC

           LIMIT 1
         )
           AS detailed_report_id,

         (
           SELECT
             dr.captured_at

           FROM detailed_reports dr

           WHERE
             dr.test_run_id=
               j.test_run_id

             AND
             dr.site_id=
               j.site_id

             AND
             dr.strategy=
               j.strategy

             AND
             dr.state='ready'

           ORDER BY
             dr.id DESC

           LIMIT 1
         )
           AS detailed_report_captured_at,

         (
           SELECT
             dr.size_bytes

           FROM detailed_reports dr

           WHERE
             dr.test_run_id=
               j.test_run_id

             AND
             dr.site_id=
               j.site_id

             AND
             dr.strategy=
               j.strategy

             AND
             dr.state='ready'

           ORDER BY
             dr.id DESC

           LIMIT 1
         )
           AS detailed_report_size_bytes,

         (
           SELECT
             dr.detail_level

           FROM detailed_reports dr

           WHERE
             dr.test_run_id=
               j.test_run_id

             AND
             dr.site_id=
               j.site_id

             AND
             dr.strategy=
               j.strategy

             AND
             dr.state='ready'

           ORDER BY
             dr.id DESC

           LIMIT 1
         )
           AS detailed_report_level

       FROM scan_jobs j

       WHERE
         j.site_id=?

         AND
         j.strategy=?

       ORDER BY
         j.created_at DESC,
         j.id DESC

       LIMIT ?`
    )
      .bind(
        siteId,
        strategy,
        safeLimit
      )
      .all<
        SiteRecentLogicalScanRow
      >();


  return (
    result.results ||
    []
  );
}

export async function listScanTargets(
  db: D1Database,
  limit = 100
): Promise<ScanTargetDiagnosticRow[]> {
  const safeLimit = clampLimit(limit, 100, 200);

  const result = await db.prepare(
    `SELECT
       t.id AS target_id,
       t.site_id,
       p.name AS project_name,
       s.name AS site_name,
       s.url,
       s.active,
       t.strategy,
       t.enabled,
       t.interval_hours,
       t.next_due_at,
       t.last_success_at,
       t.last_failure_at,
       t.priority
     FROM scan_targets t
     JOIN sites s
       ON s.id=t.site_id
     JOIN projects p
       ON p.id=s.project_id
     ORDER BY
       p.name COLLATE NOCASE,
       s.name COLLATE NOCASE,
       t.strategy
     LIMIT ?`
  )
    .bind(safeLimit)
    .all<ScanTargetDiagnosticRow>();

  return result.results || [];
}

export async function listRecentScanJobs(
  db: D1Database,
  limit = 50
): Promise<RecentScanJobRow[]> {
  const safeLimit = clampLimit(limit, 50, 200);

  const result = await db.prepare(
    `SELECT
       j.*,
       s.name AS site_name,
       p.name AS project_name
     FROM scan_jobs j
     JOIN sites s
       ON s.id=j.site_id
     JOIN projects p
       ON p.id=s.project_id
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT ?`
  )
    .bind(safeLimit)
    .all<RecentScanJobRow>();

  return result.results || [];
}

export async function getScanJobById(
  db: D1Database,
  jobId: number
): Promise<ScanJobRow | null> {
  return await db.prepare(
    "SELECT * FROM scan_jobs WHERE id=?"
  )
    .bind(jobId)
    .first<ScanJobRow>();
}

export async function markScanJobQueued(
  db: D1Database,
  jobId: number,
  queuedAt = nowIso()
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE scan_jobs
        SET status='queued',
            queued_at=COALESCE(queued_at, ?),
            updated_at=?
      WHERE id=?
        AND status='pending'`
  )
    .bind(
      queuedAt,
      queuedAt,
      jobId
    )
    .run();

  return Number(result.meta.changes || 0) > 0;
}

export async function claimScanJob(
  db: D1Database,
  jobId: number,
  startedAt = nowIso()
): Promise<{
  claimed: boolean;
  job: ScanJobRow | null;
}> {
  const parsed = Date.parse(startedAt);
  const nowMs = Number.isFinite(parsed) ? parsed : Date.now();
  const dispatchCutoff = new Date(nowMs - SCAN_DISPATCH_LEASE_MS).toISOString();

  const result = await db.prepare(
    `UPDATE scan_jobs
        SET status='running',
            attempt=attempt+1,
            started_at=?,
            updated_at=?,
            error_class=NULL,
            error_message=NULL
      WHERE id=?
        AND (
          (status='pending' AND created_at >= ?)
          OR
          (status='queued' AND COALESCE(queued_at, created_at) >= ?)
        )`
  )
    .bind(
      startedAt,
      startedAt,
      jobId,
      dispatchCutoff,
      dispatchCutoff
    )
    .run();

  const job = await getScanJobById(
    db,
    jobId
  );

  return {
    claimed: Number(result.meta.changes || 0) > 0,
    job
  };
}

export interface StaleSweepSummary {
  swept: number;
  runningExpired: number;
  queuedExpired: number;
  pendingExpired: number;
  jobIds: number[];
}

/**
 * Sweeper that reclaims stale, crashed, or abandoned jobs.
 *
 * Runs at the start of every cron tick:
 * - 'running' jobs with started_at older than SCAN_RUN_LEASE_MS (5 min)
 * - 'queued' jobs with queued_at/created_at older than SCAN_DISPATCH_LEASE_MS (15 min)
 * - 'pending' jobs with created_at older than SCAN_DISPATCH_LEASE_MS (15 min)
 *
 * Marks them as failed with error_class = 'lease_expired' and completed_at = now,
 * unblocking their targets for subsequent scheduler cycles and surfacing them in
 * failedJobs24h and the Queue UI.
 */
export async function sweepStaleJobs(
  db: D1Database,
  nowIsoString = nowIso()
): Promise<StaleSweepSummary> {
  const parsed = Date.parse(nowIsoString);
  const nowMs = Number.isFinite(parsed) ? parsed : Date.now();
  const runCutoff = new Date(nowMs - SCAN_RUN_LEASE_MS).toISOString();
  const dispatchCutoff = new Date(nowMs - SCAN_DISPATCH_LEASE_MS).toISOString();

  // Find candidate stale jobs
  const candidateResult = await db.prepare(
    `SELECT id, site_id, strategy, status, test_run_id, started_at, queued_at, created_at
       FROM scan_jobs
      WHERE (
        status = 'running' AND COALESCE(started_at, created_at) < ?
      ) OR (
        status = 'queued' AND COALESCE(queued_at, created_at) < ?
      ) OR (
        status = 'pending' AND created_at < ?
      )
      ORDER BY id ASC`
  )
    .bind(runCutoff, dispatchCutoff, dispatchCutoff)
    .all<{
      id: number;
      site_id: number;
      strategy: Strategy;
      status: "running" | "queued" | "pending";
      test_run_id: number | null;
      started_at: string | null;
      queued_at: string | null;
      created_at: string;
    }>();

  const candidates = candidateResult.results || [];
  if (candidates.length === 0) {
    return {
      swept: 0,
      runningExpired: 0,
      queuedExpired: 0,
      pendingExpired: 0,
      jobIds: []
    };
  }

  const runningExpired = candidates.filter((c) => c.status === "running").length;
  const queuedExpired = candidates.filter((c) => c.status === "queued").length;
  const pendingExpired = candidates.filter((c) => c.status === "pending").length;
  const jobIds = candidates.map((c) => c.id);

  // Transition all stale jobs to failed
  await db.prepare(
    `UPDATE scan_jobs
        SET status = 'failed',
            error_class = 'lease_expired',
            error_message = CASE
              WHEN status = 'running' THEN 'Job execution lease expired'
              WHEN status = 'queued' THEN 'Job queue dispatch lease expired'
              ELSE 'Job pending dispatch lease expired'
            END,
            completed_at = ?,
            updated_at = ?
      WHERE (
        status = 'running' AND COALESCE(started_at, created_at) < ?
      ) OR (
        status = 'queued' AND COALESCE(queued_at, created_at) < ?
      ) OR (
        status = 'pending' AND created_at < ?
      )`
  )
    .bind(
      nowIsoString,
      nowIsoString,
      runCutoff,
      dispatchCutoff,
      dispatchCutoff
    )
    .run();

  // Fail any linked test_runs that were left in 'running'
  const linkedTestRunIds = candidates
    .map((c) => c.test_run_id)
    .filter((id): id is number => typeof id === "number" && id > 0);

  if (linkedTestRunIds.length > 0) {
    for (const testRunId of linkedTestRunIds) {
      await db.prepare(
        `UPDATE test_runs
            SET status = 'failed',
                completed_at = ?,
                error_message = COALESCE(error_message, 'Job lease expired')
          WHERE id = ?
            AND status = 'running'`
      )
        .bind(nowIsoString, testRunId)
        .run();
    }
  }

  console.warn(
    "scan_jobs.stale_lease_recovered",
    JSON.stringify({
      swept: candidates.length,
      runningExpired,
      queuedExpired,
      pendingExpired,
      jobIds
    })
  );

  await updateSystemState(
    db,
    "queue.scan.last_stale_sweep",
    {
      swept: candidates.length,
      runningExpired,
      queuedExpired,
      pendingExpired,
      jobIds
    },
    nowIsoString
  );

  return {
    swept: candidates.length,
    runningExpired,
    queuedExpired,
    pendingExpired,
    jobIds
  };
}

export async function completeScanJobSuccess(
  db: D1Database,
  jobId: number,
  testRunId: number,
  completedAt = nowIso()
): Promise<void> {
  await db.prepare(
    `UPDATE scan_jobs
        SET status='success',
            test_run_id=?,
            completed_at=?,
            error_class=NULL,
            error_message=NULL,
            updated_at=?
      WHERE id=?`
  )
    .bind(
      testRunId,
      completedAt,
      completedAt,
      jobId
    )
    .run();
}

export async function completeScanJobFailure(
  db: D1Database,
  jobId: number,
  errorClass: string,
  errorMessage: string,
  completedAt = nowIso()
): Promise<void> {
  await db.prepare(
    `UPDATE scan_jobs
        SET status='failed',
            completed_at=?,
            error_class=?,
            error_message=?,
            updated_at=?
      WHERE id=?`
  )
    .bind(
      completedAt,
      errorClass.slice(0, 80),
      errorMessage.slice(0, 900),
      completedAt,
      jobId
    )
    .run();
}

/*
 * CHECKPOINT-18: terminal logical scan failure.
 *
 * The Queue owns the final failure state for Queue-backed scans.
 *
 * This function commits:
 *
 *   1. scan_jobs -> failed
 *   2. sites.<strategy>_last_status -> failed
 *   3. sites.<strategy>_last_error -> provider diagnostic
 *   4. sites.<strategy>_last_run_at -> terminal completion time
 *
 * in one D1 batch.
 *
 * Individual provider-attempt failures are intentionally handled
 * earlier by runSiteTest() and remain preserved in test_runs.
 */
export async function completeScanJobFailureAndSite(
  db: D1Database,
  job: Pick<
    ScanJobRow,
    "id" |
    "site_id" |
    "strategy"
  >,
  errorClass: string,
  errorMessage: string,
  completedAt = nowIso(),
  nextDueAt?:
    | string
    | null
): Promise<void> {
  const statusColumn =
    job.strategy ===
    "mobile"
      ? "mobile_last_status"
      : "desktop_last_status";


  const errorColumn =
    job.strategy ===
    "mobile"
      ? "mobile_last_error"
      : "desktop_last_error";


  const lastColumn =
    job.strategy ===
    "mobile"
      ? "mobile_last_run_at"
      : "desktop_last_run_at";


  const nextColumn =
    job.strategy ===
    "mobile"
      ? "mobile_next_check_at"
      : "desktop_next_check_at";


  const safeErrorClass =
    errorClass.slice(
      0,
      80
    );


  const safeErrorMessage =
    errorMessage.slice(
      0,
      900
    );


  const siteStatement =
    nextDueAt ===
    undefined
      ? db.prepare(
          `UPDATE sites
              SET ${statusColumn}='failed',
                  ${errorColumn}=?,
                  ${lastColumn}=?,
                  updated_at=?
            WHERE id=?`
        )
          .bind(
            safeErrorMessage,
            completedAt,
            completedAt,
            job.site_id
          )
      : db.prepare(
          `UPDATE sites
              SET ${statusColumn}='failed',
                  ${errorColumn}=?,
                  ${lastColumn}=?,
                  ${nextColumn}=?,
                  updated_at=?
            WHERE id=?`
        )
          .bind(
            safeErrorMessage,
            completedAt,
            nextDueAt,
            completedAt,
            job.site_id
          );


  await db.batch([
    db.prepare(
      `UPDATE scan_jobs
          SET status='failed',
              completed_at=?,
              error_class=?,
              error_message=?,
              updated_at=?
        WHERE id=?
          AND status='running'`
    )
      .bind(
        completedAt,
        safeErrorClass,
        safeErrorMessage,
        completedAt,
        job.id
      ),

    siteStatement
  ]);
}



export async function requeueScanJob(
  db: D1Database,
  jobId: number,
  errorClass: string,
  errorMessage: string,
  queuedAt = nowIso()
): Promise<void> {
  await db.prepare(
    `UPDATE scan_jobs
        SET status='queued',
            started_at=NULL,
            queued_at=?,
            error_class=?,
            error_message=?,
            updated_at=?
      WHERE id=?
        AND status='running'`
  )
    .bind(
      queuedAt,
      errorClass.slice(0, 80),
      errorMessage.slice(0, 900),
      queuedAt,
      jobId
    )
    .run();
}

export interface ScanTargetScheduleRow {
  site_id: number;
  strategy: "mobile" | "desktop";
  active: number;
  enabled: number;
  schedule_type:
    | "manual"
    | "interval"
    | "daily"
    | "weekly";
  schedule_config_json: string;
  timezone: string;
  next_due_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
}

export async function getScanTargetSchedule(
  db: D1Database,
  siteId: number,
  strategy: "mobile" | "desktop"
): Promise<ScanTargetScheduleRow | null> {
  return await db.prepare(
    `SELECT
       st.site_id,
       st.strategy,
       s.active,
       st.enabled,
       st.schedule_type,
       st.schedule_config_json,
       st.timezone,
       st.next_due_at,
       st.last_success_at,
       st.last_failure_at
     FROM scan_targets st
     JOIN sites s
       ON s.id=st.site_id
     WHERE st.site_id=?
       AND st.strategy=?`
  )
    .bind(
      siteId,
      strategy
    )
    .first<ScanTargetScheduleRow>();
}

export async function updateScanTargetSchedule(
  db: D1Database,
  siteId: number,
  strategy: "mobile" | "desktop",
  input: unknown,
  at = nowIso()
): Promise<ScanTargetScheduleRow> {
  const {
    normalizeSchedule,
    computeNextScheduleAt,
    scheduleIntervalHours
  } = await import(
    "./schedule-engine"
  );

  const schedule =
    normalizeSchedule(input);

  const existing =
    await getScanTargetSchedule(
      db,
      siteId,
      strategy
    );

  if (!existing) {
    throw new Error(
      "Scan target not found"
    );
  }

  const enabled =
    schedule.type !== "manual" &&
    existing.active !== 0
      ? 1
      : 0;

  const nextDueAt =
    enabled
      ? computeNextScheduleAt(
          schedule,
          at,
          siteId,
          strategy
        )
      : null;

  const intervalHours =
    scheduleIntervalHours(
      schedule
    );

  await db.prepare(
    `UPDATE scan_targets
        SET schedule_type=?,
            schedule_config_json=?,
            timezone=?,
            enabled=?,
            interval_hours=?,
            next_due_at=?,
            updated_at=?
      WHERE site_id=?
        AND strategy=?`
  )
    .bind(
      schedule.type,
      JSON.stringify(
        schedule.config
      ),
      schedule.timezone,
      enabled,
      intervalHours,
      nextDueAt,
      at,
      siteId,
      strategy
    )
    .run();

  const updated =
    await getScanTargetSchedule(
      db,
      siteId,
      strategy
    );

  if (!updated) {
    throw new Error(
      "Updated scan target disappeared"
    );
  }

  return updated;
}

export async function refreshBulkScanJob(
  db: D1Database,
  bulkJobId: number,
  at = nowIso()
): Promise<void> {
  await db.prepare(
    `WITH counts AS (
       SELECT
         SUM(
           CASE
             WHEN status='success'
               THEN 1
             ELSE 0
           END
         ) AS successes,

         SUM(
           CASE
             WHEN status IN (
               'failed',
               'cancelled'
             )
               THEN 1
             ELSE 0
           END
         ) AS failures

       FROM scan_jobs
       WHERE bulk_job_id=?
     )

     UPDATE bulk_jobs
        SET
          completed_count=
            COALESCE(
              (
                SELECT successes
                FROM counts
              ),
              0
            ),

          failed_count=
            COALESCE(
              (
                SELECT failures
                FROM counts
              ),
              0
            ),

          status=
            CASE
              WHEN
                COALESCE(
                  (
                    SELECT successes
                    FROM counts
                  ),
                  0
                )
                +
                COALESCE(
                  (
                    SELECT failures
                    FROM counts
                  ),
                  0
                )
                +
                skipped_count
                >= total_count
              THEN
                CASE
                  WHEN
                    COALESCE(
                      (
                        SELECT successes
                        FROM counts
                      ),
                      0
                    ) = 0
                    AND
                    COALESCE(
                      (
                        SELECT failures
                        FROM counts
                      ),
                      0
                    ) > 0
                  THEN 'failed'

                  WHEN
                    COALESCE(
                      (
                        SELECT failures
                        FROM counts
                      ),
                      0
                    ) > 0
                    OR skipped_count > 0
                  THEN 'partial'

                  ELSE 'success'
                END

              ELSE 'running'
            END,

          completed_at=
            CASE
              WHEN
                COALESCE(
                  (
                    SELECT successes
                    FROM counts
                  ),
                  0
                )
                +
                COALESCE(
                  (
                    SELECT failures
                    FROM counts
                  ),
                  0
                )
                +
                skipped_count
                >= total_count
              THEN COALESCE(
                completed_at,
                ?
              )

              ELSE NULL
            END,

          updated_at=?

      WHERE id=?`
  )
    .bind(
      bulkJobId,
      at,
      at,
      bulkJobId
    )
    .run();
}
