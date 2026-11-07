#!/usr/bin/env python3

from pathlib import Path
from datetime import datetime
import json
import shutil
import sys


ROOT = Path.cwd()


REQUIRED = [
    "package.json",
    "src/scan-policy.ts",
    "src/control-plane.ts",
    "src/queue.ts",
    "src/index.ts",
    "public/index.html",
    "public/app.js",
    "public/styles.css",
    "scripts/verify-checkpoint-18.mjs",
]


for rel in REQUIRED:
    if not (ROOT / rel).exists():
        print()
        print(f"ERROR: required file missing: {rel}")
        print("Run this from the speedpulse-next project root.")
        print()
        sys.exit(1)


# ================================================================
# Require Checkpoint 18 first.
# ================================================================

app_before = (
    ROOT / "public/app.js"
).read_text(
    encoding="utf-8"
)


queue_before = (
    ROOT / "src/queue.ts"
).read_text(
    encoding="utf-8"
)


if (
    "CHECKPOINT-18: logical scan state + friendly provider errors"
    not in app_before
):
    print()
    print(
        "ERROR: Checkpoint 18 frontend marker was not found."
    )
    print(
        "Checkpoint 19 is intentionally built on top of Checkpoint 18."
    )
    print(
        "Do not apply this patch to the older source."
    )
    print()
    sys.exit(1)


if (
    "completeScanJobFailureAndSite"
    not in queue_before
):
    print()
    print(
        "ERROR: Checkpoint 18 Queue failure-boundary code was not found."
    )
    print(
        "Checkpoint 19 has not changed anything."
    )
    print()
    sys.exit(1)


# ================================================================
# Backup before changing anything.
# ================================================================

STAMP = datetime.now().strftime(
    "%Y%m%d_%H%M%S"
)


BACKUP_ROOT = (
    ROOT
    / "backups"
    / f"checkpoint19_{STAMP}"
)


BACKUP_ROOT.mkdir(
    parents=True,
    exist_ok=True
)


FILES_TO_BACKUP = [
    "package.json",
    "src/scan-policy.ts",
    "src/control-plane.ts",
    "src/queue.ts",
    "src/index.ts",
    "public/index.html",
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


# ================================================================
# Helpers
# ================================================================

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
            f"File: {rel}"
        )
        print(
            f"Expected exactly one source match; found {count}."
        )
        print()
        print(
            "The script stopped rather than guessing."
        )
        print(
            f"Backups: {BACKUP_ROOT}"
        )
        print()
        sys.exit(1)

    write(
        rel,
        text.replace(
            old,
            new,
            1
        )
    )

    print(
        f"OK: {label}"
    )


