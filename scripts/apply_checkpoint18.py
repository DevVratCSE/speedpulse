#!/usr/bin/env python3

from pathlib import Path
from datetime import datetime
import json
import shutil
import sys


ROOT = Path.cwd()

REQUIRED = [
    "package.json",
    "src/db.ts",
    "src/control-plane.ts",
    "src/queue.ts",
    "src/index.ts",
    "public/app.js",
    "public/styles.css",
]

for rel in REQUIRED:
    if not (ROOT / rel).exists():
        print(f"ERROR: missing required file: {rel}")
        print("Run this script from the speedpulse-next project root.")
        sys.exit(1)


STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")

BACKUP_ROOT = (
    ROOT
    / "backups"
    / f"checkpoint18_{STAMP}"
)

BACKUP_ROOT.mkdir(
    parents=True,
    exist_ok=True
)


FILES_TO_BACKUP = [
    "package.json",
    "src/db.ts",
    "src/control-plane.ts",
    "src/queue.ts",
    "src/index.ts",
    "public/app.js",
    "public/styles.css",
]


for rel in FILES_TO_BACKUP:
    src = ROOT / rel
    dst = BACKUP_ROOT / rel

    dst.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    shutil.copy2(
        src,
        dst
    )


print(
    f"Backup created: {BACKUP_ROOT}"
)


def read(rel):
    return (
        ROOT / rel
    ).read_text(
        encoding="utf-8"
    )


def write(rel, value):
    (
        ROOT / rel
    ).write_text(
        value,
        encoding="utf-8"
    )


def replace_once(
    rel,
    old,
    new,
    label,
    already_marker=None,
):
    text = read(rel)

    if (
        already_marker
        and already_marker in text
    ):
        print(
            f"SKIP: {label} already present"
        )

        return

    count = text.count(
        old
    )

    if count != 1:
        print()
        print(
            f"ERROR applying: {label}"
        )

        print(
            f"Expected exactly one source match; found {count}."
        )

        print(
            f"File: {rel}"
        )

        print()
        print(
            "No automatic guess was made."
        )

        print(
            f"Restore copies are available under: {BACKUP_ROOT}"
        )

        sys.exit(1)

    text = text.replace(
        old,
        new,
        1
    )

    write(
        rel,
        text
    )

    print(
        f"OK: {label}"
    )


def insert_before_once(
    rel,
    anchor,
    content,
    label,
    already_marker=None,
):
    text = read(rel)

    if (
        already_marker
        and already_marker in text
    ):
        print(
            f"SKIP: {label} already present"
        )

        return

    count = text.count(
        anchor
    )

    if count != 1:
        print()
        print(
            f"ERROR applying: {label}"
        )

        print(
            f"Expected exactly one anchor; found {count}."
        )

        print(
            f"File: {rel}"
        )

        sys.exit(1)

    text = text.replace(
        anchor,
        content + anchor,
        1
    )

    write(
        rel,
        text
    )

    print(
        f"OK: {label}"
    )


# ================================================================
# 1. src/db.ts
#
# Preserve individual failed test_runs but do NOT mark the site
# failed while Queue owns the logical scan.
# ================================================================

DB_OLD = r'''    await env.DB.batch([
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
        ),


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
    ]);'''


DB_NEW = r'''    /*
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
    );'''


replace_once(
    "src/db.ts",
    DB_OLD,
    DB_NEW,
    "separate provider-attempt failure from Queue logical failure",
    "CHECKPOINT-18: Queue-owned failure boundary",
)


# ================================================================
# 2. src/control-plane.ts
#
# Terminal Queue failure + site failure are committed together.
# ================================================================

CONTROL_ANCHOR = r'''

export async function requeueScanJob(
'''


CONTROL_INSERT = r'''

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

'''


insert_before_once(
    "src/control-plane.ts",
    CONTROL_ANCHOR,
    CONTROL_INSERT,
    "add atomic terminal Queue/site failure finalizer",
    "CHECKPOINT-18: terminal logical scan failure",
)


# ================================================================
# 3. src/queue.ts
#
# Import terminal logical failure helper.
# ================================================================

QUEUE_IMPORT_OLD = r'''  completeScanJobFailure,
  completeScanJobSuccess,
'''


