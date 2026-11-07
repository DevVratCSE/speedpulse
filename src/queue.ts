import type {
  Env,
  RunSource,
  Strategy
} from "./types";

import {
  runSiteTest
} from "./db";

import {
  claimScanJob,
  completeScanJobFailure,
  completeScanJobFailureAndSite,
  completeScanJobSuccess,
  createScanJob,
  getScanJobById,
  markScanJobQueued,
  recordTargetFailure,
  refreshBulkScanJob,
  requeueScanJob,
  scheduleNextSuccess,
  updateSystemState,
  type ScanJobRow
} from "./control-plane";

import {
  SCAN_QUEUE_RETRY_DELAY_SECONDS
} from "./scan-policy";
import { recordQuotaUsage } from "./quota";


import {
  nowIso
} from "./utils";


export interface ScanQueueMessage {
  jobId: number;
  siteId: number;
  strategy: Strategy;
}


export async function enqueueScanJob(
  env: Env,
  input: {
    siteId: number;
    strategy: Strategy;

    trigger:
      | "scheduled"
      | "manual"
      | "bulk"
      | "retry";

    bulkJobId?:
      | number
      | null;

    priority?: number;

    scheduledFor?:
      | string
      | null;
  }
) {
  if (
    env.QUEUE_SCANS_ENABLED !==
    "1"
  ) {
    throw new Error(
      "Queue scanning is disabled"
    );
  }


  const created =
    await createScanJob(
      env.DB,
      input
    );


  if (!created.created) {
    return created;
  }


  const message:
    ScanQueueMessage = {
      jobId:
        created.job.id,

      siteId:
        created.job.site_id,

      strategy:
        created.job.strategy
    };


  try {
    await env.SCAN_QUEUE.send(
      message
    );
    await recordQuotaUsage(
      env.DB,
      "queue_writes",
      1
    );
  } catch (error) {
    const messageText =
      error instanceof Error
        ? error.message
        : String(
            error
          );


    await completeScanJobFailure(
      env.DB,
      created.job.id,
      "QUEUE_SEND_FAILED",
      messageText
    );


    throw error;
  }


  await markScanJobQueued(
    env.DB,
    created.job.id
  );


  const refreshed =
    await getScanJobById(
      env.DB,
      created.job.id
    );


  return {
    created:
      true as const,

    reason:
      null,

    job:
      refreshed ||
      created.job
  };
}


function isTransientScanError(
  message: string
): boolean {
  const value =
    message.toLowerCase();


  return (
    /pagespeed api (429|500|502|503|504)/i
      .test(
        message
      ) ||

    value.includes(
      "timeout"
    ) ||

    value.includes(
      "timed out"
    ) ||

    value.includes(
      "aborted"
    ) ||

    value.includes(
      "aborterror"
    ) ||

    value.includes(
      "network"
    ) ||

    value.includes(
      "fetch failed"
    ) ||

    value.includes(
      "connection reset"
    ) ||

    value.includes(
      "test already running"
    )
  );
}


async function linkedSuccessfulRun(
  env: Env,
  job: ScanJobRow
): Promise<{
  id: number;
  completed_at: string;
} | null> {
  if (
    !job.test_run_id
  ) {
    return null;
  }


  return await env.DB.prepare(
    `SELECT
       id,
       completed_at

     FROM test_runs

     WHERE id=?
       AND site_id=?
       AND strategy=?
       AND status='success'
       AND completed_at IS NOT NULL

     LIMIT 1`
  )
    .bind(
      job.test_run_id,
      job.site_id,
      job.strategy
    )
    .first<{
      id: number;
      completed_at: string;
    }>();
}


async function recordSuccessState(
  env: Env,
  job: ScanJobRow,
  runId: number,
  completedAt: string,
  details: {
    recovered?: boolean;

    reportId?:
      | number
      | null;

    reportStatus?:
      | string
      | null;

    reportError?:
      | string
      | null;
  } = {}
): Promise<void> {
  try {
    await updateSystemState(
      env.DB,
      "queue.scan.last_success",
      {
        jobId:
          job.id,

        siteId:
          job.site_id,

        strategy:
          job.strategy,

        runId,

        recovered:
          Boolean(
            details.recovered
          ),

        reportId:
          details.reportId ||
          null,

        reportStatus:
          details.reportStatus ||
          null,

        reportError:
          details.reportError ||
          null
      },
      completedAt
    );
  } catch (error) {
    console.error(
      "queue.scan.success_state_failed",
      error
    );
  }
}