def replace_exact_count(
    rel,
    old,
    new,
    expected,
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

    if count != expected:
        print()
        print(
            f"ERROR applying: {label}"
        )
        print(
            f"File: {rel}"
        )
        print(
            f"Expected {expected} source matches; found {count}."
        )
        print(
            "No automatic guess was made."
        )
        print()
        sys.exit(1)

    write(
        rel,
        text.replace(
            old,
            new
        )
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
            f"File: {rel}"
        )
        print(
            f"Expected one insertion anchor; found {count}."
        )
        print()
        sys.exit(1)

    write(
        rel,
        text.replace(
            anchor,
            content + anchor,
            1
        )
    )

    print(
        f"OK: {label}"
    )


# ================================================================
# 1. Shared Queue retry-delay policy
#
# Before this checkpoint queue.ts contains literal 120-second
# delivery delays. Make that a shared policy so the UI and worker
# cannot silently drift apart.
# ================================================================

POLICY_OLD = r'''export const SCAN_RUN_LEASE_MS =
  5 * 60 * 1000;
'''


POLICY_NEW = r'''export const SCAN_RUN_LEASE_MS =
  5 * 60 * 1000;


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
'''


replace_once(
    "src/scan-policy.ts",
    POLICY_OLD,
    POLICY_NEW,
    "centralize Queue retry delay",
    "CHECKPOINT-19:",
)


# ================================================================
# 2. control-plane.ts imports retry-delay policy
# ================================================================

CONTROL_POLICY_IMPORT_OLD = r'''import { SCAN_RUN_LEASE_MS } from "./scan-policy";
'''


CONTROL_POLICY_IMPORT_NEW = r'''import {
  SCAN_QUEUE_RETRY_DELAY_SECONDS,
  SCAN_RUN_LEASE_MS
} from "./scan-policy";
'''


replace_once(
    "src/control-plane.ts",
    CONTROL_POLICY_IMPORT_OLD,
    CONTROL_POLICY_IMPORT_NEW,
    "import shared Queue retry policy into control plane",
    "  SCAN_QUEUE_RETRY_DELAY_SECONDS,\n  SCAN_RUN_LEASE_MS",
)


# ================================================================
# 3. Add Queue workspace aggregator.
#
# No migration.
#
# Returns:
#
#   exact Running count
#   exact Waiting count
#   exact Retrying count
#   exact Failed 24h count
#   every active job up to a defensive 200-row cap
#   recent completed jobs
#   average successful provider durations for approximate ETA
#   the authoritative retry delay
# ================================================================

CONTROL_QUEUE_WORKSPACE = r'''

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

'''


insert_before_once(
    "src/control-plane.ts",
    "export async function listScanTargets(",
    CONTROL_QUEUE_WORKSPACE,
    "add exact Queue workspace data aggregator",
    "CHECKPOINT-19: main Queue workspace",
)


# ================================================================
# 4. queue.ts uses shared retry delay instead of duplicated 120.
# ================================================================

QUEUE_UTILS_ANCHOR = r'''import {
  nowIso
} from "./utils";
'''


QUEUE_POLICY_IMPORT = r'''import {
  SCAN_QUEUE_RETRY_DELAY_SECONDS
} from "./scan-policy";


'''


insert_before_once(
    "src/queue.ts",
    QUEUE_UTILS_ANCHOR,
    QUEUE_POLICY_IMPORT,
    "import shared Queue retry delay into consumer",
    'from "./scan-policy";',
)


replace_exact_count(
    "src/queue.ts",
    r'''delaySeconds:
            120''',
    r'''delaySeconds:
            SCAN_QUEUE_RETRY_DELAY_SECONDS''',
    2,
    "replace both literal 120-second Queue retries with shared policy",
    "delaySeconds:\n            SCAN_QUEUE_RETRY_DELAY_SECONDS",
)


# ================================================================
# 5. index.ts imports Queue workspace backend.
# ================================================================

INDEX_IMPORT_OLD = r'''  getActiveJob,
  getScanJobById,
'''


INDEX_IMPORT_NEW = r'''  getActiveJob,
  getQueueWorkspace,
  getScanJobById,
'''


replace_once(
    "src/index.ts",
    INDEX_IMPORT_OLD,
    INDEX_IMPORT_NEW,
    "import getQueueWorkspace into Worker API",
    "  getQueueWorkspace,\n  getScanJobById,",
)


# ================================================================
# 6. Add authenticated Queue workspace endpoint.
# ================================================================

INDEX_QUEUE_ROUTE = r'''  /*
   * CHECKPOINT-19:
   *
   * Thin authenticated operational endpoint for the main dashboard.
   * No mutations are performed here.
   */
  if (
    path ===
      "/api/next/queue-workspace" &&
    request.method ===
      "GET"
  ) {
    const limit =
      intParam(
        url.searchParams.get(
          "limit"
        ) ||
        undefined
      ) ||
      60;


    return json({
      queue:
        await getQueueWorkspace(
          env.DB,
          limit
        )
    });
  }


'''


insert_before_once(
    "src/index.ts",
    r'''  if (path === "/api/next/targets" && request.method === "GET") {''',
    INDEX_QUEUE_ROUTE,
    "add /api/next/queue-workspace endpoint",
    '"/api/next/queue-workspace"',
)


# ================================================================
# 7. Sidebar: Queue directly below Projects.
# ================================================================

HTML_PROJECT_BUTTON = r'''        <button class="nav-item" data-route="#projects">
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5v9A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5v-11Z"/></svg>
          </span>
          <span>Projects</span>
        </button>
'''


HTML_PROJECT_AND_QUEUE = r'''        <button class="nav-item" data-route="#projects">
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5v9A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5v-11Z"/></svg>
          </span>
          <span>Projects</span>
        </button>

        <button class="nav-item" data-route="#queue">
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 5h12v2H4V5Zm0 6h12v2H4v-2Zm0 6h12v2H4v-2Zm14-9 4 4-4 4v-3h-3v-2h3V8Z"/>
            </svg>
          </span>
          <span>Queue</span>
        </button>
'''


replace_once(
    "public/index.html",
    HTML_PROJECT_BUTTON,
    HTML_PROJECT_AND_QUEUE,
    "add Queue to main sidebar",
    'data-route="#queue"',
)


# ================================================================
# 8. Extend main frontend state for controlled adaptive polling.
# ================================================================

APP_STATE_OLD = r'''  history: [],
  siteData: null
};
'''


APP_STATE_NEW = r'''  history: [],
  siteData: null,

  /*
   * CHECKPOINT-19 Queue workspace state.
   *
   * queuePollGeneration prevents a late fetch from updating the DOM
   * after the user navigates away.
   */
  queueData: null,
  queuePollTimer: null,
  queuePollGeneration: 0,
  queuePollBusyGeneration: null,
  queuePollLastError: null
};
'''


replace_once(
    "public/app.js",
    APP_STATE_OLD,
    APP_STATE_NEW,
    "add Queue polling state",
    "queuePollGeneration:",
)


# ================================================================
# 9. Stop polling when authentication disappears.
# ================================================================

SHOW_LOGIN_OLD = r'''function showLogin(message = "") {
  state.authenticated = false;
'''


SHOW_LOGIN_NEW = r'''function showLogin(message = "") {
  stopQueuePolling();

  state.authenticated = false;
'''


replace_once(
    "public/app.js",
    SHOW_LOGIN_OLD,
    SHOW_LOGIN_NEW,
    "stop Queue polling on logout/session expiry",
    "function showLogin(message = \"\") {\n  stopQueuePolling();",
)


# ================================================================
# 10. Router supports #queue and shuts polling down on navigation.
# ================================================================

ROUTER_OLD = r'''async function router() {
  if (!state.authenticated) return;
  setActiveNav();
  $(".sidebar")?.classList.remove("open");
  const hash = location.hash || "#dashboard";
  const projectMatch = hash.match(/^#project\/(\d+)/);
  const siteMatch = hash.match(/^#site\/(\d+)/);
  try {
    if (siteMatch) return await renderSite(Number(siteMatch[1]));
    if (projectMatch) return await renderProject(Number(projectMatch[1]));
    if (hash === "#projects") return await renderProjects();
    return await renderDashboard();
  } catch (error) {
    $("#mainContent").innerHTML = `<div class="card empty"><h3>Could not load this view</h3><p>${escapeHtml(error.message)}</p><button class="button" onclick="location.reload()">Reload</button></div>`;
    toast(error.message, "error");
  }
}
'''


ROUTER_NEW = r'''async function router() {
  if (!state.authenticated) return;

  setActiveNav();

  $(".sidebar")
    ?.classList
    .remove(
      "open"
    );


  const hash =
    location.hash ||
    "#dashboard";


  /*
   * CHECKPOINT-19:
   *
   * Queue polling exists only while #queue is the active workspace.
   */
  if (
    hash !==
    "#queue"
  ) {
    stopQueuePolling();
  }


  const projectMatch =
    hash.match(
      /^#project\/(\d+)/
    );


  const siteMatch =
    hash.match(
      /^#site\/(\d+)/
    );


  try {
    if (siteMatch) {
      return await renderSite(
        Number(
          siteMatch[1]
        )
      );
    }


    if (projectMatch) {
      return await renderProject(
        Number(
          projectMatch[1]
        )
      );
    }


    if (
      hash ===
      "#projects"
    ) {
      return await renderProjects();
    }


    if (
      hash ===
      "#queue"
    ) {
      return await renderQueue();
    }


    return await renderDashboard();
  } catch (error) {
    $("#mainContent").innerHTML =
      `<div class="card empty"><h3>Could not load this view</h3><p>${escapeHtml(error.message)}</p><button class="button" onclick="location.reload()">Reload</button></div>`;

    toast(
      error.message,
      "error"
    );
  }
}
'''


replace_once(
    "public/app.js",
    ROUTER_OLD,
    ROUTER_NEW,
    "add Queue route and route-aware polling cleanup",
    'hash ===\n      "#queue"',
)


# ================================================================
# 11. Full Queue workspace frontend.
# ================================================================

QUEUE_UI = r'''
/*
 * ================================================================
 * CHECKPOINT-19: Queue workspace
 * ================================================================
 */

const QUEUE_ACTIVE_POLL_MS =
  3000;


const QUEUE_IDLE_POLL_MS =
  15000;


const QUEUE_HIDDEN_POLL_MS =
  30000;


const QUEUE_DEFAULT_RUN_MS =
  45000;


function stopQueuePolling() {
  if (
    state.queuePollTimer
  ) {
    clearTimeout(
      state.queuePollTimer
    );
  }


  state.queuePollTimer =
    null;


  /*
   * Invalidates in-flight responses from an older Queue page.
   */
  state.queuePollGeneration +=
    1;
}


function queueEffectiveStatus(
  job
) {
  if (!job) {
    return "unknown";
  }


  /*
   * Reuse the same logical retry semantics introduced in
   * Checkpoint 18.
   */
  if (
    typeof activeScanState ===
    "function"
  ) {
    return activeScanState(
      job
    );
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


  return (
    job.status ||
    "unknown"
  );
}


function queueStatusBadge(
  job
) {
  const status =
    queueEffectiveStatus(
      job
    );


  if (
    status ===
    "running"
  ) {
    return statusBadge(
      "Running",
      "warn"
    );
  }


  if (
    status ===
    "retrying"
  ) {
    return statusBadge(
      "Retrying",
      "warn"
    );
  }


  if (
    status ===
      "pending" ||
    status ===
      "queued"
  ) {
    return statusBadge(
      "Waiting",
      "neutral"
    );
  }


  if (
    status ===
    "success"
  ) {
    return statusBadge(
      "Success",
      "good"
    );
  }


  if (
    status ===
    "failed"
  ) {
    return statusBadge(
      "Failed",
      "bad"
    );
  }


  if (
    status ===
    "cancelled"
  ) {
    return statusBadge(
      "Cancelled",
      "neutral"
    );
  }


  return statusBadge(
    status
  );
}


function queueTriggerLabel(
  trigger
) {
  const labels = {
    manual:
      "Manual",

    scheduled:
      "Scheduled",

    bulk:
      "Bulk",

    retry:
      "Retry"
  };


  return (
    labels[
      trigger
    ] ||
    String(
      trigger ||
      "Unknown"
    )
  );
}


function queueStrategyLabel(
  strategy
) {
  return strategy ===
    "desktop"
      ? "Desktop"
      : "Mobile";
}


function queueDateMs(
  value
) {
  if (!value) {
    return null;
  }


  const parsed =
    Date.parse(
      value
    );


  return Number.isFinite(
    parsed
  )
    ? parsed
    : null;
}


function formatCompactDuration(
  milliseconds
) {
  const raw =
    Number(
      milliseconds
    );


  if (
    !Number.isFinite(
      raw
    )
  ) {
    return "—";
  }


  const seconds =
    Math.max(
      0,
      Math.round(
        raw /
        1000
      )
    );


  if (
    seconds <
    60
  ) {
    return `${seconds}s`;
  }


  const minutes =
    Math.floor(
      seconds /
      60
    );


  const remainingSeconds =
    seconds %
    60;


  if (
    minutes <
    60
  ) {
    return remainingSeconds
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }


  const hours =
    Math.floor(
      minutes /
      60
    );


  const remainingMinutes =
    minutes %
    60;


  return remainingMinutes
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`;
}


function queueTypicalRunMs(
  queue,
  strategy
) {
  const raw =
    Number(
      queue
        ?.durationHints
        ?.[strategy]
        ?.averageMs
    );


  if (
    !Number.isFinite(
      raw
    ) ||
    raw <= 0
  ) {
    return QUEUE_DEFAULT_RUN_MS;
  }


  /*
   * Keep the UI estimate deliberately conservative.
   *
   * It is an approximation, not a promise from Google Lighthouse.
   */
  return Math.max(
    10000,
    Math.min(
      180000,
      raw
    )
  );
}


function queueTimingText(
  job,
  queue
) {
  const now =
    Date.now();


  const status =
    queueEffectiveStatus(
      job
    );


  const createdAt =
    queueDateMs(
      job.created_at
    );


  const queuedAt =
    queueDateMs(
      job.queued_at
    );


  const startedAt =
    queueDateMs(
      job.started_at
    );


  const completedAt =
    queueDateMs(
      job.completed_at
    );


  const updatedAt =
    queueDateMs(
      job.updated_at
    );


  const typicalRunMs =
    queueTypicalRunMs(
      queue,
      job.strategy
    );


  if (
    status ===
    "running"
  ) {
    const start =
      startedAt ||
      updatedAt ||
      createdAt ||
      now;


    const elapsed =
      Math.max(
        0,
        now -
        start
      );


    const remaining =
      typicalRunMs -
      elapsed;


    if (
      remaining >
      5000
    ) {
      return `
        <div class="queue-time-main">
          ${escapeHtml(
            formatCompactDuration(
              elapsed
            )
          )} elapsed
        </div>

        <div class="queue-time-sub">
          ETA ~${escapeHtml(
            formatCompactDuration(
              remaining
            )
          )}
        </div>
      `;
    }


    return `
      <div class="queue-time-main">
        ${escapeHtml(
          formatCompactDuration(
            elapsed
          )
        )} elapsed
      </div>

      <div class="queue-time-sub">
        Typical run ~${escapeHtml(
          formatCompactDuration(
            typicalRunMs
          )
        )}
      </div>
    `;
  }


  if (
    status ===
    "retrying"
  ) {
    const retryDelay =
      Math.max(
        1,
        Number(
          queue
            ?.retryDelaySeconds ||
          120
        )
      ) *
      1000;


    const retryBase =
      queuedAt ||
      updatedAt ||
      now;


    const retryAt =
      retryBase +
      retryDelay;


    const remaining =
      retryAt -
      now;


    const total =
      createdAt
        ? Math.max(
            0,
            now -
            createdAt
          )
        : null;


    return `
      <div class="queue-time-main">
        ${
          remaining >
          0
            ? `Retry in ~${escapeHtml(
                formatCompactDuration(
                  remaining
                )
              )}`
            : "Retry due"
        }
      </div>

      <div class="queue-time-sub">
        ${
          total !==
          null
            ? `${escapeHtml(
                formatCompactDuration(
                  total
                )
              )} total · `
            : ""
        }run ~${escapeHtml(
          formatCompactDuration(
            typicalRunMs
          )
        )}
      </div>
    `;
  }


  if (
    status ===
      "pending" ||
    status ===
      "queued"
  ) {
    const waitingSince =
      queuedAt ||
      createdAt ||
      now;


    const waiting =
      Math.max(
        0,
        now -
        waitingSince
      );


    return `
      <div class="queue-time-main">
        Waiting ${escapeHtml(
          formatCompactDuration(
            waiting
          )
        )}
      </div>

      <div class="queue-time-sub">
        Run ~${escapeHtml(
          formatCompactDuration(
            typicalRunMs
          )
        )} after start
      </div>
    `;
  }


  if (
    createdAt &&
    completedAt
  ) {
    return `
      <div class="queue-time-main">
        ${escapeHtml(
          formatCompactDuration(
            Math.max(
              0,
              completedAt -
              createdAt
            )
          )
        )} total
      </div>

      <div class="queue-time-sub">
        ${escapeHtml(
          formatDate(
            job.completed_at
          )
        )}
      </div>
    `;
  }


  return `
    <div class="queue-time-main">
      —
    </div>
  `;
}


function queueAttemptHtml(
  job
) {
  const attempt =
    Number(
      job.attempt ||
      0
    );


  if (
    attempt <=
    0
  ) {
    return `
      <span class="muted small">
        Not started
      </span>
    `;
  }


  return `
    <span class="queue-attempt">
      ${escapeHtml(
        Math.min(
          3,
          attempt
        )
      )}/3
    </span>
  `;
}


function queueErrorHtml(
  job
) {
  const raw =
    String(
      job.error_message ||
      ""
    ).trim();


  if (!raw) {
    return `
      <span class="muted small">
        —
      </span>
    `;
  }


  const friendly =
    typeof friendlyScanError ===
    "function"
      ? friendlyScanError(
          job.error_class,
          raw
        )
      : {
          title:
            "Scan error",

          detail:
            "Technical details are available below."
        };


  return `
    <div class="queue-error">
      <div
        class="queue-error-title"
        title="${escapeHtml(
          friendly.detail ||
          ""
        )}"
      >
        ${escapeHtml(
          friendly.title
        )}
      </div>

      ${
        job.error_class
          ? `
            <div class="queue-error-class mono">
              ${escapeHtml(
                job.error_class
              )}
            </div>
          `
          : ""
      }

      <details class="queue-error-details">
        <summary>
          Details
        </summary>

        <pre>${escapeHtml(
          raw
        )}</pre>
      </details>
    </div>
  `;
}


function queueSiteHtml(
  job
) {
  const siteId =
    Number(
      job.site_id
    );


  const projectId =
    Number(
      job.project_id
    );


  const siteName =
    job.site_name ||
    `Site ${siteId}`;


  const projectName =
    job.project_name ||
    "Project";


  const site =
    Number.isInteger(
      siteId
    ) &&
    siteId >
    0
      ? `
        <a
          class="queue-site-link"
          href="#site/${siteId}"
        >
          ${escapeHtml(
            siteName
          )}
        </a>
      `
      : escapeHtml(
          siteName
        );


  const project =
    Number.isInteger(
      projectId
    ) &&
    projectId >
    0
      ? `
        <a
          class="queue-project-link"
          href="#project/${projectId}"
        >
          ${escapeHtml(
            projectName
          )}
        </a>
      `
      : escapeHtml(
          projectName
        );


  return `
    <div class="queue-site-cell">
      <div class="site-name">
        ${site}
      </div>

      <div class="site-url">
        ${project}

        ${
          job.site_url
            ? ` · ${escapeHtml(
                job.site_url
              )}`
            : ""
        }
      </div>
    </div>
  `;
}


function queueJobRow(
  job,
  queue
) {
  const effectiveStatus =
    queueEffectiveStatus(
      job
    );


  const strategyClass =
    job.strategy ===
    "desktop"
      ? "desktop"
      : "mobile";


  return `
    <tr
      class="queue-row queue-row-${escapeHtml(
        effectiveStatus
      )}"
      data-queue-job-id="${escapeHtml(
        job.id
      )}"
    >
      <td>
        ${queueSiteHtml(
          job
        )}
      </td>

      <td>
        <span class="queue-device ${strategyClass}">
          ${escapeHtml(
            queueStrategyLabel(
              job.strategy
            )
          )}
        </span>
      </td>

      <td>
        <div class="queue-trigger">
          ${escapeHtml(
            queueTriggerLabel(
              job.trigger
            )
          )}
        </div>

        <div class="table-subtext">
          Job #${escapeHtml(
            job.id
          )}
        </div>
      </td>

      <td>
        ${queueStatusBadge(
          job
        )}
      </td>

      <td>
        ${queueAttemptHtml(
          job
        )}
      </td>

      <td class="queue-time-cell">
        ${queueTimingText(
          job,
          queue
        )}
      </td>

      <td class="queue-error-cell">
        ${queueErrorHtml(
          job
        )}
      </td>
    </tr>
  `;
}


function queuePollInterval(
  queue
) {
  if (
    document.hidden
  ) {
    return QUEUE_HIDDEN_POLL_MS;
  }


  return Number(
    queue
      ?.counts
      ?.activeJobs ||
    0
  ) >
    0
      ? QUEUE_ACTIVE_POLL_MS
      : QUEUE_IDLE_POLL_MS;
}


function queuePollLabel(
  queue
) {
  const interval =
    queuePollInterval(
      queue
    );


  return interval ===
    QUEUE_ACTIVE_POLL_MS
      ? "Live · every 3s"
      : interval ===
          QUEUE_HIDDEN_POLL_MS
        ? "Live · background 30s"
        : "Live · every 15s";
}


function renderQueueShell(
  generation
) {
  $("#mainContent").innerHTML = `
    <div class="page-head">
      <div>
        <span class="eyebrow">
          Operations
        </span>

        <h1>
          Queue
        </h1>

        <p>
          Live logical scan activity across every project.
          Times and ETA values are approximate because Google
          Lighthouse execution time varies.
        </p>
      </div>

      <div class="page-actions">
        <button
          class="button"
          id="queueRefreshButton"
          type="button"
        >
          Refresh now
        </button>
      </div>
    </div>


    <div
      id="queuePollError"
      class="scan-notice bad hidden"
    ></div>


    <div
      class="cards queue-summary-cards"
      id="queueSummaryCards"
    >
      ${metricCard(
        "Running",
        "—",
        "Currently executing"
      )}

      ${metricCard(
        "Waiting",
        "—",
        "Waiting for first delivery"
      )}

      ${metricCard(
        "Retrying",
        "—",
        "Transient retry delay"
      )}

      ${metricCard(
        "Failed 24h",
        "—",
        "Terminal logical failures"
      )}
    </div>


    <section class="section">
      <div class="section-head queue-section-head">
        <div>
          <h2>
            Active queue
          </h2>

          <div
            class="table-subtext"
            id="queueActiveMeta"
          >
            Loading current work…
          </div>
        </div>

        <div class="queue-head-meta">
          <span
            id="queueLiveState"
          >
            ${statusBadge(
              "Connecting",
              "neutral"
            )}
          </span>

          <span
            class="muted small"
            id="queueLastUpdated"
          >
            Waiting for first refresh
          </span>
        </div>
      </div>

      <div class="card table-wrap queue-table-wrap">
        <table class="queue-table">
          <thead>
            <tr>
              <th>Site / project</th>
              <th>Device</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Attempt</th>
              <th>Time / ETA</th>
              <th>Error</th>
            </tr>
          </thead>

          <tbody id="queueActiveBody">
            <tr>
              <td colspan="7">
                <div class="empty">
                  Loading queue…
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>


    <section class="section">
      <div class="section-head">
        <div>
          <h2>
            Recent completed jobs
          </h2>

          <div
            class="table-subtext"
            id="queueRecentMeta"
          >
            Loading recent history…
          </div>
        </div>
      </div>

      <div class="card table-wrap queue-table-wrap">
        <table class="queue-table">
          <thead>
            <tr>
              <th>Site / project</th>
              <th>Device</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Attempt</th>
              <th>Total time</th>
              <th>Error</th>
            </tr>
          </thead>

          <tbody id="queueRecentBody">
            <tr>
              <td colspan="7">
                <div class="empty">
                  Loading completed jobs…
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `;


  $("#queueRefreshButton").onclick =
    () => {
      refreshQueueWorkspace(
        generation,
        true
      );
    };
}


function drawQueueWorkspace(
  queue
) {
  if (
    location.hash !==
    "#queue"
  ) {
    return;
  }


  const counts =
    queue?.counts ||
    {};


  $("#queueSummaryCards").innerHTML = `
    ${metricCard(
      "Running",
      Number(
        counts.runningJobs ||
        0
      ),
      "Currently executing",
      Number(
        counts.runningJobs ||
        0
      )
        ? "score-warn"
        : ""
    )}

    ${metricCard(
      "Waiting",
      Number(
        counts.waitingJobs ||
        0
      ),
      "Pending + first delivery"
    )}

    ${metricCard(
      "Retrying",
      Number(
        counts.retryingJobs ||
        0
      ),
      "Transient provider retries",
      Number(
        counts.retryingJobs ||
        0
      )
        ? "score-warn"
        : ""
    )}

    ${metricCard(
      "Failed 24h",
      Number(
        counts.failedJobs24h ||
        0
      ),
      "Terminal logical failures",
      Number(
        counts.failedJobs24h ||
        0
      )
        ? "score-bad"
        : "score-good"
    )}
  `;


  const activeJobs =
    Array.isArray(
      queue.activeJobs
    )
      ? queue.activeJobs
      : [];


  const recentJobs =
    Array.isArray(
      queue.recentJobs
    )
      ? queue.recentJobs
      : [];


  $("#queueActiveMeta").textContent =
    Number(
      counts.activeJobs ||
      0
    ) ===
    0
      ? "No logical scans are currently active."
      : queue.activeTruncated
        ? `${activeJobs.length} shown of ${Number(
            counts.activeJobs ||
            0
          )} active jobs.`
        : `${Number(
            counts.activeJobs ||
            0
          )} active logical scan${
            Number(
              counts.activeJobs ||
              0
            ) ===
            1
              ? ""
              : "s"
          }.`;


  $("#queueRecentMeta").textContent =
    `${recentJobs.length} recent completed logical job${
      recentJobs.length ===
      1
        ? ""
        : "s"
    }.`;


  $("#queueActiveBody").innerHTML =
    activeJobs.length
      ? activeJobs
          .map(
            (job) =>
              queueJobRow(
                job,
                queue
              )
          )
          .join("")
      : `
        <tr>
          <td colspan="7">
            <div class="empty queue-empty">
              <h3>
                Queue is clear
              </h3>

              <p>
                No sites are currently waiting,
                running, or retrying.
              </p>
            </div>
          </td>
        </tr>
      `;


  $("#queueRecentBody").innerHTML =
    recentJobs.length
      ? recentJobs
          .map(
            (job) =>
              queueJobRow(
                job,
                queue
              )
          )
          .join("")
      : `
        <tr>
          <td colspan="7">
            <div class="empty queue-empty">
              <h3>
                No completed Queue jobs yet
              </h3>

              <p>
                Completed logical scans will appear here.
              </p>
            </div>
          </td>
        </tr>
      `;


  $("#queueLiveState").innerHTML =
    statusBadge(
      queuePollLabel(
        queue
      ),
      "good"
    );


  $("#queueLastUpdated").textContent =
    queue.at
      ? `Updated ${formatDate(
          queue.at
        )}`
      : "Updated just now";


  const errorBox =
    $("#queuePollError");


  if (errorBox) {
    errorBox.classList.add(
      "hidden"
    );

    errorBox.innerHTML =
      "";
  }
}


function drawQueueRefreshError(
  message
) {
  const box =
    $("#queuePollError");


  if (!box) {
    return;
  }


  box.innerHTML = `
    <div class="scan-notice-main">
      <div class="scan-notice-title">
        Queue refresh failed
      </div>

      <div class="scan-notice-copy">
        ${escapeHtml(
          message
        )}
        The last successfully loaded Queue data remains visible and
        SpeedPulse will retry automatically.
      </div>
    </div>
  `;


  box.classList.remove(
    "hidden"
  );
}


function scheduleQueuePoll(
  generation
) {
  if (
    generation !==
      state.queuePollGeneration ||
    !state.authenticated ||
    location.hash !==
      "#queue"
  ) {
    return;
  }


  if (
    state.queuePollTimer
  ) {
    clearTimeout(
      state.queuePollTimer
    );
  }


  const interval =
    queuePollInterval(
      state.queueData
    );


  state.queuePollTimer =
    setTimeout(
      () => {
        refreshQueueWorkspace(
          generation,
          false
        );
      },
      interval
    );
}


async function refreshQueueWorkspace(
  generation,
  manual = false
) {
  if (
    generation !==
    state.queuePollGeneration
  ) {
    return;
  }


  /*
   * Prevent the 3-second timer and a manual Refresh click from
   * creating overlapping requests for the same Queue generation.
   */
  if (
    state.queuePollBusyGeneration ===
    generation
  ) {
    return;
  }


  state.queuePollBusyGeneration =
    generation;


  const refreshButton =
    $("#queueRefreshButton");


  if (
    refreshButton
  ) {
    refreshButton.disabled =
      true;
  }


  try {
    const data =
      await api(
        "/api/next/queue-workspace?limit=60"
      );


    /*
     * The user may have navigated away while the request was in
     * flight. Never let that old response replace another view.
     */
    if (
      generation !==
        state.queuePollGeneration ||
      location.hash !==
        "#queue"
    ) {
      return;
    }


    const queue =
      data.queue;


    if (
      !queue ||
      !queue.counts ||
      !Array.isArray(
        queue.activeJobs
      ) ||
      !Array.isArray(
        queue.recentJobs
      )
    ) {
      throw new Error(
        "Queue workspace API returned an invalid response."
      );
    }


    state.queueData =
      queue;


    state.queuePollLastError =
      null;


    drawQueueWorkspace(
      queue
    );
  } catch (error) {
    if (
      generation !==
        state.queuePollGeneration ||
      location.hash !==
        "#queue"
    ) {
      return;
    }


    const message =
      error instanceof Error
        ? error.message
        : String(
            error
          );


    state.queuePollLastError =
      message;


    drawQueueRefreshError(
      message
    );


    if (
      manual
    ) {
      toast(
        "Could not refresh Queue data.",
        "error"
      );
    }
  } finally {
    if (
      state.queuePollBusyGeneration ===
      generation
    ) {
      state.queuePollBusyGeneration =
        null;
    }


    if (
      generation ===
        state.queuePollGeneration
    ) {
      const button =
        $("#queueRefreshButton");


      if (
        button
      ) {
        button.disabled =
          false;
      }


      scheduleQueuePoll(
        generation
      );
    }
  }
}


async function renderQueue() {
  /*
   * Invalidate any previous Queue-page lifecycle first.
   */
  stopQueuePolling();


  const generation =
    state.queuePollGeneration;


  state.queueData =
    null;


  state.queuePollLastError =
    null;


  renderQueueShell(
    generation
  );


  await refreshQueueWorkspace(
    generation,
    false
  );
}


/*
 * When the browser tab becomes visible again, refresh quickly.
 *
 * While hidden the normal timer slows to 30 seconds to avoid
 * needlessly consuming D1 requests.
 */
document.addEventListener(
  "visibilitychange",
  () => {
    if (
      !state.authenticated ||
      location.hash !==
        "#queue"
    ) {
      return;
    }


    const generation =
      state.queuePollGeneration;


    if (
      state.queuePollTimer
    ) {
      clearTimeout(
        state.queuePollTimer
      );

      state.queuePollTimer =
        null;
    }


    if (
      document.hidden
    ) {
      scheduleQueuePoll(
        generation
      );
    } else {
      refreshQueueWorkspace(
        generation,
        false
      );
    }
  }
);


'''


insert_before_once(
    "public/app.js",
    "async function renderDashboard() {",
    QUEUE_UI,
    "add full adaptive-polling Queue workspace UI",
    "CHECKPOINT-19: Queue workspace",
)


# ================================================================
# 12. Queue workspace styling.
# ================================================================

QUEUE_CSS = r'''

/*
 * ================================================================
 * CHECKPOINT-19: Queue workspace
 * ================================================================
 */

.queue-summary-cards {
  margin-bottom: 24px;
}

.queue-section-head {
  align-items: flex-end;
}

.queue-head-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.queue-table-wrap {
  width: 100%;
}

.queue-table {
  min-width: 1080px;
}

.queue-table th:nth-child(1) {
  min-width: 245px;
}

.queue-table th:nth-child(6) {
  min-width: 170px;
}

.queue-table th:nth-child(7) {
  min-width: 255px;
}

.queue-row td {
  transition:
    background .12s ease;
}

.queue-row-running td {
  background:
    rgba(255, 250, 235, .24);
}

.queue-row-retrying td {
  background:
    rgba(255, 250, 235, .36);
}

.queue-row-failed td {
  background:
    rgba(254, 243, 242, .22);
}

.queue-site-cell {
  min-width: 0;
}

.queue-site-link,
.queue-project-link {
  text-decoration: none;
}

.queue-site-link {
  color: #1d2939;
}

.queue-site-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.queue-project-link {
  color: #667085;
}

.queue-project-link:hover {
  color: var(--accent);
}

.queue-device {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 760;
  white-space: nowrap;
}

.queue-device.mobile {
  color: #3448a9;
  background: #eef2ff;
  box-shadow:
    inset 0 0 0 1px
    rgba(63,91,217,.08);
}

.queue-device.desktop {
  color: #475467;
  background: #f2f4f7;
  box-shadow:
    inset 0 0 0 1px
    rgba(71,84,103,.06);
}

.queue-trigger {
  color: #344054;
  font-size: 12px;
  font-weight: 720;
}

.queue-attempt {
  display: inline-block;
  min-width: 32px;
  color: #344054;
  font-size: 12px;
  font-weight: 760;
  font-variant-numeric:
    tabular-nums;
}

.queue-time-cell {
  min-width: 170px;
}

.queue-time-main {
  color: #344054;
  font-size: 12px;
  font-weight: 720;
  white-space: nowrap;
}

.queue-time-sub {
  margin-top: 4px;
  color: #98a2b3;
  font-size: 10px;
  line-height: 1.4;
  white-space: nowrap;
}

.queue-error-cell {
  max-width: 360px;
}

.queue-error {
  min-width: 210px;
  max-width: 340px;
}

.queue-error-title {
  color: #475467;
  font-size: 11px;
  font-weight: 680;
  line-height: 1.4;
}

.queue-row-failed .queue-error-title {
  color: var(--bad);
}

.queue-row-retrying .queue-error-title {
  color: var(--warn);
}

.queue-error-class {
  margin-top: 4px;
  color: #98a2b3;
  font-size: 9px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.queue-error-details {
  margin-top: 6px;
}

.queue-error-details summary {
  width: fit-content;
  color: #667085;
  cursor: pointer;
  font-size: 10px;
  font-weight: 680;
  user-select: none;
}

.queue-error-details summary:hover {
  color: #344054;
}

.queue-error-details pre {
  max-width: 330px;
  max-height: 190px;
  margin: 7px 0 0;
  overflow: auto;
  padding: 8px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fafc;
  color: #475467;
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  font-size: 9px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.queue-empty {
  padding-top: 38px;
  padding-bottom: 38px;
}

@media (max-width: 760px) {
  .queue-section-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .queue-head-meta {
    justify-content: flex-start;
  }

  .queue-table {
    min-width: 1020px;
  }
}

'''


insert_before_once(
    "public/styles.css",
    ".project-grid {",
    QUEUE_CSS,
    "add Queue workspace responsive styling",
    "CHECKPOINT-19: Queue workspace",
)


# ================================================================
# 13. Checkpoint-19 regression verifier.
# ================================================================

VERIFY_PATH = (
    ROOT
    / "scripts"
    / "verify-checkpoint-19.mjs"
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
      `CHECKPOINT-19 CHECK FAILED: ${message}`
    );
  }
}