QUEUE_IMPORT_NEW = r'''  completeScanJobFailure,
  completeScanJobFailureAndSite,
  completeScanJobSuccess,
'''


replace_once(
    "src/queue.ts",
    QUEUE_IMPORT_OLD,
    QUEUE_IMPORT_NEW,
    "import completeScanJobFailureAndSite",
    "completeScanJobFailureAndSite,",
)


# ================================================================
# Replace only the terminal-failure part.
#
# Retryable attempts continue to call requeueScanJob() and DO NOT
# touch sites.*_last_status.
# ================================================================

QUEUE_FAILURE_OLD = r'''  await completeScanJobFailure(
    env.DB,
    job.id,

    transient
      ? "TRANSIENT_SCAN_EXHAUSTED"
      : "SCAN_FAILED",

    errorMessage,
    completedAt
  );


  if (
    job.trigger ===
    "scheduled"
  ) {
    await recordTargetFailure(
      env.DB,
      job.site_id,
      job.strategy,
      completedAt,
      6
    );
  }
'''


QUEUE_FAILURE_NEW = r'''  /*
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
'''


replace_once(
    "src/queue.ts",
    QUEUE_FAILURE_OLD,
    QUEUE_FAILURE_NEW,
    "move site failure promotion to terminal Queue failure",
    "We are now past the retry decision.",
)


# ================================================================
# 4. src/index.ts
#
# Return active mobile/desktop logical jobs with site details.
#
# This lets refresh correctly show:
#
#   queued
#   running
#   retrying
#
# instead of displaying an old terminal-looking site status.
# ================================================================

INDEX_IMPORT_OLD = r'''import {
  getScanJobById,
'''


INDEX_IMPORT_NEW = r'''import {
  getActiveJob,
  getScanJobById,
'''


replace_once(
    "src/index.ts",
    INDEX_IMPORT_OLD,
    INDEX_IMPORT_NEW,
    "import getActiveJob into main API",
    "  getActiveJob,\n  getScanJobById,",
)


INDEX_SITE_OLD = r'''async function siteDetail(env: Env, siteId: number): Promise<Response> {
  const [site, latest, annotations] = await Promise.all([
    env.DB.prepare(`SELECT s.*, p.name AS project_name FROM sites s JOIN projects p ON p.id=s.project_id WHERE s.id=?`).bind(siteId).first(),
    env.DB.prepare("SELECT * FROM site_latest WHERE site_id=? ORDER BY strategy").bind(siteId).all(),
    env.DB.prepare("SELECT * FROM annotations WHERE site_id=? ORDER BY created_at DESC LIMIT 50").bind(siteId).all()
  ]);
  if (!site) return apiError("Site not found", 404);
  return json({ site, latest: latest.results || [], annotations: annotations.results || [] });
}'''


INDEX_SITE_NEW = r'''async function siteDetail(
  env: Env,
  siteId: number
): Promise<Response> {
  /*
   * CHECKPOINT-18:
   *
   * Expose the active logical Queue job for both strategies.
   *
   * This makes a page refresh authoritative: the browser can tell
   * whether the current site is queued, running or retrying instead
   * of interpreting sites.*_last_status in isolation.
   */
  const [
    site,
    latest,
    annotations,
    mobileActiveJob,
    desktopActiveJob
  ] =
    await Promise.all([
      env.DB.prepare(
        `SELECT
           s.*,
           p.name AS project_name
         FROM sites s
         JOIN projects p
           ON p.id=s.project_id
         WHERE s.id=?`
      )
        .bind(
          siteId
        )
        .first(),

      env.DB.prepare(
        `SELECT *
           FROM site_latest
          WHERE site_id=?
          ORDER BY strategy`
      )
        .bind(
          siteId
        )
        .all(),

      env.DB.prepare(
        `SELECT *
           FROM annotations
          WHERE site_id=?
          ORDER BY created_at DESC
          LIMIT 50`
      )
        .bind(
          siteId
        )
        .all(),

      getActiveJob(
        env.DB,
        siteId,
        "mobile"
      ),

      getActiveJob(
        env.DB,
        siteId,
        "desktop"
      )
    ]);


  if (!site) {
    return apiError(
      "Site not found",
      404
    );
  }


  return json({
    site,

    latest:
      latest.results ||
      [],

    annotations:
      annotations.results ||
      [],

    activeJobs: {
      mobile:
        mobileActiveJob,

      desktop:
        desktopActiveJob
    }
  });
}'''