async function refreshBulkSafely(
  env: Env,
  job: ScanJobRow,
  completedAt: string
): Promise<void> {
  if (
    !job.bulk_job_id
  ) {
    return;
  }


  try {
    await refreshBulkScanJob(
      env.DB,
      job.bulk_job_id,
      completedAt
    );
  } catch (error) {
    console.error(
      "bulk.scan.progress_failed",
      error
    );
  }
}


async function finalizeSuccessfulJob(
  env: Env,
  job: ScanJobRow,
  runId: number,
  completedAt: string,
  details: {
    recovered?: boolean;

    reportId?:
      | number
      | null;

    reportStatus?:
      | string
      | null;

    reportError?:
      | string
      | null;
  } = {}
): Promise<void> {
  if (
    job.trigger ===
    "scheduled"
  ) {
    await scheduleNextSuccess(
      env.DB,
      job.site_id,
      job.strategy,
      completedAt
    );
  }


  await completeScanJobSuccess(
    env.DB,
    job.id,
    runId,
    completedAt
  );


  await recordSuccessState(
    env,
    job,
    runId,
    completedAt,
    details
  );


  await refreshBulkSafely(
    env,
    job,
    completedAt
  );


  console.log(
    "scan.queue.completed",
    JSON.stringify({
      jobId:
        job.id,

      siteId:
        job.site_id,

      strategy:
        job.strategy,

      runId,

      recovered:
        Boolean(
          details.recovered
        ),

      reportId:
        details.reportId ||
        null,

      reportStatus:
        details.reportStatus ||
        null
    })
  );
}


async function handleScanFailure(
  env: Env,
  job: ScanJobRow,
  error: unknown
): Promise<
  "ack" | "retry"
> {
  const completedAt =
    nowIso();


  const errorMessage =
    error instanceof Error
      ? error.message
      : String(
          error
        );


  const transient =
    isTransientScanError(
      errorMessage
    );


  if (
    transient &&
    job.attempt < 3
  ) {
    await requeueScanJob(
      env.DB,
      job.id,
      "TRANSIENT_SCAN_ERROR",
      errorMessage,
      completedAt
    );


    await updateSystemState(
      env.DB,
      "queue.scan.last_retry",
      {
        jobId:
          job.id,

        siteId:
          job.site_id,

        strategy:
          job.strategy,

        attempt:
          job.attempt,

        error:
          errorMessage.slice(
            0,
            300
          )
      },
      completedAt
    );


    console.warn(
      "scan.queue.retry",
      JSON.stringify({
        jobId:
          job.id,

        siteId:
          job.site_id,

        strategy:
          job.strategy,

        attempt:
          job.attempt,

        error:
          errorMessage
      })
    );


    return "retry";
  }


  /*
   * CHECKPOINT-18:
   *
   * We are now past the retry decision.
   *
   * Reaching this block means this logical scan is TERMINAL:
   *
   *   - a transient provider error exhausted all attempts, or
   *   - a non-transient error cannot be retried safely.
   *
   * Only now may the site itself become visibly failed.
   */
  let nextDueAt:
    | string
    | null
    | undefined =
      undefined;


  if (
    job.trigger ===
    "scheduled"
  ) {
    const targetFailure =
      await recordTargetFailure(
        env.DB,
        job.site_id,
        job.strategy,
        completedAt,
        6
      );


    nextDueAt =
      targetFailure
        .nextDueAt;
  }


  await completeScanJobFailureAndSite(
    env.DB,
    job,

    transient
      ? "TRANSIENT_SCAN_EXHAUSTED"
      : "SCAN_FAILED",

    errorMessage,
    completedAt,
    nextDueAt
  );


  await updateSystemState(
    env.DB,
    "queue.scan.last_failure",
    {
      jobId:
        job.id,

      siteId:
        job.site_id,

      strategy:
        job.strategy,

      attempt:
        job.attempt,

      transient,

      error:
        errorMessage.slice(
          0,
          300
        )
    },
    completedAt
  );


  console.error(
    "scan.queue.failed",
    JSON.stringify({
      jobId:
        job.id,

      siteId:
        job.site_id,

      strategy:
        job.strategy,

      attempt:
        job.attempt,

      transient,

      error:
        errorMessage
    })
  );


  return "ack";
}


async function processOne(
  env: Env,
  body: ScanQueueMessage
): Promise<
  "ack" | "retry"
