import type {
  CruxFetchResult,
  CruxResult,
  Env,
  Frequency,
  RunSource,
  SiteRow,
  Strategy
} from "./types";

import {
  fetchCrux,
  fetchPageSpeed
} from "./pagespeed";

import {
  storeDetailedReport,
  type DetailedReportMetadataRow,
  type DetailedReportStoreStatus
} from "./detailed-reports";

import {
  SCAN_RUN_LEASE_MS
} from "./scan-policy";

import {
  recordQuotaUsage
} from "./quota";

import {
  rollupSiteDayMetrics
} from "./rollups";

import {
  getEffectiveGoogleApiKey
} from "./control-plane";

import {
  addHours,
  nextSchedule,
  nowIso
} from "./utils";


function strategyColumns(
  strategy: Strategy
) {
  return strategy ===
    "mobile"
      ? {
          frequency:
            "mobile_frequency",

          next:
            "mobile_next_check_at",

          status:
            "mobile_last_status",

          error:
            "mobile_last_error",

          last:
            "mobile_last_run_at"
        }
      : {
          frequency:
            "desktop_frequency",

          next:
            "desktop_next_check_at",

          status:
            "desktop_last_status",

          error:
            "desktop_last_error",

          last:
            "desktop_last_run_at"
        };
}


async function siteById(
  db: D1Database,
  siteId: number
): Promise<
  SiteRow | null
> {
  return await db.prepare(
    "SELECT * FROM sites WHERE id = ?"
  )
    .bind(
      siteId
    )
    .first<
      SiteRow
    >();
}


function emptyCrux():
  CruxResult {
  return {
    available:
      false,

    source:
      null,

    lcpMs:
      null,

    inpMs:
      null,

    cls:
      null,

    periodStart:
      null,

    periodEnd:
      null
  };
}


function cruxFailure(
  error: unknown
): CruxFetchResult {
  const message =
    error instanceof Error
      ? error.message
      : String(
          error
        );


  console.warn(
    "CrUX collection failed:",
    message
  );


  return {
    summary:
      emptyCrux(),

    providerStatus:
      "provider_error",

    httpStatus:
      null,

    error:
      message.slice(
        0,
        900
      )
  };
}