replace_once(
    "src/index.ts",
    INDEX_SITE_OLD,
    INDEX_SITE_NEW,
    "expose active Queue jobs in normal site API",
    "Expose the active logical Queue job for both strategies",
)


# ================================================================
# 5. public/app.js
#
# Add:
#
#   - current Queue-state interpretation
#   - friendly provider errors
#   - expandable technical details
# ================================================================

APP_STATUS_OLD = r'''function statusBadge(label, cls = "neutral") {
  return `<span class="status ${cls}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

function scoreValue(value) {'''


APP_STATUS_NEW = r'''function statusBadge(label, cls = "neutral") {
  return `<span class="status ${cls}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}


/*
 * ================================================================
 * CHECKPOINT-18: logical scan state + friendly provider errors
 * ================================================================
 */

function activeScanState(job) {
  if (!job) {
    return null;
  }


  if (
    job.status ===
      "queued" &&
    Number(
      job.attempt ||
      0
    ) > 0 &&
    job.error_class ===
      "TRANSIENT_SCAN_ERROR"
  ) {
    return "retrying";
  }


  return job.status;
}


function friendlyScanError(
  errorClass,
  rawMessage
) {
  const raw =
    String(
      rawMessage ||
      ""
    ).trim();


  const lower =
    raw.toLowerCase();


  if (
    !raw
  ) {
    return {
      title:
        "The scan could not be completed.",

      detail:
        "SpeedPulse recorded the failure but no additional provider message was available."
    };
  }


  if (
    errorClass ===
      "TRANSIENT_SCAN_ERROR" ||
    errorClass ===
      "TRANSIENT_SCAN_EXHAUSTED" ||
    /pagespeed api (500|502|503|504)/i.test(
      raw
    ) ||
    lower.includes(
      "lighthouse returned error"
    )
  ) {
    return {
      title:
        "Google Lighthouse could not complete this test.",

      detail:
        "This is a PageSpeed/Lighthouse provider failure. Your previous successful measurements remain available."
    };
  }


  if (
    /pagespeed api 429/i.test(
      raw
    )
  ) {
    return {
      title:
        "Google PageSpeed is temporarily rate limited.",

      detail:
        "SpeedPulse reached a temporary PageSpeed quota or rate limit. Retry handling will continue when applicable."
    };
  }


  if (
    lower.includes(
      "aborted"
    ) ||
    lower.includes(
      "aborterror"
    ) ||
    lower.includes(
      "timeout"
    ) ||
    lower.includes(
      "timed out"
    )
  ) {
    return {
      title:
        "The PageSpeed request did not finish in time.",

      detail:
        "The provider request timed out or was aborted. SpeedPulse will retry automatically when the failure is classified as transient."
    };
  }


  if (
    lower.includes(
      "network"
    ) ||
    lower.includes(
      "fetch failed"
    ) ||
    lower.includes(
      "connection reset"
    )
  ) {
    return {
      title:
        "The PageSpeed request hit a network error.",

      detail:
        "The scan did not receive a usable provider response. SpeedPulse will retry automatically when applicable."
    };
  }


  if (
    lower.includes(
      "test already running"
    )
  ) {
    return {
      title:
        "A scan is already running for this site.",

      detail:
        "SpeedPulse prevented overlapping provider work for the same site and device strategy."
    };
  }


  if (
    lower.includes(
      "google_api_key"
    )
  ) {
    return {
      title:
        "The Google API configuration needs attention.",

      detail:
        "The server could not use the configured Google API credentials. Check the Cloudflare Worker secret."
    };
  }


  return {
    title:
      "The scan could not be completed.",

    detail:
      raw.length <=
      180
        ? raw
        : "The complete diagnostic is available under Technical details."
  };
}


function technicalScanDetails(
  rawMessage
) {
  const raw =
    String(
      rawMessage ||
      ""
    ).trim();


  if (!raw) {
    return "";
  }


  return `
    <details class="scan-error-details">
      <summary>
        Technical details
      </summary>

      <pre>${escapeHtml(raw)}</pre>
    </details>
  `;
}


function scanStatusPresentation(
  activeJob,
  lastStatus,
  latest
) {
  const current =
    activeScanState(
      activeJob
    );


  if (
    current ===
    "retrying"
  ) {
    return statusBadge(
      `Retrying · attempt ${Number(activeJob.attempt || 0)}/3`,
      "warn"
    );
  }


  if (
    current ===
    "running"
  ) {
    return statusBadge(
      `Running · attempt ${Math.max(1, Number(activeJob.attempt || 1))}/3`,
      "warn"
    );
  }


  if (
    current ===
      "pending" ||
    current ===
      "queued"
  ) {
    return statusBadge(
      "Queued",
      "warn"
    );
  }


  if (
    lastStatus ===
    "failed"
  ) {
    return statusBadge(
      "Last run failed",
      "bad"
    );
  }


  if (latest) {
    return statusBadge(
      `Updated ${formatDate(latest.recorded_at)}`,
      "good"
    );
  }


  return statusBadge(
    "No tests yet"
  );
}


function renderScanNotice(
  activeJob,
  lastStatus,
  lastError
) {
  const current =
    activeScanState(
      activeJob
    );


  if (
    current ===
    "retrying"
  ) {
    const friendly =
      friendlyScanError(
        activeJob.error_class,
        activeJob.error_message
      );


    return `
      <div class="scan-notice warn">
        <div class="scan-notice-main">
          <div class="scan-notice-title">
            ${escapeHtml(friendly.title)}
          </div>

          <div class="scan-notice-copy">
            ${escapeHtml(friendly.detail)}
            Automatic retry is queued.
            The site has not been marked as a terminal failure.
          </div>
        </div>

        ${technicalScanDetails(
          activeJob.error_message
        )}
      </div>
    `;
  }


  if (
    current ===
    "running"
  ) {
    return `
      <div class="scan-notice info">
        <div class="scan-notice-main">
          <div class="scan-notice-title">
            Lighthouse scan in progress
          </div>

          <div class="scan-notice-copy">
            Queue job #${escapeHtml(activeJob.id)}
            is currently running.
            You can safely refresh or navigate away;
            the Worker Queue continues processing server-side.
          </div>
        </div>
      </div>
    `;
  }


  if (
    current ===
      "pending" ||
    current ===
      "queued"
  ) {
    return `
      <div class="scan-notice info">
        <div class="scan-notice-main">
          <div class="scan-notice-title">
            Scan queued
          </div>

          <div class="scan-notice-copy">
            Queue job #${escapeHtml(activeJob.id)}
            is waiting for the scan worker.
          </div>
        </div>
      </div>
    `;
  }


  if (
    lastStatus ===
      "failed" &&
    lastError
  ) {
    const friendly =
      friendlyScanError(
        null,
        lastError
      );


    return `
      <div class="scan-notice bad">
        <div class="scan-notice-main">
          <div class="scan-notice-title">
            ${escapeHtml(friendly.title)}
          </div>

          <div class="scan-notice-copy">
            ${escapeHtml(friendly.detail)}
            SpeedPulse has finished this logical scan as failed.
            Previous successful measurements remain unchanged.
          </div>
        </div>

        ${technicalScanDetails(
          lastError
        )}
      </div>
    `;
  }


  return "";
}


function scoreValue(value) {'''