const policy =
  read(
    "src/scan-policy.ts"
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


const html =
  read(
    "public/index.html"
  );


const ui =
  read(
    "public/app.js"
  );


const css =
  read(
    "public/styles.css"
  );


const packageJson =
  JSON.parse(
    read(
      "package.json"
    )
  );


/*
 * ================================================================
 * Shared Queue timing policy
 * ================================================================
 */

check(
  policy.includes(
    "SCAN_QUEUE_RETRY_DELAY_SECONDS"
  ),
  "shared Queue retry-delay constant is missing"
);


check(
  queue.includes(
    "SCAN_QUEUE_RETRY_DELAY_SECONDS"
  ),
  "Queue consumer does not use shared retry-delay policy"
);


check(
  !queue.includes(
    "delaySeconds:\n            120"
  ),
  "literal 120-second Queue retry remains in queue.ts"
);


/*
 * ================================================================
 * Backend Queue workspace
 * ================================================================
 */

check(
  control.includes(
    "export async function getQueueWorkspace"
  ),
  "Queue workspace aggregator is missing"
);


check(
  control.includes(
    "AS waiting_jobs"
  ) &&
  control.includes(
    "AS retrying_jobs"
  ) &&
  control.includes(
    "AS failed_jobs_24h"
  ),
  "exact Queue workspace count queries are incomplete"
);


check(
  control.includes(
    "TRANSIENT_SCAN_ERROR"
  ),
  "retrying logical state is not represented by backend Queue workspace"
);


check(
  control.includes(
    "durationHints"
  ) &&
  control.includes(
    "average_ms"
  ),
  "Queue ETA duration hints are missing"
);


check(
  control.includes(
    "project_id"
  ) &&
  control.includes(
    "site_url"
  ),
  "Queue job rows do not expose site/project navigation information"
);


check(
  index.includes(
    '"/api/next/queue-workspace"'
  ) &&
  index.includes(
    "getQueueWorkspace("
  ),
  "authenticated Queue workspace API route is missing"
);


/*
 * ================================================================
 * Sidebar / routing
 * ================================================================
 */

check(
  html.includes(
    'data-route="#queue"'
  ),
  "Queue sidebar navigation item is missing"
);


check(
  ui.includes(
    'hash ===\n      "#queue"'
  ) &&
  ui.includes(
    "renderQueue()"
  ),
  "main router does not support #queue"
);


/*
 * ================================================================
 * Operational information requested for checkpoint 19
 * ================================================================
 */

check(
  ui.includes(
    '"Running"'
  ) &&
  ui.includes(
    '"Waiting"'
  ) &&
  ui.includes(
    '"Retrying"'
  ) &&
  ui.includes(
    '"Failed 24h"'
  ),
  "Queue summary cards are incomplete"
);


check(
  ui.includes(
    "queueStrategyLabel"
  ) &&
  ui.includes(
    "queueTriggerLabel"
  ) &&
  ui.includes(
    "queueAttemptHtml"
  ),
  "device/trigger/attempt presentation is incomplete"
);


check(
  ui.includes(
    "queueTimingText"
  ) &&
  ui.includes(
    "ETA ~"
  ) &&
  ui.includes(
    "Retry in ~"
  ),
  "elapsed/retry/ETA presentation is incomplete"
);


check(
  ui.includes(
    'href="#site/${siteId}"'
  ),
  "Queue rows do not link back to site pages"
);


check(
  ui.includes(
    'href="#project/${projectId}"'
  ),
  "Queue rows do not link back to project pages"
);


check(
  ui.includes(
    "friendlyScanError"
  ) &&
  ui.includes(
    "queueErrorHtml"
  ),
  "Queue errors are not converted to concise user-facing summaries"
);


/*
 * ================================================================
 * Automatic polling safety
 * ================================================================
 */

check(
  ui.includes(
    "QUEUE_ACTIVE_POLL_MS"
  ) &&
  ui.includes(
    "QUEUE_IDLE_POLL_MS"
  ) &&
  ui.includes(
    "QUEUE_HIDDEN_POLL_MS"
  ),
  "adaptive Queue polling constants are missing"
);


check(
  ui.includes(
    "queuePollGeneration"
  ) &&
  ui.includes(
    "queuePollBusyGeneration"
  ),
  "Queue polling race protection is missing"
);


check(
  ui.includes(
    "stopQueuePolling()"
  ) &&
  ui.includes(
    "scheduleQueuePoll("
  ) &&
  ui.includes(
    "refreshQueueWorkspace("
  ),
  "Queue polling lifecycle is incomplete"
);


check(
  ui.includes(
    'document.addEventListener(\n  "visibilitychange"'
  ),
  "background-tab polling protection is missing"
);


/*
 * ================================================================
 * Styling
 * ================================================================
 */

check(
  css.includes(
    ".queue-table"
  ) &&
  css.includes(
    ".queue-device"
  ) &&
  css.includes(
    ".queue-error-details"
  ) &&
  css.includes(
    ".queue-time-main"
  ),
  "Queue workspace CSS is incomplete"
);


/*
 * ================================================================
 * Validation integration
 * ================================================================
 */

const checkScript =
  packageJson
    .scripts
    ?.check ||
  "";


check(
  checkScript.includes(
    "verify-checkpoint-18.mjs"
  ),
  "Checkpoint-18 verifier disappeared from npm run check"
);


check(
  checkScript.includes(
    "verify-checkpoint-19.mjs"
  ),
  "Checkpoint-19 verifier is not part of npm run check"
);


console.log(
  "Checkpoint-19 Queue workspace regression checks: PASS"
);
'''


VERIFY_PATH.write_text(
    VERIFY_SOURCE,
    encoding="utf-8"
)


print(
    "OK: created scripts/verify-checkpoint-19.mjs"
)


# ================================================================
# 14. Add verifier to npm run check.
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


check_script = (
    scripts.get(
        "check",
        ""
    )
    .strip()
)


verify_command = (
    "node scripts/verify-checkpoint-19.mjs"
)


if (
    verify_command
    not in check_script
):
    if check_script:
        check_script += (
            " && "
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
        "OK: added Checkpoint-19 verifier to npm run check"
    )
else:
    print(
        "SKIP: package.json already runs Checkpoint-19 verifier"
    )


# ================================================================
# Done
# ================================================================

print()
print(
    "============================================================"
)
print(
    "CHECKPOINT-19 SOURCE PATCH COMPLETE"
)
print(
    "============================================================"
)
print()
print(
    "Implemented:"
)
print(
    "  - Queue sidebar route"
)
print(
    "  - exact Running / Waiting / Retrying / Failed-24h counts"
)
print(
    "  - current active logical jobs"
)
print(
    "  - recent completed logical jobs"
)
print(
    "  - site/project/device/trigger/attempt columns"
)
print(
    "  - elapsed time"
)
print(
    "  - approximate run ETA"
)
print(
    "  - retry countdown"
)
print(
    "  - friendly concise Queue errors"
)
print(
    "  - expandable technical errors"
)
print(
    "  - adaptive 3s / 15s / 30s polling"
)
print(
    "  - stale-response / overlapping-poll protection"
)
print(
    "  - shared Queue retry-delay policy"
)
print()
print(
    "No migration was created."
)
print(
    "No deployment was performed."
)
print(
    "No remote database data was modified."
)
print()
print(
    f"Backups: {BACKUP_ROOT}"
)
print()