> {
  if (
    !body ||
    !Number.isInteger(
      body.jobId
    ) ||
    !Number.isInteger(
      body.siteId
    ) ||
    ![
      "mobile",
      "desktop"
    ].includes(
      body.strategy
    )
  ) {
    console.error(
      "scan.queue.invalid_message",
      JSON.stringify(
        body
      )
    );


    return "ack";
  }


  const existing =
    await getScanJobById(
      env.DB,
      body.jobId
    );


  if (!existing) {
    console.error(
      "scan.queue.job_missing",
      JSON.stringify(
        body
      )
    );


    return "ack";
  }


  if (
    existing.site_id !==
      body.siteId ||
    existing.strategy !==
      body.strategy
  ) {
    console.error(
      "scan.queue.job_mismatch",
      JSON.stringify({
        body,

        job: {
          id:
            existing.id,

          siteId:
            existing.site_id,

          strategy:
            existing.strategy
        }
      })
    );


    return "ack";
  }


  if (
    [
      "success",
      "failed",
      "cancelled"
    ].includes(
      existing.status
    )
  ) {
    return "ack";
  }


  /*
   * Provider-free recovery path.
   */
  const existingSuccess =
    await linkedSuccessfulRun(
      env,
      existing
    );


  if (
    existingSuccess
  ) {
    try {
      await finalizeSuccessfulJob(
        env,
        existing,
        existingSuccess.id,
        existingSuccess.completed_at,
        {
          recovered:
            true,

          reportStatus:
            "recovered"
        }
      );


      return "ack";
    } catch (error) {
      console.error(
        "scan.queue.finalization_retry",
        error
      );


      return "retry";
    }
  }


  const startedAt =
    nowIso();


  const claim =
    await claimScanJob(
      env.DB,
      body.jobId,
      startedAt
    );


  if (!claim.claimed) {
    if (
      claim.job?.status ===
      "running"
    ) {
      return "retry";
    }


    return "ack";
  }


  const job =
    claim.job;


  if (!job) {
    return "retry";
  }


  const reclaimedSuccess =
    await linkedSuccessfulRun(
      env,
      job
    );


  if (
    reclaimedSuccess
  ) {
    try {
      await finalizeSuccessfulJob(
        env,
        job,
        reclaimedSuccess.id,
        reclaimedSuccess.completed_at,
        {
          recovered:
            true,

          reportStatus:
            "recovered"
        }
      );


      return "ack";
    } catch (error) {
      console.error(
        "scan.queue.recovered_finalization_retry",
        error
      );


      return "retry";
    }
  }


  const source:
    RunSource =
      job.trigger ===
      "scheduled"
        ? "scheduled"
        : "manual";


  console.log(
    "scan.queue.started",
    JSON.stringify({
      jobId:
        job.id,

      siteId:
        job.site_id,

      strategy:
        job.strategy,

      trigger:
        job.trigger,

      attempt:
        job.attempt
    })
  );


  let result:
    Awaited<
      ReturnType<
        typeof runSiteTest
      >
    >;


  try {
    result =
      await runSiteTest(
        env,
        job.site_id,
        job.strategy,
        source,
        job.id
      );
  } catch (error) {
    return await handleScanFailure(
      env,
      job,
      error
    );
  }


  /*
   * From here onward provider work has succeeded.
   *
   * Any D1 finalization retry reuses the linked successful run and
   * never requests PageSpeed again.
   */
  try {
    await finalizeSuccessfulJob(
      env,
      job,
      result.runId,
      result.completedAt,
      {
        reportId:
          result
            .detailedReport
            ?.id ||
          null,

        reportStatus:
          result
            .detailedReportStatus,

        reportError:
          result
            .detailedReportError
      }
    );


    return "ack";
  } catch (error) {
    console.error(
      "scan.queue.finalization_failed",
      JSON.stringify({
        jobId:
          job.id,

        runId:
          result.runId,

        error:
          error instanceof Error
            ? error.message
            : String(
                error
              )
      })
    );


    return "retry";
  }
}


export async function processScanQueueBatch(
  batch:
    MessageBatch<
      ScanQueueMessage
    >,

  env: Env
): Promise<void> {
  if (
    env.QUEUE_SCANS_ENABLED !==
    "1"
  ) {
    console.warn(
      "scan.queue.disabled",
      JSON.stringify({
        queue:
          batch.queue,

        messages:
          batch.messages.length
      })
    );


    batch.retryAll({
      delaySeconds:
        300
    });


    return;
  }


  for (
    const message of
    batch.messages
  ) {
    try {
      const action =
        await processOne(
          env,
          message.body
        );


      if (
        action ===
        "retry"
      ) {
        message.retry({
          delaySeconds:
            SCAN_QUEUE_RETRY_DELAY_SECONDS
        });
      } else {
        message.ack();
      }
    } catch (error) {
      console.error(
        "scan.queue.internal_failure",
        error
      );


      message.retry({
        delaySeconds:
            SCAN_QUEUE_RETRY_DELAY_SECONDS
      });
    }
  }
}