replace_once(
    "public/app.js",
    APP_STATUS_OLD,
    APP_STATUS_NEW,
    "add friendly Queue/error presentation helpers",
    "CHECKPOINT-18: logical scan state + friendly provider errors",
)


# ================================================================
# Site-page state
# ================================================================

APP_SITE_VARS_OLD = r'''  const lastStatus = state.strategy === "mobile" ? site.mobile_last_status : site.desktop_last_status;
  const lastError = state.strategy === "mobile" ? site.mobile_last_error : site.desktop_last_error;
  const annotationsHtml = annotations.length ? annotations.map(a => `<div class="annotation"><time>${formatDate(a.created_at)}</time>${escapeHtml(a.note)}</div>`).join("") : `<p class="muted small">No optimization notes yet.</p>`;'''


APP_SITE_VARS_NEW = r'''  const lastStatus = state.strategy === "mobile" ? site.mobile_last_status : site.desktop_last_status;
  const lastError = state.strategy === "mobile" ? site.mobile_last_error : site.desktop_last_error;

  /*
   * CHECKPOINT-18:
   *
   * Active Queue state takes precedence over the last completed
   * logical scan when deciding what the user sees.
   */
  const activeJob =
    state.siteData
      ?.activeJobs
      ?.[state.strategy] ||
    null;


  const scanStatus =
    scanStatusPresentation(
      activeJob,
      lastStatus,
      latest
    );


  const scanNotice =
    renderScanNotice(
      activeJob,
      lastStatus,
      lastError
    );


  const annotationsHtml = annotations.length ? annotations.map(a => `<div class="annotation"><time>${formatDate(a.created_at)}</time>${escapeHtml(a.note)}</div>`).join("") : `<p class="muted small">No optimization notes yet.</p>`;'''


