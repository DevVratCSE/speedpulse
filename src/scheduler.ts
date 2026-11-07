import type {
  Env
} from "./types";

import {
  countDueTargets,
  countScheduledJobsSince,
  listDueTargets,
  sweepStaleJobs,
  updateSystemState
} from "./control-plane";

import {
  enqueueScanJob
} from "./queue";

import {
  nowIso,
  parsePositiveInt
} from "./utils";

import {
  evaluateQuotaStatus,
  getEffectiveBatchSize
} from "./quota";


export type NextSchedulerMode =
  | "shadow"
  | "dispatch";


export interface NextSchedulerSummary {
  ok: boolean;
  mode: NextSchedulerMode;
  at: string;

  batchSize: number;
  effectiveBatchSize?: number;
  quotaStatus?: "normal" | "slowdown" | "paused" | "blocked";
  quotaWarning?: string;

  dueCount: number;

  dailyBudget: number;
  scheduledToday: number;
  budgetRemaining: number;

  candidates: number;

  preview: Array<{
    targetId: number;
    siteId: number;
    siteName: string;

    strategy:
      | "mobile"
      | "desktop";

    nextDueAt: string;
    priority: number;
  }>;

  dispatch?: {
    created: number;
    alreadyActive: number;
    failed: number;
  };
}


export function getNextSchedulerMode(
  env: Env
): NextSchedulerMode {
  return (
    env.NEXT_SCHEDULER_MODE ===
    "dispatch"
  )
    ? "dispatch"
    : "shadow";
}


export function getNextSchedulerBatchSize(
  env: Env
): number {
  return parsePositiveInt(
    env.NEXT_SCHEDULER_BATCH_SIZE,
    25,
    100
  );
}


export function getNextSchedulerDailyBudget(
  env: Env
): number {
  /*
   * Queue Free includes 10,000 operations/day.
   *
   * A normal small Queue message consumes approximately one write,
   * one read and one delete operation. A 600 scheduled-message
   * ceiling leaves substantial room for retries and deliberate
   * manual/bulk work.
   */
  return parsePositiveInt(
    env.NEXT_SCHEDULER_DAILY_BUDGET,
    600,
    1000
  );
}


function utcDayStart(
  at: string
): string {
  const parsed =
    Date.parse(
      at
    );

  const date =
    Number.isFinite(
      parsed
    )
      ? new Date(parsed)
      : new Date();


  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0
    )
  ).toISOString();
}


function previewRows(
  due:
    Awaited<
      ReturnType<
        typeof listDueTargets
      >
    >
):
  NextSchedulerSummary[
    "preview"
  ] {
  return due
    .slice(
      0,
      10
    )
    .map(
      (target) => ({
        targetId:
          target.target_id,

        siteId:
          target.site_id,

        siteName:
          target.site_name,

        strategy:
          target.strategy,

        nextDueAt:
          target.next_due_at,

        priority:
          target.priority
      })
    );
}


export async function previewNextScheduler(
  env: Env,
  at = nowIso()
): Promise<
  NextSchedulerSummary
> {
  const mode =
    getNextSchedulerMode(
      env
    );

  const batchSize =
    getNextSchedulerBatchSize(
      env
    );

  const dailyBudget =
    getNextSchedulerDailyBudget(
      env
    );


  const [
    dueCount,
    scheduledToday
  ] =
    await Promise.all([
      countDueTargets(
        env.DB,
        at
      ),

      countScheduledJobsSince(
        env.DB,
        utcDayStart(
          at
        )
      )
    ]);


  const budgetRemaining =
    Math.max(
      0,
      dailyBudget -
      scheduledToday
    );


  const candidateLimit =
    Math.min(
      batchSize,
      budgetRemaining
    );


  const due =
    candidateLimit > 0
      ? await listDueTargets(
          env.DB,
          candidateLimit,
          at
        )
      : [];


  return {
    ok: true,
    mode,
    at,

    batchSize,

    dueCount,

    dailyBudget,
    scheduledToday,
    budgetRemaining,

    candidates:
      due.length,

    preview:
      previewRows(
        due
      )
  };
}