export async function runSiteTest(
  env: Env,
  siteId: number,
  strategy: Strategy,
  source: RunSource,
  scanJobId?: number
) {
  const apiKey =
    await getEffectiveGoogleApiKey(
      env
    );

  if (
    !apiKey
  ) {
    throw new Error(
      "GOOGLE_API_KEY is not configured"
    );
  }


  const site =
    await siteById(
      env.DB,
      siteId
    );


  if (!site) {
    throw new Error(
      "Site not found"
    );
  }


  const startedAt =
    nowIso();


  const staleBefore =
    new Date(
      Date.now() -
      SCAN_RUN_LEASE_MS
    ).toISOString();


  await env.DB.prepare(
    `UPDATE test_runs
        SET status='failed',
            completed_at=?,
            error_message=
              COALESCE(
                error_message,
                'Recovered stale running test'
              )
      WHERE site_id=?
        AND strategy=?
        AND status='running'
        AND started_at < ?`
  )
    .bind(
      startedAt,
      site.id,
      strategy,
      staleBefore
    )
    .run();


  let runId: number;


  try {
    const runInsert =
      await env.DB.prepare(
        `INSERT INTO test_runs (
           site_id,
           strategy,
           source,
           status,
           started_at
         )
         VALUES (
           ?,
           ?,
           ?,
           'running',
           ?
         )`
      )
        .bind(
          site.id,
          strategy,
          source,
          startedAt
        )
        .run();


    runId =
      Number(
        runInsert
          .meta
          .last_row_id
      );
  } catch (error) {
    const running =
      await env.DB.prepare(
        `SELECT
           id,
           started_at

         FROM test_runs

         WHERE site_id=?
           AND strategy=?
           AND status='running'

         LIMIT 1`
      )
        .bind(
          site.id,
          strategy
        )
        .first<{
          id: number;
          started_at: string;
        }>();


    if (running) {
      throw new Error(
        `${strategy} test already running for this site (run ${running.id})`
      );
    }


    throw error;
  }


  /*
   * Link Queue job -> test_run before provider work.
   *
   * If metrics commit succeeds and Queue finalization later fails,
   * redelivery can finish the same job without another PSI request.
   */
  if (
    scanJobId
  ) {
    try {
      const linked =
        await env.DB.prepare(
          `UPDATE scan_jobs
              SET test_run_id=?,
                  updated_at=?

            WHERE id=?
              AND status='running'`
        )
          .bind(
            runId,
            startedAt,
            scanJobId
          )
          .run();


      if (
        Number(
          linked
            .meta
            .changes ||
          0
        ) === 0
      ) {
        throw new Error(
          "Scan job lost its execution lease before the test started"
        );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(
              error
            );


      await env.DB.prepare(
        `UPDATE test_runs
            SET status='failed',
                completed_at=?,
                error_message=?
          WHERE id=?`
      )
        .bind(
          nowIso(),
          message.slice(
            0,
            900
          ),
          runId
        )
        .run();


      throw error;
    }
  }


  const columns =
    strategyColumns(
      strategy
    );


  try {
    const [
      psiFetch,
      cruxFetch
    ] =
      await Promise.all([
        fetchPageSpeed(
          site.url,
          strategy,
          apiKey
        ),

        fetchCrux(
          site.origin,
          strategy,
          apiKey
        )
          .catch(
            cruxFailure
          )
      ]);


    await recordQuotaUsage(env.DB, "pagespeed_api", 1);
    if (cruxFetch.providerStatus === "available" || cruxFetch.providerStatus === "no_record") {
      await recordQuotaUsage(env.DB, "crux_api", 1);
    }
    await recordQuotaUsage(env.DB, "d1_writes", 7);

    const psi =
      psiFetch.summary;


    const crux =
      cruxFetch.summary;


    const completedAt =
      nowIso();


    const frequency =
      site[
        columns.frequency as
          keyof SiteRow
      ] as Frequency;


    const next =
      source ===
      "scheduled"
        ? nextSchedule(
            frequency,
            new Date()
          )
        : site[
            columns.next as
              keyof SiteRow
          ] as
            | string
            | null;


    const metricValues = [
      runId,
      site.id,
      strategy,
      psi.analysisTime,

      psi.performance,
      psi.accessibility,
      psi.seo,
      psi.bestPractices,

      psi.fcpMs,
      psi.lcpMs,
      psi.tbtMs,
      psi.cls,
      psi.speedIndexMs,

      crux.lcpMs,
      crux.inpMs,
      crux.cls,
      crux.source,
      crux.periodStart,
      crux.periodEnd
    ];


    const latestValues = [
      site.id,
      strategy,
      runId,
      psi.analysisTime,

      psi.performance,
      psi.accessibility,
      psi.seo,
      psi.bestPractices,

      psi.fcpMs,
      psi.lcpMs,
      psi.tbtMs,
      psi.cls,
      psi.speedIndexMs,

      crux.lcpMs,
      crux.inpMs,
      crux.cls,
      crux.source,
      crux.periodStart,
      crux.periodEnd
    ];


    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO metrics (
           test_run_id,
           site_id,
           strategy,
           recorded_at,

           performance_score,
           accessibility_score,
           seo_score,
           best_practices_score,

           fcp_ms,
           lcp_ms,
           tbt_ms,
           cls,
           speed_index_ms,

           field_lcp_ms,
           field_inp_ms,
           field_cls,
           field_data_source,
           field_period_start,
           field_period_end
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
           ?,
           ?,
           ?,
           ?,

           ?,
           ?,
           ?,
           ?,
           ?,
           ?
         )`
      )
        .bind(
          ...metricValues
        ),


      env.DB.prepare(
        `INSERT INTO site_latest (
           site_id,
           strategy,
           test_run_id,
           recorded_at,

           performance_score,
           accessibility_score,
           seo_score,
           best_practices_score,

           fcp_ms,
           lcp_ms,
           tbt_ms,
           cls,
           speed_index_ms,

           field_lcp_ms,
           field_inp_ms,
           field_cls,
           field_data_source,
           field_period_start,
           field_period_end
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
           ?,
           ?,
           ?,
           ?,

           ?,
           ?,
           ?,
           ?,
           ?,
           ?
         )

         ON CONFLICT(
           site_id,
           strategy
         )
         DO UPDATE SET

           test_run_id=
             excluded.test_run_id,

           recorded_at=
             excluded.recorded_at,

           performance_score=
             excluded.performance_score,

           accessibility_score=
             excluded.accessibility_score,

           seo_score=
             excluded.seo_score,

           best_practices_score=
             excluded.best_practices_score,

           fcp_ms=
             excluded.fcp_ms,

           lcp_ms=
             excluded.lcp_ms,

           tbt_ms=
             excluded.tbt_ms,

           cls=
             excluded.cls,

           speed_index_ms=
             excluded.speed_index_ms,

           field_lcp_ms=
             excluded.field_lcp_ms,

           field_inp_ms=
             excluded.field_inp_ms,

           field_cls=
             excluded.field_cls,

           field_data_source=
             excluded.field_data_source,

           field_period_start=
             excluded.field_period_start,

           field_period_end=
             excluded.field_period_end

         WHERE
           excluded.recorded_at >=
           site_latest.recorded_at`
      )
        .bind(
          ...latestValues
        ),


      env.DB.prepare(
        `UPDATE test_runs
            SET status='success',
                completed_at=?,
                psi_fetch_time=?,
                lighthouse_version=?,
                crux_status=?,
                crux_error=?
          WHERE id=?`
      )
        .bind(
          completedAt,
          psi.fetchTime,
          psi.lighthouseVersion,
          cruxFetch.providerStatus,
          cruxFetch.error,
          runId
        ),


      env.DB.prepare(
        `UPDATE sites
            SET ${columns.status}='success',
                ${columns.error}=NULL,
                ${columns.last}=?,
                ${columns.next}=?,
                updated_at=?
          WHERE id=?`
      )
        .bind(
          completedAt,
          next,
          completedAt,
          site.id
        )
    ]);

    try {
      await rollupSiteDayMetrics(
        env.DB,
        site.id,
        strategy,
        completedAt.slice(0, 10)
      );
    } catch (rollupError) {
      console.warn("rollup.update_failed", rollupError);
    }


    let detailedReport:
      DetailedReportMetadataRow |
      null =
        null;


    let detailedReportStatus:
      DetailedReportStoreStatus =
        "disabled";


    let detailedReportError:
      | string
      | null =
        null;


    try {
      const stored =
        await storeDetailedReport(
          env,
          {
            siteId:
              site.id,

            strategy,

            testRunId:
              runId,

            capturedAt:
              psi.analysisTime,

            finalUrl:
              psi.finalUrl,

            lighthouseVersion:
              psi.lighthouseVersion,

            payloadJson:
              psiFetch
                .detailedReportJson,

            sizeBytes:
              psiFetch
                .detailedReportBytes,

            detailLevel:
              psiFetch
                .detailedReportLevel
          }
        );


      detailedReport =
        stored.report;


      detailedReportStatus =
        stored.status;


      if (
        stored.reason &&
        ![
          "stored",
          "existing",
          "disabled"
        ].includes(
          stored.status
        )
      ) {
        detailedReportError =
          stored.reason;
      }
    } catch (error) {
      detailedReportStatus =
        "disabled";


      detailedReportError =
        (
          error instanceof Error
            ? error.message
            : String(
                error
              )
        ).slice(
          0,
          900
        );


      /*
       * Normalized PSI/CrUX data is already committed.
       *
       * Never turn a KV/storage failure into another Google API
       * request.
       */
      console.error(
        "detailed_report.store_failed",
        JSON.stringify({
          siteId:
            site.id,

          strategy,

          runId,

          error:
            detailedReportError
        })
      );
    }


    return {
      runId,

      completedAt,

      siteId:
        site.id,

      strategy,

      status:
        "success" as const,

      metrics: {
        ...psi,
        crux
      },

      cruxStatus:
        cruxFetch
          .providerStatus,

      cruxError:
        cruxFetch
          .error,

      detailedReport,

      detailedReportStatus,

      detailedReportError
    };
  } catch (error) {
    const message =
      (
        error instanceof Error
          ? error.message
          : String(
              error
            )
      ).slice(
        0,
        900
      );


    const completedAt =
      nowIso();


    const retryAt =
      source ===
      "scheduled"
        ? addHours(
            new Date(),
            6
          )
        : site[
            columns.next as
              keyof SiteRow
          ] as
            | string
            | null;


    /*
     * CHECKPOINT-18: Queue-owned failure boundary.
     *
     * test_runs records provider ATTEMPTS.
     * scan_jobs records the LOGICAL scan requested by SpeedPulse.
     *
     * A failed provider attempt must always remain in test_runs.
     *
     * When scanJobId is present, however, queue.ts decides whether
     * that failed attempt is:
     *
     *   - transient and retryable, or
     *   - the terminal logical failure.
     *
     * Therefore runSiteTest() MUST NOT set the site-level status to
     * failed for Queue-owned scans. Otherwise refreshing the site
     * during an automatic retry incorrectly exposes a terminal
     * failure even though the Queue is still working.
     *
     * Legacy/direct executions without scanJobId retain the previous
     * behaviour for compatibility.
     */
    const failureStatements = [
      env.DB.prepare(
        `UPDATE test_runs
            SET status='failed',
                completed_at=?,
                error_message=?
          WHERE id=?`
      )
        .bind(
          completedAt,
          message,
          runId
        )
    ];


    if (!scanJobId) {
      failureStatements.push(
        env.DB.prepare(
          `UPDATE sites
              SET ${columns.status}='failed',
                  ${columns.error}=?,
                  ${columns.last}=?,
                  ${columns.next}=?,
                  updated_at=?
            WHERE id=?`
        )
          .bind(
            message,
            completedAt,
            retryAt,
            completedAt,
            site.id
          )
      );
    }


    await env.DB.batch(
      failureStatements
    );


    throw new Error(
      message
    );
  }
}