replace_once(
    "public/app.js",
    APP_SITE_VARS_OLD,
    APP_SITE_VARS_NEW,
    "make active Queue state authoritative on site page",
    "Active Queue state takes precedence",
)


# ================================================================
# Replace raw giant red JSON banner.
# ================================================================

APP_SITE_TEMPLATE_OLD = r'''    <div class="site-status-row"><div class="strategy-switch"><button class="pill ${state.strategy === "mobile" ? "active" : ""}" data-strategy="mobile">Mobile</button><button class="pill ${state.strategy === "desktop" ? "active" : ""}" data-strategy="desktop">Desktop</button></div><div>${lastStatus === "failed" ? statusBadge("Last run failed","bad") : latest ? statusBadge(`Updated ${formatDate(latest.recorded_at)}`,"good") : statusBadge("No tests yet")}</div></div>
    ${lastError ? `<div class="form-error" style="margin-bottom:16px">${escapeHtml(lastError)}</div>` : ""}'''


APP_SITE_TEMPLATE_NEW = r'''    <div class="site-status-row"><div class="strategy-switch"><button class="pill ${state.strategy === "mobile" ? "active" : ""}" data-strategy="mobile">Mobile</button><button class="pill ${state.strategy === "desktop" ? "active" : ""}" data-strategy="desktop">Desktop</button></div><div>${scanStatus}</div></div>
    ${scanNotice}'''


replace_once(
    "public/app.js",
    APP_SITE_TEMPLATE_OLD,
    APP_SITE_TEMPLATE_NEW,
    "replace raw provider banner with friendly expandable notice",
    "${scanNotice}",
)


# ================================================================
# Disable Run button when backend already has an active logical job.
# Backend duplicate protection remains authoritative.
# ================================================================

APP_DRAW_OLD = r'''  drawChart();
  $$('[data-strategy]').forEach(btn => btn.onclick = async () => { state.strategy = btn.dataset.strategy; state.metric = "performance_score"; await loadHistory(site.id, false); drawSitePage(); });'''


APP_DRAW_NEW = r'''  drawChart();


  /*
   * Backend duplicate protection remains the source of truth.
   * Disabling these buttons simply makes the current Queue state
   * obvious and prevents unnecessary duplicate POST requests.
   */
  $("#runMobile").disabled =
    Boolean(
      state.siteData
        ?.activeJobs
        ?.mobile
    );


  $("#runDesktop").disabled =
    Boolean(
      state.siteData
        ?.activeJobs
        ?.desktop
    );


  $$('[data-strategy]').forEach(btn => btn.onclick = async () => { state.strategy = btn.dataset.strategy; state.metric = "performance_score"; await loadHistory(site.id, false); drawSitePage(); });'''


replace_once(
    "public/app.js",
    APP_DRAW_OLD,
    APP_DRAW_NEW,
    "disable manual run buttons for already-active logical scans",
    "Backend duplicate protection remains the source of truth.",
)


# ================================================================
# Prevent a raw final PageSpeed JSON error from becoming the toast.
# ================================================================

APP_RUN_ERROR_OLD = r'''  } catch (error) {
    toast(
      error.message,
      "error"
    );

    try {
'''