export async function runNextSchedulerTick(
  env: Env,
  at = nowIso()
): Promise<
  NextSchedulerSummary
> {
  await sweepStaleJobs(env.DB, at);

  const mode =
    getNextSchedulerMode(
      env
    );

  const batchSize =
    getNextSchedulerBatchSize(
      env
    );

  const dailyBudget =
    getNextSchedulerDailyBudget(
      env
    );


  const [
    dueCount,
    scheduledToday
  ] =
    await Promise.all([
      countDueTargets(
        env.DB,
        at
      ),

      countScheduledJobsSince(
        env.DB,
        utcDayStart(
          at
        )
      )
    ]);


  const budgetRemaining =
    Math.max(
      0,
      dailyBudget -
      scheduledToday
    );

  const quotaEval =
    await evaluateQuotaStatus(
      env.DB,
      at
    );

  const effectiveBatchSize =
    getEffectiveBatchSize(
      batchSize,
      quotaEval
    );

  const candidateLimit =
    Math.min(
      effectiveBatchSize,
      budgetRemaining
    );


  const due =
    candidateLimit > 0
      ? await listDueTargets(
          env.DB,
          candidateLimit,
          at
        )
      : [];


  const summary:
    NextSchedulerSummary = {
      ok: true,
      mode,
      at,

      batchSize,
      effectiveBatchSize,
      quotaStatus:
        quotaEval.status,
      quotaWarning:
        quotaEval.warningMessage,

      dueCount,

      dailyBudget,
      scheduledToday,
      budgetRemaining,

      candidates:
        due.length,

      preview:
        previewRows(
          due
        )
    };


  if (
    mode ===
    "shadow"
  ) {
    await updateSystemState(
      env.DB,
      "scheduler.next.last_tick",
      {
        ok: true,
        mode:
          "shadow",

        dueCount,
        batchSize,

        dailyBudget,
        scheduledToday,
        budgetRemaining,

        candidates:
          due.length
      },
      at
    );


    console.log(
      "scheduler.next.shadow",
      JSON.stringify(
        summary
      )
    );


    return summary;
  }


  if (
    env.QUEUE_SCANS_ENABLED !==
    "1"
  ) {
    throw new Error(
      "Next scheduler dispatch requires QUEUE_SCANS_ENABLED=1"
    );
  }


  let created = 0;
  let alreadyActive = 0;
  let failed = 0;


  for (
    const target of
    due
  ) {
    try {
      const result =
        await enqueueScanJob(
          env,
          {
            siteId:
              target.site_id,

            strategy:
              target.strategy,

            trigger:
              "scheduled",

            priority:
              target.priority,

            scheduledFor:
              target.next_due_at
          }
        );


      if (
        result.created
      ) {
        created++;
      } else if (
        result.reason ===
        "already_active"
      ) {
        alreadyActive++;
      }
    } catch (error) {
      failed++;


      console.error(
        "scheduler.next.dispatch_failed",
        JSON.stringify({
          siteId:
            target.site_id,

          strategy:
            target.strategy,

          error:
            error instanceof Error
              ? error.message
              : String(error)
        })
      );
    }
  }


  summary.ok =
    failed === 0;


  summary.dispatch = {
    created,
    alreadyActive,
    failed
  };


  await updateSystemState(
    env.DB,
    "scheduler.next.last_tick",
    {
      ok:
        failed === 0,

      mode:
        "dispatch",

      dueCount,
      batchSize,

      dailyBudget,
      scheduledToday,
      budgetRemaining,

      candidates:
        due.length,

      created,
      alreadyActive,
      failed
    },
    at
  );


  console.log(
    "scheduler.next.dispatch",
    JSON.stringify(
      summary
    )
  );


  return summary;
}