APP_RUN_ERROR_NEW = r'''  } catch (error) {
    const scanError =
      friendlyScanError(
        null,
        error.message
      );


    toast(
      scanError.title,
      "error"
    );


    try {
'''


replace_once(
    "public/app.js",
    APP_RUN_ERROR_OLD,
    APP_RUN_ERROR_NEW,
    "use friendly scan error in manual-run toast",
    "const scanError =\n      friendlyScanError(",
)


# ================================================================
# 6. public/styles.css
# ================================================================

CSS_ANCHOR = r'''.form-error { margin-top: 12px; padding: 10px 12px; border: 1px solid #fee4e2; border-radius: 9px; background: var(--bad-bg); color: var(--bad); font-size: 13px; }
'''


CSS_REPLACEMENT = r'''.form-error { margin-top: 12px; padding: 10px 12px; border: 1px solid #fee4e2; border-radius: 9px; background: var(--bad-bg); color: var(--bad); font-size: 13px; }


/*
 * ================================================================
 * CHECKPOINT-18: scan progress / retry / terminal error notice
 * ================================================================
 */

.scan-notice {
  margin: 0 0 16px;
  padding: 13px 15px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: #fff;
  color: #344054;
  line-height: 1.5;
}

.scan-notice.info {
  border-color: #dbe4ff;
  background: #f6f8ff;
}

.scan-notice.warn {
  border-color: #fedf89;
  background: var(--warn-bg);
}

.scan-notice.bad {
  border-color: #fecdca;
  background: var(--bad-bg);
}

.scan-notice-main {
  min-width: 0;
}

.scan-notice-title {
  color: #1d2939;
  font-size: 13px;
  font-weight: 760;
}

.scan-notice.warn .scan-notice-title {
  color: var(--warn);
}

.scan-notice.bad .scan-notice-title {
  color: var(--bad);
}

.scan-notice-copy {
  margin-top: 3px;
  color: #667085;
  font-size: 12px;
}

.scan-error-details {
  margin-top: 10px;
  border-top: 1px solid rgba(102,112,133,.16);
  padding-top: 9px;
}

.scan-error-details summary {
  width: fit-content;
  color: #475467;
  cursor: pointer;
  font-size: 11px;
  font-weight: 720;
  user-select: none;
}

.scan-error-details summary:hover {
  color: #1d2939;
}

.scan-error-details pre {
  max-height: 230px;
  margin: 9px 0 0;
  overflow: auto;
  padding: 10px 11px;
  border: 1px solid rgba(102,112,133,.13);
  border-radius: 8px;
  background: rgba(255,255,255,.72);
  color: #475467;
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
'''


replace_once(
    "public/styles.css",
    CSS_ANCHOR,
    CSS_REPLACEMENT,
    "add scan retry/error notice styling",
    "CHECKPOINT-18: scan progress / retry / terminal error notice",
)


# ================================================================
# 7. Add dedicated regression verifier
# ================================================================

VERIFY_PATH = (
    ROOT
    / "scripts"
    / "verify-checkpoint-18.mjs"
)


VERIFY_SOURCE = r'''import fs from "node:fs";


const read =
  (path) =>
    fs.readFileSync(
      path,
      "utf8"
    );


function check(
  condition,
  message
) {
  if (!condition) {
    throw new Error(
      `CHECKPOINT-18 CHECK FAILED: ${message}`
    );
  }
}


const db =
  read(
    "src/db.ts"
  );


const control =
  read(
    "src/control-plane.ts"
  );


const queue =
  read(
    "src/queue.ts"
  );


const index =
  read(
    "src/index.ts"
  );


const ui =
  read(
    "public/app.js"
  );


const css =
  read(
    "public/styles.css"
  );


/*
 * ================================================================
 * Attempt-vs-logical-job failure boundary
 * ================================================================
 */

check(
  db.includes(
    "CHECKPOINT-18: Queue-owned failure boundary"
  ),
  "db.ts does not document/enforce the Queue-owned failure boundary"
);


check(
  db.includes(
    "if (!scanJobId)"
  ),
  "Queue-owned runSiteTest failures can still directly promote the site to failed"
);


check(
  db.includes(
    "failureStatements"
  ) &&
  db.includes(
    "UPDATE test_runs"
  ),
  "failed provider attempts are not clearly retained in test_runs"
);


/*
 * ================================================================
 * Terminal Queue failure ownership
 * ================================================================
 */

check(
  control.includes(
    "export async function completeScanJobFailureAndSite"
  ),
  "atomic logical-job/site failure finalizer is missing"
);


check(
  control.includes(
    "mobile_last_status"
  ) &&
  control.includes(
    "desktop_last_status"
  ),
  "terminal finalizer does not cover both strategies"
);


check(
  queue.includes(
    "completeScanJobFailureAndSite("
  ),
  "queue.ts does not promote terminal logical failures to site state"
);


check(
  queue.includes(
    "We are now past the retry decision."
  ),
  "terminal failure promotion is not visibly located after retry decision"
);


const retryIndex =
  queue.indexOf(
    "await requeueScanJob("
  );


const terminalIndex =
  queue.indexOf(
    "await completeScanJobFailureAndSite("
  );


check(
  retryIndex >= 0 &&
  terminalIndex > retryIndex,
  "site terminal failure promotion appears before transient requeue handling"
);


/*
 * ================================================================
 * Refresh-safe active Queue state
 * ================================================================
 */

check(
  index.includes(
    "getActiveJob("
  ) &&
  index.includes(
    "activeJobs:"
  ),
  "normal site-detail API does not expose active Queue state"
);


check(
  ui.includes(
    "activeScanState"
  ) &&
  ui.includes(
    "activeJobs"
  ),
  "normal site UI does not consume active Queue state"
);


check(
  ui.includes(
    "Retrying · attempt"
  ),
  "retrying state is not shown in the normal site UI"
);


check(
  ui.includes(
    "Lighthouse scan in progress"
  ),
  "running Queue state is not shown in the normal site UI"
);


/*
 * ================================================================
 * Friendly error presentation
 * ================================================================
 */

check(
  ui.includes(
    "friendlyScanError"
  ),
  "friendly provider-error classifier is missing"
);


check(
  ui.includes(
    "technicalScanDetails"
  ) &&
  ui.includes(
    "Technical details"
  ),
  "expandable technical diagnostics are missing"
);


check(
  !ui.includes(
    '${lastError ? `<div class="form-error" style="margin-bottom:16px">${escapeHtml(lastError)}</div>` : ""}'
  ),
  "raw site last_error banner still exists"
);


check(
  css.includes(
    ".scan-notice.warn"
  ) &&
  css.includes(
    ".scan-notice.bad"
  ) &&
  css.includes(
    ".scan-error-details"
  ),
  "scan progress/error notice CSS is incomplete"
);


console.log(
  "Checkpoint-18 retry/state/error UI regression checks: PASS"
);
'''


VERIFY_PATH.write_text(
    VERIFY_SOURCE,
    encoding="utf-8"
)


print(
    "OK: created scripts/verify-checkpoint-18.mjs"
)


# ================================================================
# 8. Include Checkpoint-18 verifier in npm run check
# ================================================================

PACKAGE_PATH = (
    ROOT
    / "package.json"
)


package = json.loads(
    PACKAGE_PATH.read_text(
        encoding="utf-8"
    )
)


scripts = package.setdefault(
    "scripts",
    {}
)


check_script = scripts.get(
    "check",
    ""
)


verify_command = (
    "node scripts/verify-checkpoint-18.mjs"
)


if verify_command not in check_script:
    if check_script.strip():
        check_script = (
            check_script.strip()
            + " && "
            + verify_command
        )
    else:
        check_script = (
            verify_command
        )


    scripts["check"] = (
        check_script
    )


    PACKAGE_PATH.write_text(
        json.dumps(
            package,
            indent=2
        )
        + "\n",
        encoding="utf-8"
    )


    print(
        "OK: added Checkpoint-18 verifier to npm run check"
    )
else:
    print(
        "SKIP: package.json already runs Checkpoint-18 verifier"
    )


print()
print(
    "============================================================"
)

print(
    "CHECKPOINT-18 SOURCE PATCH COMPLETE"
)

print(
    "============================================================"
)

print()
print(
    "No deployment was performed."
)

print(
    "No migration was performed."
)

print(
    "No remote data was modified."
)

print()
print(
    f"Backups: {BACKUP_ROOT}"
)

print()

