const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  authenticated: false,
  projects: [],
  currentProjectId: null,
  currentSiteId: null,
  strategy: "mobile",
  days: "90",
  metric: "performance_score",
  history: [],
  siteData: null,

  /*
   * CHECKPOINT-20 site-level logical scan/report state.
   */
  siteRecentScans: [],
  siteDetailedReports: [],
  siteReportComparison: null,
  sitePanelError: null,
  sitePanelGeneration: 0,

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

const metricConfig = {
  performance_score: { label: "Performance", unit: "", fixed: [0,100], threshold: 90 },
  accessibility_score: { label: "Accessibility", unit: "", fixed: [0,100], threshold: 90 },
  seo_score: { label: "SEO", unit: "", fixed: [0,100], threshold: 90 },
  best_practices_score: { label: "Best Practices", unit: "", fixed: [0,100], threshold: 90 },
  lcp_ms: { label: "Lab LCP", unit: "ms", threshold: 2500 },
  tbt_ms: { label: "Total Blocking Time", unit: "ms", threshold: 200 },
  cls: { label: "Lab CLS", unit: "", threshold: 0.1 },
  field_lcp_ms: { label: "Field LCP (CrUX)", unit: "ms", threshold: 2500 },
  field_inp_ms: { label: "Field INP (CrUX)", unit: "ms", threshold: 200 },
  field_cls: { label: "Field CLS (CrUX)", unit: "", threshold: 0.1 }
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#039;", '"':"&quot;" }[c]));
}

function formatDate(value, withTime = true) {
  if (!value) return "Never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, withTime
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(d);
}

function formatMetric(value, type) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (type === "ms") return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}s` : `${Math.round(n)}ms`;
  if (type === "cls") return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return Math.round(n).toString();
}

function scoreClass(value) {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  return n >= 90 ? "score-good" : n >= 50 ? "score-warn" : "score-bad";
}

function vitalStatus(metric, value) {
  if (value === null || value === undefined) return { label: "No field data", cls: "neutral" };
  const n = Number(value);

  // Custom SpeedPulse Mobile Lab LCP classification only.
  // <= 4s       Good
  // > 4s <= 7s  Poor
  // > 7s        Very Poor
  if (metric === "mobile_lcp") {
    return n <= 4000
      ? { label: "Good", cls: "good" }
      : n <= 7000
        ? { label: "Poor", cls: "warn" }
        : { label: "Very Poor", cls: "bad" };
  }

  const thresholds = metric === "lcp" ? [2500,4000] : metric === "inp" ? [200,500] : [0.1,0.25];
  return n <= thresholds[0] ? { label: "Good", cls: "good" } : n <= thresholds[1] ? { label: "Needs improvement", cls: "warn" } : { label: "Poor", cls: "bad" };
}

function statusBadge(label, cls = "neutral") {
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


function scoreValue(value) {
  if (value === null || value === undefined || value === "") return `<span class="table-score muted">—</span>`;
  return `<span class="table-score ${scoreClass(value)}">${escapeHtml(value)}</span>`;
}

function toast(message, type = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${type === "error" ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
    ...options
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("Your session expired. Sign in again.");
  }
  if (!response.ok) {
    let detail;
    try { detail = await response.json(); } catch { detail = null; }
    throw new Error(detail?.error || `Request failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response;
}

function loading() {
  $("#mainContent").innerHTML = `<div class="loading"><div><div class="spinner"></div><div style="margin-top:12px">Loading…</div></div></div>`;
}

function showLogin(message = "") {
  stopQueuePolling();

  state.authenticated = false;
  $("#appShell").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
  if (message) {
    $("#loginError").textContent = message;
    $("#loginError").classList.remove("hidden");
  }
}

function showApp() {
  state.authenticated = true;
  $("#loginScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
}

function setActiveNav() {
  const hash = location.hash || "#dashboard";
  $$(".nav-item[data-route]").forEach(btn => btn.classList.toggle("active", hash.startsWith(btn.dataset.route)));
}

async function router() {
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


    if (
      hash ===
      "#capacity"
    ) {
      return await renderCapacity();
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


/*
 * ================================================================
 * CHECKPOINT-19: Queue workspace
 * ================================================================
 */

const QUEUE_ACTIVE_POLL_MS =
  3000;


const QUEUE_IDLE_POLL_MS =
  30000;


const QUEUE_HIDDEN_POLL_MS =
  0;


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
    return 0;
  }


  return Number(
    queue
      ?.counts
      ?.runningJobs ||
    0
  ) >
    0
      ? QUEUE_ACTIVE_POLL_MS
      : QUEUE_IDLE_POLL_MS;
}


function queuePollLabel(
  queue
) {
  if (
    document.hidden
  ) {
    return "Paused · tab hidden";
  }

  const interval =
    queuePollInterval(
      queue
    );


  return interval ===
    QUEUE_ACTIVE_POLL_MS
      ? "Live · running every 3s"
      : "Idle · every 30s";
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
      "#queue" ||
    document.hidden
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

  if (!interval || interval <= 0) {
    return;
  }


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
      stopQueuePolling();
    } else {
      if (location.hash === "#queue") {
        refreshQueueWorkspace(
          generation,
          false
        );
      }
    }
  }
);


async function renderCapacity() {
  loading();
  const data = await api("/api/capacity");

  const heartbeat = data.heartbeat || {};
  const isStale = Boolean(heartbeat.isStale);
  const hasEverRun = Boolean(heartbeat.lastCronRunAt);
  const ageMinutes = heartbeat.ageMinutes != null ? `${heartbeat.ageMinutes}m` : null;
  const lastRunText = heartbeat.lastCronRunAt ? formatDate(heartbeat.lastCronRunAt) : "Awaiting first scheduled tick";

  const cronBadge = !hasEverRun
    ? statusBadge("Pending first run", "neutral")
    : isStale
    ? statusBadge(`Stale (${ageMinutes || "unknown"} ago)`, "bad")
    : statusBadge(`Healthy (${ageMinutes || "<1m"} ago)`, "good");

  let warningBanner = "";
  if (isStale) {
    if (!hasEverRun) {
      warningBanner += `
        <div class="card" style="border-left: 4px solid var(--accent); margin-bottom: 20px; background: var(--accent-soft);">
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="color: var(--accent); font-size: 20px; line-height: 1;">ℹ️</div>
            <div>
              <strong style="color: var(--accent-strong);">Cron Heartbeat Warning:</strong> Scheduled cron has not reported its first tick yet.
              <div class="small muted" style="margin-top: 4px; color: #475467;">Scheduled runs will begin automatically according to the cron schedule in wrangler.jsonc. The heartbeat monitor will turn healthy on the first execution.</div>
            </div>
          </div>
        </div>
      `;
    } else {
      warningBanner += `
        <div class="card" style="border-left: 4px solid var(--bad); margin-bottom: 20px; background: #fffbfa;">
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <div style="color: var(--bad); font-size: 20px; line-height: 1;">⚠️</div>
            <div>
              <strong style="color: var(--bad);">Cron Heartbeat Warning:</strong> Scheduled cron has not reported in ${escapeHtml(ageMinutes || "unknown")} (expected &le; 15 minutes).
              <div class="small muted" style="margin-top: 4px;">Verify that Cloudflare Cron Triggers are enabled in wrangler.jsonc and deployed to your Worker.</div>
            </div>
          </div>
        </div>
      `;
    }
  }

  if (data.overallStatus === "paused") {
    warningBanner += `
      <div class="card" style="border-left: 4px solid var(--bad); margin-bottom: 20px; background: #fffbfa;">
        <div style="display: flex; gap: 12px; align-items: flex-start;">
          <div style="color: var(--bad); font-size: 20px; line-height: 1;">🛑</div>
          <div>
            <strong style="color: var(--bad);">Capacity Throttling Active (90% limit reached):</strong>
            <div>${escapeHtml(data.warningMessage || "Scheduled scans are paused until midnight UTC/Pacific quota reset.")}</div>
          </div>
        </div>
      </div>
    `;
  } else if (data.overallStatus === "slowdown") {
    warningBanner += `
      <div class="card" style="border-left: 4px solid var(--warn); margin-bottom: 20px; background: #fffcf5;">
        <div style="display: flex; gap: 12px; align-items: flex-start;">
          <div style="color: var(--warn); font-size: 20px; line-height: 1;">⚡</div>
          <div>
            <strong style="color: var(--warn);">Scheduler Slowdown Notice (70% quota reached):</strong>
            <div>${escapeHtml(data.warningMessage || "Scheduler batch size is reduced by 50% to conserve remaining daily budget.")}</div>
          </div>
        </div>
      </div>
    `;
  }

  const resourceRows = (data.resources || []).map((res) => {
    const tone = res.status === "blocked" || res.status === "paused" ? "bad" : res.status === "slowdown" ? "warn" : "good";
    const statusLabel = res.status === "blocked" ? "95% Blocked" : res.status === "paused" ? "90% Paused" : res.status === "slowdown" ? "70% Slowdown" : "Normal";
    const barColor = res.percentage >= 90 ? "var(--bad)" : res.percentage >= 70 ? "var(--warn)" : "var(--good)";

    return `
      <tr>
        <td>
          <div style="font-weight: 600;">${escapeHtml(res.name)}</div>
          <div class="small muted">${escapeHtml(res.resetsDescription)} · Day key: ${escapeHtml(res.dayKey)}</div>
        </td>
        <td style="min-width: 140px;">
          <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
            <span>${escapeHtml(res.used.toLocaleString())} / ${escapeHtml(res.limit.toLocaleString())}</span>
            <span>${escapeHtml(res.percentage)}%</span>
          </div>
          <div style="background: #e4e7ec; border-radius: 999px; height: 6px; overflow: hidden; width: 100%;">
            <div style="background: ${barColor}; height: 100%; width: ${Math.min(100, res.percentage)}%; border-radius: 999px;"></div>
          </div>
        </td>
        <td style="text-align: right; font-variant-numeric: tabular-nums;">${escapeHtml(res.remaining.toLocaleString())}</td>
        <td>${statusBadge(statusLabel, tone)}</td>
      </tr>
    `;
  }).join("");

  const storage = data.storage || {};
  const storageMb = (storage.reportsBytes / (1024 * 1024)).toFixed(1);
  const storageLimitMb = (storage.d1LimitBytes / (1024 * 1024)).toFixed(0);
  const fleet = data.fleet || {};

  $("#mainContent").innerHTML = `
    <div class="page-head">
      <div>
        <span class="eyebrow">Resource Management</span>
        <h1>Capacity & Quotas</h1>
        <p>Live usage vs free tier limits from the real-time quota ledger, cron heartbeat, and storage headroom.</p>
      </div>
      <div>
        <button class="button subtle" onclick="renderCapacity()">Refresh</button>
      </div>
    </div>

    ${warningBanner}

    <div class="grid col-2" style="margin-bottom: 24px;">
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);">Cron Heartbeat</span>
          ${cronBadge}
        </div>
        <div style="font-size: 24px; font-weight: 800; color: #101828; margin-bottom: 4px;">
          ${!hasEverRun ? `<span style="color: var(--muted); font-size: 19px; font-weight: 700;">Awaiting first tick</span>` : isStale ? `<span style="color: var(--bad);">${escapeHtml(ageMinutes || "unknown")} old</span>` : `<span style="color: var(--good);">${escapeHtml(ageMinutes || "<1m")} ago</span>`}
        </div>
        <div class="small muted">Last cron tick: ${escapeHtml(lastRunText)}</div>
        <div class="small muted" style="margin-top: 8px;">Threshold: flags warning badge if elapsed time exceeds 15 minutes.</div>
      </div>

      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);">Report Storage</span>
          ${statusBadge(String(storage.backend || "d1").toUpperCase(), "neutral")}
        </div>
        <div style="font-size: 24px; font-weight: 800; color: #101828; margin-bottom: 4px;">
          ${storageMb} MB <span style="font-size: 14px; font-weight: 500; color: var(--muted);">/ ${storageLimitMb} MB (${escapeHtml(storage.percentage)}%)</span>
        </div>
        <div class="small muted">Retaining ${escapeHtml(storage.reportsCount)} compact reports across ${escapeHtml(fleet.activeSites)} sites.</div>
        <div class="small muted" style="margin-top: 8px;">Policy: 2 newest reports per site/strategy; raw data pruned at 90 days.</div>
      </div>
    </div>

    <div class="section-head">
      <div>
        <h2>Daily Quota Ledger</h2>
        <div class="table-subtext">Real-time atomic usage tracked across dual UTC and Pacific midnight reset boundaries.</div>
      </div>
    </div>

    <div class="card table-wrap" style="margin-bottom: 24px;">
      <table>
        <thead>
          <tr>
            <th>Resource</th>
            <th>Usage vs Daily Limit</th>
            <th style="text-align: right;">Remaining</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${resourceRows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 8px;">Safe Free-Tier Capacity Assessment</h3>
      <p class="small muted" style="margin-bottom: 12px;">
        SpeedPulse is running in <strong>Zero-Cost / No Credit Card</strong> mode on Cloudflare Free plan.
      </p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; font-size: 13px;">
        <div style="padding: 12px; background: #f8fafc; border-radius: 8px;">
          <div style="color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 700;">Active Fleet</div>
          <div style="font-size: 18px; font-weight: 700; margin-top: 2px;">${escapeHtml(fleet.activeSites)} sites</div>
          <div class="small muted">~${escapeHtml(fleet.estimatedDailyScans)} scans/day (mobile + desktop)</div>
        </div>
        <div style="padding: 12px; background: #f8fafc; border-radius: 8px;">
          <div style="color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 700;">Safe Free Capacity</div>
          <div style="font-size: 18px; font-weight: 700; margin-top: 2px;">500 sites</div>
          <div class="small muted">with D1 storage and filtered PSI payloads</div>
        </div>
        <div style="padding: 12px; background: #f8fafc; border-radius: 8px;">
          <div style="color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 700;">Throttling Policy</div>
          <div style="font-size: 14px; font-weight: 600; margin-top: 4px;">70% half batch · 90% pause</div>
          <div class="small muted">Guarantees zero budget overruns</div>
        </div>
      </div>
    </div>
  `;
}
window.renderCapacity = renderCapacity;


async function renderDashboard() {
  loading();
  const data = await api("/api/dashboard");
  const attentionCount = Number(data.attentionCount ?? data.attention.length);
  const attentionRows = data.attention.length ? data.attention.map(site => {
    let issue = "Mobile LCP needs attention";
    if (site.lcp_ms > 7000) {
      issue = `Mobile LCP ${formatMetric(site.lcp_ms, "ms")} · Very Poor`;
    } else if (site.lcp_ms > 4000) {
      issue = `Mobile LCP ${formatMetric(site.lcp_ms, "ms")} · Poor`;
    }
    return `<tr class="click-row" data-site-id="${site.id}"><td><div class="site-name">${escapeHtml(site.name)}</div><div class="site-url">${escapeHtml(site.project_name)} · ${escapeHtml(site.url)}</div></td><td>${escapeHtml(issue)}</td><td>${site.lcp_ms > 7000 ? statusBadge("Very Poor","bad") : statusBadge("Poor","warn")}</td></tr>`;
  }).join("") : `<tr><td colspan="3"><div class="empty"><h3>Everything looks calm</h3><p>No monitored sites currently match the attention rules.</p></div></td></tr>`;

  const apiKeyBanner = !data.apiConfigured ? `
    <div class="api-key-banner" id="apiKeyAlertBanner">
      <div class="api-key-banner-main">
        <div class="api-key-banner-icon">⚡</div>
        <div>
          <div class="api-key-banner-title">Google PageSpeed API Key Not Configured</div>
          <div class="api-key-banner-copy">SpeedPulse requires a Google PageSpeed API key to run performance scans. You can add one directly in Settings without touching the command line.</div>
        </div>
      </div>
      <button class="api-key-banner-btn" id="bannerSetupApiKeyBtn">Configure Key</button>
    </div>` : "";

  $("#mainContent").innerHTML = `
    <div class="page-head"><div><span class="eyebrow">Overview</span><h1>Website health</h1><p>Latest mobile monitoring results across all projects.</p></div><div class="page-actions"><button class="button primary" id="newProjectBtn">+ New project</button></div></div>
    ${apiKeyBanner}
    <div class="cards">
      ${metricCard("Projects", data.projectCount, "Collections of monitored sites")}
      ${metricCard("Active sites", data.siteCount, "Currently enabled")}
      ${metricCard("Tests today", data.testsToday, "Successful scheduled + manual runs")}
      ${metricCard("Needs attention", attentionCount, "Sites with Mobile LCP above 4s", attentionCount ? "score-warn" : "score-good")}
    </div>
    <section class="section"><div class="section-head"><h2>Needs attention</h2><button class="button ghost small" data-route-go="#projects">View projects</button></div><div class="card table-wrap"><table><thead><tr><th>Site</th><th>Signal</th><th>Status</th></tr></thead><tbody>${attentionRows}</tbody></table></div></section>`;

  $("#newProjectBtn").onclick = openProjectModal;
  if ($("#bannerSetupApiKeyBtn")) {
    $("#bannerSetupApiKeyBtn").onclick = openSettings;
  }
  $$('[data-route-go]').forEach(b => b.onclick = () => location.hash = b.dataset.routeGo);
  $$('[data-site-id]').forEach(row => row.onclick = () => location.hash = `#site/${row.dataset.siteId}`);
}

function metricCard(label, value, meta, valueClass = "") {
  return `<div class="card metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value ${valueClass}">${escapeHtml(value)}</div><div class="metric-meta">${escapeHtml(meta)}</div></div>`;
}

async function renderProjects() {
  loading();
  const data = await api("/api/projects");
  state.projects = data.projects;
  const cards = data.projects.length ? data.projects.map(p => `
    <div class="card project-card" data-project-id="${p.id}">
      <h3>${escapeHtml(p.name)}</h3>
      <p class="muted small">${escapeHtml(p.description || "No description")}</p>
      <div class="project-stats"><span><strong>${p.site_count || 0}</strong>Monitored sites</span><span class="project-card-link">Open project</span></div>
    </div>`).join("") : `<div class="card empty" style="grid-column:1/-1"><h3>Create your first project</h3><p>Projects keep client or website groups separate.</p><button class="button primary" id="emptyNewProject">Create project</button></div>`;
  $("#mainContent").innerHTML = `<div class="page-head"><div><span class="eyebrow">Library</span><h1>Projects</h1><p>Group sites, monitor them together, and compare their latest scores.</p></div><div class="page-actions"><button class="button primary" id="newProjectBtn">+ New project</button></div></div><div class="project-grid">${cards}</div>`;
  $("#newProjectBtn").onclick = openProjectModal;
  if ($("#emptyNewProject")) $("#emptyNewProject").onclick = openProjectModal;
  $$('[data-project-id]').forEach(card => card.onclick = () => location.hash = `#project/${card.dataset.projectId}`);
}

async function renderProject(projectId) {
  loading();
  state.currentProjectId = projectId;
  const data = await api(`/api/projects/${projectId}/sites`);
  const rows = data.sites.length ? data.sites.map(site => {
    const lcp = vitalStatus("mobile_lcp", site.mobile_lcp_ms);
    const runStatus = !site.active
      ? statusBadge("Paused", "neutral")
      : site.mobile_last_status === "failed"
        ? statusBadge("Failed", "bad")
        : site.mobile_recorded_at
          ? statusBadge("Monitored", "good")
          : statusBadge("Pending", "neutral");
    const lastRun = site.mobile_recorded_at ? `Last mobile ${formatDate(site.mobile_recorded_at)}` : "Waiting for first mobile test";
    const lcpClass = lcp.cls === "good" ? "score-good" : lcp.cls === "bad" ? "score-bad" : lcp.cls === "warn" ? "score-warn" : "muted";
    return `<tr class="click-row" data-site-id="${site.id}">
      <td><div class="site-name">${escapeHtml(site.name)}</div><div class="site-url">${escapeHtml(site.url)}</div></td>
      <td>${scoreValue(site.mobile_performance)}</td>
      <td>${scoreValue(site.desktop_performance)}</td>
      <td><div class="table-metric">${formatMetric(site.mobile_lcp_ms,"ms")}</div><div class="table-subtext ${lcpClass}">${site.mobile_lcp_ms == null ? "No mobile LCP yet" : lcp.label}</div></td>
      <td>${runStatus}<div class="table-subtext">${escapeHtml(lastRun)}</div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="5"><div class="empty"><h3>No sites yet</h3><p>Add a site manually or import a CSV.</p></div></td></tr>`;

  $("#mainContent").innerHTML = `
    <div class="page-head"><div><span class="eyebrow">Project</span><h1>${escapeHtml(data.project.name)}</h1><p>${escapeHtml(data.project.description || `${data.sites.length} monitored sites`)}</p></div>
      <div class="page-actions"><button class="button" id="importCsvBtn">Import CSV</button><button class="button" id="addSiteBtn">+ Add site</button><button class="button primary" id="queueMobileBtn">Queue mobile tests</button></div></div>
    <div class="card toolbar-panel"><div class="toolbar"><input class="search" id="siteSearch" placeholder="Search sites…" aria-label="Search sites"><span class="toolbar-summary">${data.sites.length} sites · scheduler checks every 5 minutes</span></div></div>
    <div class="card table-wrap"><table id="sitesTable"><thead><tr><th>Site</th><th>Mobile score</th><th>Desktop score</th><th>Mobile LCP</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  $("#addSiteBtn").onclick = () => openAddSiteModal(projectId);
  $("#importCsvBtn").onclick = () => openCsvModal(projectId);
  $("#queueMobileBtn").onclick = async () => {
    try {
      const result = await api(`/api/projects/${projectId}/queue`, { method: "POST", body: JSON.stringify({ strategy: "mobile" }) });
      toast(`${result.queued} mobile tests queued for scheduled processing.`);
    } catch (e) { toast(e.message, "error"); }
  };
  $("#siteSearch").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$("#sitesTable tbody tr[data-site-id]").forEach(row => row.classList.toggle("hidden", !row.textContent.toLowerCase().includes(q)));
  };
  $$('[data-site-id]').forEach(row => row.onclick = () => location.hash = `#site/${row.dataset.siteId}`);
}

async function renderSite(siteId) {
  loading();


  state.currentSiteId =
    siteId;


  /*
   * Do not let data from the previously-open site remain visible if
   * this site has no scan/report history.
   */
  state.siteRecentScans =
    [];


  state.siteDetailedReports =
    [];


  state.siteReportComparison =
    null;


  state.sitePanelError =
    null;


  const data =
    await api(
      `/api/sites/${siteId}`
    );


  state.siteData =
    data;


  await Promise.all([
    loadHistory(
      siteId,
      false
    ),

    loadSiteOperationalPanels(
      siteId,
      false
    )
  ]);


  drawSitePage();
}

async function loadHistory(siteId, redraw = true) {
  const data = await api(`/api/sites/${siteId}/history?strategy=${state.strategy}&days=${state.days}`);
  state.history = data.history;
  if (redraw) drawChart();
}


/*
 * ================================================================
 * CHECKPOINT-20: site recent scans + detailed Lighthouse reports
 * ================================================================
 */

const SITE_REPORT_METRICS = [
  [
    "Performance",
    "performance_score",
    "score"
  ],

  [
    "Accessibility",
    "accessibility_score",
    "score"
  ],

  [
    "SEO",
    "seo_score",
    "score"
  ],

  [
    "Best Practices",
    "best_practices_score",
    "score"
  ],

  [
    "LCP",
    "lcp_ms",
    "ms"
  ],

  [
    "TBT",
    "tbt_ms",
    "ms"
  ],

  [
    "CLS",
    "cls",
    "cls"
  ]
];


function siteReportBytes(
  value
) {
  const bytes =
    Number(
      value ||
      0
    );


  if (
    !Number.isFinite(
      bytes
    ) ||
    bytes <= 0
  ) {
    return "0 B";
  }


  if (
    bytes >=
    1024 * 1024
  ) {
    return `${
      (
        bytes /
        (
          1024 *
          1024
        )
      ).toFixed(
        2
      )
    } MB`;
  }


  if (
    bytes >=
    1024
  ) {
    return `${
      (
        bytes /
        1024
      ).toFixed(
        1
      )
    } KB`;
  }


  return `${Math.round(
    bytes
  )} B`;
}


function siteReportMetricValue(
  value,
  kind
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "—";
  }


  const number =
    Number(
      value
    );


  if (
    !Number.isFinite(
      number
    )
  ) {
    return "—";
  }


  if (
    kind ===
    "ms"
  ) {
    return formatMetric(
      number,
      "ms"
    );
  }


  if (
    kind ===
    "cls"
  ) {
    return number
      .toFixed(
        3
      )
      .replace(
        /0+$/,
        ""
      )
      .replace(
        /\.$/,
        ""
      );
  }


  return String(
    Math.round(
      number
    )
  );
}


function siteReportDeltaText(
  value,
  kind
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "No comparison";
  }


  const number =
    Number(
      value
    );


  if (
    !Number.isFinite(
      number
    )
  ) {
    return "No comparison";
  }


  if (
    number ===
    0
  ) {
    return "No change";
  }


  const sign =
    number >
    0
      ? "+"
      : "";


  if (
    kind ===
    "ms"
  ) {
    return `${sign}${Math.round(
      number
    )}ms vs previous`;
  }


  if (
    kind ===
    "cls"
  ) {
    return `${sign}${number.toFixed(
      3
    )} vs previous`;
  }


  return `${sign}${Math.round(
    number
  )} vs previous`;
}


function siteReportDeltaClass(
  value,
  kind
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "neutral";
  }


  const number =
    Number(
      value
    );


  if (
    !Number.isFinite(
      number
    ) ||
    number ===
    0
  ) {
    return "neutral";
  }


  /*
   * Lighthouse category scores improve when they increase.
   * Timing/CLS metrics improve when they decrease.
   */
  const improved =
    kind ===
    "score"
      ? number > 0
      : number < 0;


  return improved
    ? "good"
    : "bad";
}


function logicalScanDuration(
  job
) {
  if (!job) {
    return "—";
  }


  const start =
    queueDateMs(
      job.created_at
    );


  const status =
    queueEffectiveStatus(
      job
    );


  const finish =
    [
      "success",
      "failed",
      "cancelled"
    ].includes(
      status
    )
      ? queueDateMs(
          job.completed_at
        )
      : Date.now();


  if (
    start ===
      null ||
    finish ===
      null
  ) {
    return "—";
  }


  return formatCompactDuration(
    Math.max(
      0,
      finish -
      start
    )
  );
}


function logicalScanAttemptText(
  job
) {
  const attempt =
    Number(
      job?.attempt ||
      0
    );


  if (
    attempt <= 0
  ) {
    return "Not started";
  }


  return `${Math.min(
    attempt,
    3
  )}/3`;
}


function logicalScanErrorHtml(
  job
) {
  if (
    !job?.error_message
  ) {
    return "";
  }


  const friendly =
    friendlyScanError(
      job.error_class,
      job.error_message
    );


  return `
    <details class="recent-scan-error">
      <summary>
        ${escapeHtml(
          friendly.title
        )}
      </summary>

      <div class="recent-scan-error-copy">
        ${escapeHtml(
          friendly.detail
        )}
      </div>

      <pre>${escapeHtml(
        job.error_message
      )}</pre>
    </details>
  `;
}


function recentScanDetailsHtml(
  job
) {
  const status =
    queueEffectiveStatus(
      job
    );


  const reportId =
    Number(
      job.detailed_report_id
    );


  if (
    status ===
      "success" &&
    Number.isInteger(
      reportId
    ) &&
    reportId > 0
  ) {
    return `
      <div class="recent-scan-actions">
        <a
          class="button small"
          href="/api/next/reports/${reportId}/json"
          target="_blank"
          rel="noopener noreferrer"
        >
          Detailed JSON
        </a>

        <button
          class="button ghost small"
          type="button"
          data-focus-report-panel
        >
          Compare
        </button>
      </div>
    `;
  }


  if (
    status ===
    "success"
  ) {
    return `
      <span class="muted small">
        No retained detailed report
      </span>
    `;
  }


  if (
    [
      "running",
      "retrying",
      "pending",
      "queued"
    ].includes(
      status
    )
  ) {
    return `
      <span class="muted small">
        Scan still in progress
      </span>
    `;
  }


  if (
    job.error_message
  ) {
    return logicalScanErrorHtml(
      job
    );
  }


  return `
    <span class="muted small">
      —
    </span>
  `;
}


function renderRecentLogicalScansSection(
  site
) {
  const rows =
    Array.isArray(
      state.siteRecentScans
    )
      ? state.siteRecentScans
      : [];


  const device =
    state.strategy ===
    "desktop"
      ? "Desktop"
      : "Mobile";


  const body =
    rows.length
      ? rows
          .map(
            (
              job,
              index
            ) => {
              const status =
                queueEffectiveStatus(
                  job
                );


              const happenedAt =
                job.completed_at ||
                job.created_at;


              return `
                <tr class="recent-logical-scan-row">
                  <td>
                    <div class="recent-scan-position">
                      ${
                        index === 0
                          ? "Latest"
                          : "Previous"
                      }
                    </div>

                    <div class="table-subtext">
                      ${escapeHtml(
                        formatDate(
                          happenedAt
                        )
                      )}
                    </div>
                  </td>

                  <td>
                    ${queueStatusBadge(
                      job
                    )}

                    ${
                      logicalScanErrorHtml(
                        job
                      )
                    }
                  </td>

                  <td>
                    <div class="table-metric">
                      ${escapeHtml(
                        queueTriggerLabel(
                          job.trigger
                        )
                      )}
                    </div>

                    <div class="table-subtext">
                      Logical job #${escapeHtml(
                        job.id
                      )}
                    </div>
                  </td>

                  <td>
                    <div class="table-metric">
                      ${escapeHtml(
                        logicalScanAttemptText(
                          job
                        )
                      )}
                    </div>

                    <div class="table-subtext">
                      ${
                        Number(
                          job.attempt ||
                          0
                        ) > 1
                          ? "Provider retries included"
                          : status === "success"
                            ? "Completed first attempt"
                            : "Provider attempts"
                      }
                    </div>
                  </td>

                  <td>
                    <div class="table-metric">
                      ${escapeHtml(
                        logicalScanDuration(
                          job
                        )
                      )}
                    </div>

                    <div class="table-subtext">
                      Created → ${
                        [
                          "success",
                          "failed",
                          "cancelled"
                        ].includes(
                          status
                        )
                          ? "completed"
                          : "now"
                      }
                    </div>
                  </td>

                  <td>
                    ${recentScanDetailsHtml(
                      job
                    )}
                  </td>
                </tr>
              `;
            }
          )
          .join("")
      : `
        <tr>
          <td colspan="6">
            <div class="empty recent-scans-empty">
              <h3>
                No ${escapeHtml(
                  device.toLowerCase()
                )} logical scans yet
              </h3>

              <p>
                Run a test or wait for scheduled monitoring.
              </p>
            </div>
          </td>
        </tr>
      `;


  return `
    <section class="section">
      <div class="section-head recent-scans-head">
        <div>
          <h2>
            Recent scans · ${escapeHtml(
              device
            )}
          </h2>

          <div class="table-subtext">
            Latest two logical scan jobs.
            Automatic provider retries remain inside one row.
          </div>
        </div>

        <span class="status neutral">
          <span class="dot"></span>
          scan_jobs
        </span>
      </div>

      <div class="card table-wrap">
        <table class="recent-scans-table">
          <thead>
            <tr>
              <th>Scan</th>
              <th>Result</th>
              <th>Source</th>
              <th>Attempts</th>
              <th>Duration</th>
              <th>Details</th>
            </tr>
          </thead>

          <tbody>
            ${body}
          </tbody>
        </table>
      </div>
    </section>
  `;
}


function renderDetailedReportMetricGrid(
  comparison
) {
  const latest =
    comparison?.latest;


  if (!latest) {
    return "";
  }


  const previous =
    comparison?.previous;


  const deltas =
    comparison?.deltas ||
    {};


  return `
    <div class="site-report-metric-grid">
      ${
        SITE_REPORT_METRICS
          .map(
            (
              [
                label,
                key,
                kind
              ]
            ) => {
              const delta =
                deltas[
                  key
                ];


              return `
                <div class="site-report-metric">
                  <div class="metric-label">
                    ${escapeHtml(
                      label
                    )}
                  </div>

                  <div class="site-report-metric-value">
                    ${escapeHtml(
                      siteReportMetricValue(
                        latest[
                          key
                        ],
                        kind
                      )
                    )}
                  </div>

                  <div
                    class="site-report-delta ${
                      siteReportDeltaClass(
                        delta,
                        kind
                      )
                    }"
                  >
                    ${
                      previous
                        ? escapeHtml(
                            siteReportDeltaText(
                              delta,
                              kind
                            )
                          )
                        : "First retained report"
                    }
                  </div>
                </div>
              `;
            }
          )
          .join("")
      }
    </div>
  `;
}


function renderDetailedReportCards(
  reports
) {
  if (
    !Array.isArray(
      reports
    ) ||
    reports.length ===
      0
  ) {
    return "";
  }


  return `
    <div class="site-report-list">
      ${
        reports
          .map(
            (
              report,
              index
            ) => `
              <div class="site-report-item">
                <div class="site-report-item-main">
                  <div>
                    <div class="site-report-label">
                      ${
                        index === 0
                          ? "Latest retained report"
                          : "Previous retained report"
                      }
                    </div>

                    <div class="site-report-meta">
                      ${escapeHtml(
                        formatDate(
                          report.captured_at
                        )
                      )}
                      · ${escapeHtml(
                        siteReportBytes(
                          report.size_bytes
                        )
                      )}
                      · Lighthouse ${escapeHtml(
                        report.lighthouse_version ||
                        "unknown"
                      )}
                      · ${escapeHtml(
                        report.detail_level ||
                        "report"
                      )}
                    </div>
                  </div>

                  <a
                    class="button small"
                    href="/api/next/reports/${Number(
                      report.id
                    )}/json"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Detailed JSON
                  </a>
                </div>

                <div class="site-report-score-line">
                  <span>
                    Perf
                    <strong>
                      ${escapeHtml(
                        report.performance_score ??
                        "—"
                      )}
                    </strong>
                  </span>

                  <span>
                    A11y
                    <strong>
                      ${escapeHtml(
                        report.accessibility_score ??
                        "—"
                      )}
                    </strong>
                  </span>

                  <span>
                    SEO
                    <strong>
                      ${escapeHtml(
                        report.seo_score ??
                        "—"
                      )}
                    </strong>
                  </span>

                  <span>
                    Best
                    <strong>
                      ${escapeHtml(
                        report.best_practices_score ??
                        "—"
                      )}
                    </strong>
                  </span>
                </div>
              </div>
            `
          )
          .join("")
      }
    </div>
  `;
}


function renderSiteDetailedReportsSection(
  site
) {
  const device =
    state.strategy ===
    "desktop"
      ? "Desktop"
      : "Mobile";


  const reports =
    Array.isArray(
      state.siteDetailedReports
    )
      ? state.siteDetailedReports
      : [];


  const comparison =
    state.siteReportComparison;


  const latest =
    comparison?.latest ||
    reports[
      0
    ] ||
    null;


  const previous =
    comparison?.previous ||
    reports[
      1
    ] ||
    null;


  const errorHtml =
    state.sitePanelError
      ? `
        <div class="scan-notice warn site-report-warning">
          <div class="scan-notice-main">
            <div class="scan-notice-title">
              Some scan detail could not be loaded
            </div>

            <div class="scan-notice-copy">
              ${escapeHtml(
                state.sitePanelError
              )}
            </div>
          </div>
        </div>
      `
      : "";


  if (
    reports.length ===
      0 &&
    !latest
  ) {
    return `
      <section
        class="section site-detailed-reports"
        id="siteDetailedReports"
      >
        <div class="section-head">
          <div>
            <h2>
              Detailed Lighthouse reports · ${escapeHtml(
                device
              )}
            </h2>

            <div class="table-subtext">
              The newest two successful detailed reports are retained.
            </div>
          </div>
        </div>

        ${errorHtml}

        <div class="card empty site-report-empty">
          <h3>
            No retained detailed report yet
          </h3>

          <p>
            A successful ${escapeHtml(
              device.toLowerCase()
            )} scan will create the first retained report when detailed reports are enabled.
          </p>
        </div>
      </section>
    `;
  }


  return `
    <section
      class="section site-detailed-reports"
      id="siteDetailedReports"
    >
      <div class="section-head site-reports-head">
        <div>
          <h2>
            Detailed Lighthouse reports · ${escapeHtml(
              device
            )}
          </h2>

          <div class="table-subtext">
            Newest two successful retained reports.
            Failed logical scans remain visible above but do not replace these successful reports.
          </div>
        </div>

        ${
          latest
            ? `
              <span class="status good">
                <span class="dot"></span>
                ${
                  previous
                    ? "Comparison ready"
                    : "1 retained report"
                }
              </span>
            `
            : ""
        }
      </div>

      ${errorHtml}

      <div class="card site-report-comparison-card">
        <div class="site-report-comparison-head">
          <div>
            <div class="site-report-comparison-title">
              ${
                previous
                  ? "Latest vs previous retained success"
                  : "Latest retained success"
              }
            </div>

            <div class="site-report-comparison-sub">
              ${
                latest
                  ? `Latest · ${escapeHtml(
                      formatDate(
                        latest.captured_at
                      )
                    )}`
                  : ""
              }

              ${
                previous
                  ? ` · Previous · ${escapeHtml(
                      formatDate(
                        previous.captured_at
                      )
                    )}`
                  : " · A second successful scan will enable comparison."
              }
            </div>
          </div>

          ${
            latest
              ? `
                <a
                  class="button small"
                  href="/api/next/reports/${Number(
                    latest.id
                  )}/json"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open latest JSON
                </a>
              `
              : ""
          }
        </div>

        ${
          renderDetailedReportMetricGrid(
            comparison ||
            {
              latest,
              previous,
              deltas:
                {}
            }
          )
        }
      </div>

      ${
        renderDetailedReportCards(
          reports
        )
      }
    </section>
  `;
}


async function loadSiteOperationalPanels(
  siteId,
  redraw = true
) {
  const generation =
    ++state.sitePanelGeneration;


  const strategyAtStart =
    state.strategy;


  const encodedStrategy =
    encodeURIComponent(
      strategyAtStart
    );


  const [
    scansResult,
    reportsResult,
    comparisonResult
  ] =
    await Promise.allSettled([
      api(
        `/api/sites/${siteId}/recent-scans?strategy=${encodedStrategy}`
      ),

      api(
        `/api/next/sites/${siteId}/reports?strategy=${encodedStrategy}`
      ),

      api(
        `/api/next/sites/${siteId}/report-comparison?strategy=${encodedStrategy}`
      )
    ]);


  /*
   * Strategy may have changed while these requests were in flight.
   * Never paint stale Mobile data into Desktop or vice versa.
   */
  if (
    generation !==
      state.sitePanelGeneration ||
    state.currentSiteId !==
      siteId ||
    state.strategy !==
      strategyAtStart
  ) {
    return;
  }


  const errors =
    [];


  if (
    scansResult.status ===
    "fulfilled"
  ) {
    state.siteRecentScans =
      Array.isArray(
        scansResult.value
          ?.scans
      )
        ? scansResult.value.scans
        : [];
  } else {
    state.siteRecentScans =
      [];

    errors.push(
      `Recent scans: ${
        scansResult.reason instanceof Error
          ? scansResult.reason.message
          : String(
              scansResult.reason
            )
      }`
    );
  }


  if (
    reportsResult.status ===
    "fulfilled"
  ) {
    state.siteDetailedReports =
      Array.isArray(
        reportsResult.value
          ?.reports
      )
        ? reportsResult.value.reports
        : [];
  } else {
    state.siteDetailedReports =
      [];

    errors.push(
      `Detailed reports: ${
        reportsResult.reason instanceof Error
          ? reportsResult.reason.message
          : String(
              reportsResult.reason
            )
      }`
    );
  }


  if (
    comparisonResult.status ===
    "fulfilled"
  ) {
    state.siteReportComparison =
      comparisonResult.value
        ?.comparison ||
      null;
  } else {
    state.siteReportComparison =
      null;

    errors.push(
      `Report comparison: ${
        comparisonResult.reason instanceof Error
          ? comparisonResult.reason.message
          : String(
              comparisonResult.reason
            )
      }`
    );
  }


  state.sitePanelError =
    errors.length
      ? errors.join(
          " · "
        )
      : null;


  if (
    redraw
  ) {
    drawSitePage();
  }
}


/*
 * CHECKPOINT-20: safe collection helper
 *
 * Defensive wrapper for dynamically created DOM collections.
 * Some browsers return NodeList objects while some custom helpers
 * returned single elements during early Checkpoint-20 rendering.
 */
function safeForEach(
  value,
  callback
) {
  if (
    !value
  ) {
    return;
  }


  const list =
    Array.isArray(
      value
    )
      ? value
      : Array.from(
          value
        );


  list.forEach(
    callback
  );
}


function latestFor(strategyName) {
  return state.siteData?.latest?.find(x => x.strategy === strategyName) || null;
}

function drawSitePage() {
  const { site, annotations } = state.siteData;
  const latest = latestFor(state.strategy);
  const lcpStatus = vitalStatus("lcp", latest?.field_lcp_ms);
  const inpStatus = vitalStatus("inp", latest?.field_inp_ms);
  const clsStatus = vitalStatus("cls", latest?.field_cls);
  const lastStatus = state.strategy === "mobile" ? site.mobile_last_status : site.desktop_last_status;
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


  const annotationsHtml = annotations.length ? annotations.map(a => `<div class="annotation"><time>${formatDate(a.created_at)}</time>${escapeHtml(a.note)}</div>`).join("") : `<p class="muted small">No optimization notes yet.</p>`;

  $("#mainContent").innerHTML = `
    <div class="page-head"><div><span class="eyebrow"><a href="#project/${site.project_id}">${escapeHtml(site.project_name)}</a></span><h1>${escapeHtml(site.name)}</h1><p><a href="${escapeHtml(site.url)}" target="_blank" rel="noopener">${escapeHtml(site.url)}</a></p></div>
      <div class="page-actions"><a class="button" href="/api/sites/${site.id}/export?strategy=${state.strategy}">Export CSV</a><button class="button" id="runDesktop">Run desktop</button><button class="button primary" id="runMobile">Run mobile</button></div></div>
    <div class="site-status-row"><div class="strategy-switch"><button class="pill ${state.strategy === "mobile" ? "active" : ""}" data-strategy="mobile">Mobile</button><button class="pill ${state.strategy === "desktop" ? "active" : ""}" data-strategy="desktop">Desktop</button></div><div>${scanStatus}</div></div>
    ${scanNotice}
    <div class="score-grid">
      ${scoreBox("Performance", latest?.performance_score)}${scoreBox("Accessibility", latest?.accessibility_score)}${scoreBox("SEO", latest?.seo_score)}${scoreBox("Best Practices", latest?.best_practices_score)}
    </div>
    <section class="section"><div class="section-head"><h2>Core Web Vitals · real users</h2><span class="muted small">CrUX origin-level p75 · 28-day rolling field data</span></div>
      <div class="vitals-grid">${vitalBox("LCP", latest?.field_lcp_ms, "ms", lcpStatus)}${vitalBox("INP", latest?.field_inp_ms, "ms", inpStatus)}${vitalBox("CLS", latest?.field_cls, "cls", clsStatus)}</div>
    </section>
    ${renderRecentLogicalScansSection(site)}
    ${renderSiteDetailedReportsSection(site)}
    <section class="section"><div class="section-head"><h2>History</h2></div><div class="card chart-card">
      <div class="chart-toolbar"><div class="metric-switch">${["performance_score","accessibility_score","seo_score","best_practices_score","field_lcp_ms","field_inp_ms","field_cls","lcp_ms","tbt_ms","cls"].map(k => `<button class="pill ${state.metric === k ? "active" : ""}" data-metric="${k}">${metricConfig[k].label}</button>`).join("")}</div>
      <div class="range-switch">${["7","30","90","365","all"].map(d => `<button class="pill ${state.days === d ? "active" : ""}" data-days="${d}">${d === "365" ? "1Y" : d === "all" ? "All" : `${d}D`}</button>`).join("")}</div></div>
      <div id="chartWrap" class="chart-wrap"></div>
    </div></section>
    <section class="section"><div class="detail-grid">
      <div class="card panel"><div class="section-head"><h2>Optimization notes</h2></div><form id="annotationForm" class="stack gap-12"><textarea id="annotationNote" placeholder="Example: Removed unused Elementor carousel and deferred third-party JS"></textarea><div><button class="button" type="submit">Add note</button></div></form><div class="annotation-list">${annotationsHtml}</div></div>
      <div class="card panel"><div class="section-head"><h2>Monitoring</h2></div><div class="stack gap-12"><label class="field"><span>Mobile frequency</span><select id="mobileFrequency">${frequencyOptions(site.mobile_frequency)}</select></label><label class="field"><span>Desktop frequency</span><select id="desktopFrequency">${frequencyOptions(site.desktop_frequency)}</select></label><label class="field"><span>Site state</span><select id="siteActive"><option value="1" ${site.active ? "selected" : ""}>Active</option><option value="0" ${!site.active ? "selected" : ""}>Paused</option></select></label><button class="button" id="saveSiteSettings">Save settings</button><button class="button danger" id="deleteSite">Delete site</button></div></div>
    </div></section>`;

  drawChart();


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


  /*
   * Successful logical scan rows can jump directly to the retained
   * Lighthouse comparison below.
   */

  /*
   * CHECKPOINT-20:
   * Successful scan rows jump to the retained report comparison.
   */
  safeForEach(
    $$('[data-focus-report-panel]'),
    (button) => {
      button.onclick =
        () => {
          document
            .querySelector(
              "#siteDetailedReports"
            )
            ?.scrollIntoView({
              behavior: "smooth",
              block: "start"
            });
        };
    }
  );

  safeForEach(
    $$('[data-strategy]'),

    (btn) =>
      btn.onclick =
        async () => {
          state.strategy =
            btn.dataset.strategy;


          state.metric =
            "performance_score";


          await Promise.all([
            loadHistory(
              site.id,
              false
            ),

            loadSiteOperationalPanels(
              site.id,
              false
            )
          ]);


          drawSitePage();
        }
  );
  $$('[data-metric]').forEach(btn => btn.onclick = () => { state.metric = btn.dataset.metric; $$('[data-metric]').forEach(x => x.classList.toggle("active", x === btn)); drawChart(); });
  $$('[data-days]').forEach(btn => btn.onclick = async () => { state.days = btn.dataset.days; await loadHistory(site.id, false); drawSitePage(); });
  $("#runMobile").onclick = () => runNow(site.id, "mobile");
  $("#runDesktop").onclick = () => runNow(site.id, "desktop");
  $("#annotationForm").onsubmit = async (e) => {
    e.preventDefault();
    const note = $("#annotationNote").value.trim(); if (!note) return;
    try { await api(`/api/sites/${site.id}/annotations`, { method: "POST", body: JSON.stringify({ note }) }); toast("Note added."); await renderSite(site.id); } catch (err) { toast(err.message,"error"); }
  };
  $("#saveSiteSettings").onclick = async () => {
    try {
      await api(`/api/sites/${site.id}`, { method: "PATCH", body: JSON.stringify({ mobile_frequency: $("#mobileFrequency").value, desktop_frequency: $("#desktopFrequency").value, active: $("#siteActive").value === "1" }) });
      toast("Monitoring settings saved."); await renderSite(site.id);
    } catch (e) { toast(e.message,"error"); }
  };
  $("#deleteSite").onclick = async () => {
    if (!confirm(`Delete ${site.name} and all of its history? This cannot be undone.`)) return;
    try { await api(`/api/sites/${site.id}`, { method: "DELETE" }); toast("Site deleted."); location.hash = `#project/${site.project_id}`; } catch (e) { toast(e.message,"error"); }
  };
}

function frequencyOptions(current) {
  return [["daily","Daily"],["weekly","Weekly"],["manual","Manual only"]].map(([v,l]) => `<option value="${v}" ${current === v ? "selected" : ""}>${l}</option>`).join("");
}

function scoreBox(label, value) {
  return `<div class="score-box"><div class="metric-label">${label}</div><div class="number ${scoreClass(value)}">${value ?? "—"}</div><div class="metric-meta">Lighthouse score</div></div>`;
}

function vitalBox(label, value, unit, status) {
  return `<div class="vital-box"><div class="metric-label">${label}</div><div class="number">${formatMetric(value, unit)}</div>${statusBadge(status.label,status.cls)}</div>`;
}

async function waitForScanJob(
  jobId,
  timeoutMs = 120000
) {
  const startedAt =
    Date.now();

  while (
    Date.now() -
      startedAt <
    timeoutMs
  ) {
    const data =
      await api(
        `/api/next/jobs/${jobId}`
      );

    const job =
      data.job;

    if (
      job.status ===
      "success"
    ) {
      return job;
    }

    if (
      job.status ===
        "failed" ||
      job.status ===
        "cancelled"
    ) {
      throw new Error(
        job.error_message ||
        `Scan ${job.status}`
      );
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          3000
        )
    );
  }

  return null;
}


async function runNow(
  siteId,
  runStrategy
) {
  const buttons =
    [
      $("#runMobile"),
      $("#runDesktop")
    ].filter(Boolean);

  buttons.forEach(
    (button) =>
      button.disabled = true
  );

  toast(
    `${runStrategy[0].toUpperCase() + runStrategy.slice(1)} test queued.`
  );

  try {
    const result =
      await api(
        `/api/sites/${siteId}/run`,
        {
          method: "POST",
          body:
            JSON.stringify({
              strategy:
                runStrategy
            })
        }
      );

    const jobId =
      Number(
        result.job?.id
      );

    if (!jobId) {
      throw new Error(
        "Scan was queued but no job ID was returned."
      );
    }

    const completed =
      await waitForScanJob(
        jobId
      );

    state.strategy =
      runStrategy;

    if (completed) {
      toast(
        `${runStrategy[0].toUpperCase() + runStrategy.slice(1)} test saved.`
      );
    } else {
      toast(
        `${runStrategy[0].toUpperCase() + runStrategy.slice(1)} test is still processing. You can refresh later.`
      );
    }

    await renderSite(
      siteId
    );
  } catch (error) {
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
      await renderSite(
        siteId
      );
    } catch {}
  } finally {
    buttons.forEach(
      (button) =>
        button.disabled = false
    );
  }
}


function drawChart() {
  const wrap = $("#chartWrap"); if (!wrap) return;
  const cfg = metricConfig[state.metric];
  const rows = state.history.filter(r => r[state.metric] !== null && r[state.metric] !== undefined && Number.isFinite(Number(r[state.metric])));
  if (!rows.length) {
    wrap.innerHTML = `<div class="chart-empty"><div><strong>No ${escapeHtml(cfg.label)} history yet.</strong><br><span class="small">Run a test or wait for scheduled monitoring to collect snapshots.</span></div></div>`;
    return;
  }
  const width = 1000, height = 310, left = 58, right = 18, top = 18, bottom = 42;
  const plotW = width-left-right, plotH = height-top-bottom;
  const values = rows.map(r => Number(r[state.metric]));
  let min, max;
  if (cfg.fixed) [min,max] = cfg.fixed;
  else {
    min = Math.min(...values); max = Math.max(...values);
    const pad = Math.max((max-min)*0.18, state.metric.includes("cls") ? 0.03 : state.metric.includes("_ms") ? 150 : 5);
    min = Math.max(0, min-pad); max += pad;
    if (min === max) max = min + 1;
  }
  if (!cfg.fixed && cfg.threshold != null) {
    min = Math.min(min, cfg.threshold * .85);
    max = Math.max(max, cfg.threshold * 1.15);
  }

  const timestamps = rows.map(r => Date.parse(r.recorded_at));
  const validTimes = timestamps.every(Number.isFinite);
  const minTime = validTimes ? Math.min(...timestamps) : 0;
  const maxTime = validTimes ? Math.max(...timestamps) : 0;
  const useTimeScale = validTimes && maxTime > minTime;

  const x = i => left + (
    rows.length === 1
      ? plotW / 2
      : useTimeScale
        ? ((timestamps[i] - minTime) / (maxTime - minTime)) * plotW
        : i * plotW / (rows.length - 1)
  );
  const y = v => top + (max-v) * plotH/(max-min || 1);
  const points = rows.map((r,i) => `${x(i).toFixed(1)},${y(Number(r[state.metric])).toFixed(1)}`);
  const path = points.map((p,i) => `${i ? "L" : "M"}${p}`).join(" ");
  const area = `${path} L${x(rows.length-1)},${top+plotH} L${x(0)},${top+plotH} Z`;
  const grid = Array.from({length:5},(_,i) => {
    const gy = top + i*plotH/4; const val = max - i*(max-min)/4;
    const label = state.metric.includes("cls") ? val.toFixed(2) : Math.round(val).toLocaleString();
    return `<line class="chart-grid" x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}"/><text class="chart-axis" x="${left-9}" y="${gy+4}" text-anchor="end">${label}</text>`;
  }).join("");
  const labelIndexes = [...new Set([0, Math.floor((rows.length-1)/2), rows.length-1])];
  const labels = labelIndexes.map(i => `<text class="chart-axis" x="${x(i)}" y="${height-14}" text-anchor="${i===0 ? "start" : i===rows.length-1 ? "end" : "middle"}">${escapeHtml(formatDate(rows[i].recorded_at,false))}</text>`).join("");
  const dots = rows.length <= 80 ? rows.map((r,i) => `<circle class="chart-point" cx="${x(i)}" cy="${y(Number(r[state.metric]))}" r="3.3"><title>${formatDate(r.recorded_at)} · ${cfg.label}: ${formatMetric(r[state.metric], cfg.unit === "ms" ? "ms" : state.metric.includes("cls") ? "cls" : "score")}</title></circle>`).join("") : "";
  const threshold = cfg.threshold != null && cfg.threshold >= min && cfg.threshold <= max ? `<line class="threshold-line" x1="${left}" y1="${y(cfg.threshold)}" x2="${width-right}" y2="${y(cfg.threshold)}"/><text class="chart-axis" x="${width-right}" y="${y(cfg.threshold)-6}" text-anchor="end">Good threshold ${cfg.unit === "ms" ? formatMetric(cfg.threshold,"ms") : cfg.threshold}</text>` : "";
  wrap.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(cfg.label)} history line chart">${grid}${threshold}<path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>${dots}${labels}</svg>`;
}

function modal(content, wide = false) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal ${wide ? "wide" : ""}">${content}</div>`;
  root.classList.remove("hidden");
  root.onclick = e => { if (e.target === root) closeModal(); };
  $("#modalClose")?.addEventListener("click", closeModal);
}
function closeModal() { $("#modalRoot").classList.add("hidden"); $("#modalRoot").innerHTML = ""; }

function openProjectModal() {
  modal(`<div class="modal-head"><h2>New project</h2><button class="icon-button" id="modalClose">×</button></div><div class="modal-body"><form id="projectForm" class="stack gap-12"><label class="field"><span>Name</span><input id="projectName" maxlength="100" required placeholder="SEO Clients"></label><label class="field"><span>Description</span><textarea id="projectDescription" placeholder="Optional"></textarea></label><div class="modal-actions"><button type="button" class="button" id="cancelModal">Cancel</button><button class="button primary">Create project</button></div></form></div>`);
  $("#cancelModal").onclick = closeModal;
  $("#projectForm").onsubmit = async e => {
    e.preventDefault();
    try { const result = await api("/api/projects", { method:"POST", body: JSON.stringify({ name: $("#projectName").value, description: $("#projectDescription").value }) }); closeModal(); toast("Project created."); location.hash = `#project/${result.id}`; }
    catch (err) { toast(err.message,"error"); }
  };
}

function openAddSiteModal(projectId) {
  modal(`<div class="modal-head"><h2>Add site</h2><button class="icon-button" id="modalClose">×</button></div><div class="modal-body"><form id="siteForm" class="stack gap-12"><label class="field"><span>Website URL</span><input id="siteUrl" required placeholder="https://example.com/"></label><label class="field"><span>Name</span><input id="siteName" placeholder="Optional — hostname used if empty"></label><div class="form-grid"><label class="field"><span>Mobile</span><select id="newMobileFreq">${frequencyOptions("daily")}</select></label><label class="field"><span>Desktop</span><select id="newDesktopFreq">${frequencyOptions("weekly")}</select></label></div><div class="modal-actions"><button type="button" class="button" id="cancelModal">Cancel</button><button class="button primary">Add site</button></div></form></div>`);
  $("#cancelModal").onclick = closeModal;
  $("#siteForm").onsubmit = async e => {
    e.preventDefault();
    try { const result = await api(`/api/projects/${projectId}/sites`, { method:"POST", body: JSON.stringify({ url: $("#siteUrl").value, name: $("#siteName").value, mobile_frequency: $("#newMobileFreq").value, desktop_frequency: $("#newDesktopFreq").value }) }); closeModal(); toast("Site added. It is due for scheduled monitoring."); location.hash = `#site/${result.id}`; }
    catch (err) { toast(err.message,"error"); }
  };
}

function parseCsv(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else {
      if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ""; }
      else if (c === '\n') { row.push(cell); rows.push(row); row=[]; cell=""; }
      else if (c !== '\r') cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(h => h.trim().toLowerCase());
  const urlIndex = headers.indexOf("url"), nameIndex = headers.indexOf("name");
  if (urlIndex < 0) throw new Error('CSV must contain a "url" column.');
  const seen = new Set();
  return rows.filter(r => r.some(v => v.trim())).map((r, index) => {
    const raw = (r[urlIndex] || "").trim(); let valid = true, normalized = raw, error = "";
    try { const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); if (!["http:","https:"].includes(u.protocol)) throw new Error(); normalized = u.toString(); }
    catch { valid = false; error = "Invalid URL"; }
    const key = normalized.toLowerCase(); if (valid && seen.has(key)) { valid = false; error = "Duplicate in CSV"; } seen.add(key);
    return { row: index+2, name: nameIndex >= 0 ? (r[nameIndex] || "").trim() : "", url: raw, valid, error };
  });
}

function openCsvModal(projectId) {
  modal(`<div class="modal-head"><h2>Import sites from CSV</h2><button class="icon-button" id="modalClose">×</button></div><div class="modal-body"><p class="muted small">Required column: <span class="mono">url</span>. Optional column: <span class="mono">name</span>. The app previews and validates before import.</p><input id="csvFile" type="file" accept=".csv,text/csv"><div id="csvPreview"></div></div>`, true);
  $("#csvFile").onchange = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const rows = parseCsv(await file.text());
      const valid = rows.filter(r => r.valid);
      $("#csvPreview").innerHTML = `<div style="margin-top:16px"><strong>${valid.length} valid</strong> · ${rows.length-valid.length} skipped</div><div class="csv-preview"><table><thead><tr><th>Row</th><th>Name</th><th>URL</th><th>Status</th></tr></thead><tbody>${rows.slice(0,250).map(r => `<tr><td>${r.row}</td><td>${escapeHtml(r.name || "—")}</td><td>${escapeHtml(r.url)}</td><td>${r.valid ? statusBadge("Ready","good") : statusBadge(r.error,"bad")}</td></tr>`).join("")}</tbody></table></div><div class="modal-actions"><button class="button" id="cancelImport">Cancel</button><button class="button primary" id="confirmImport" ${valid.length ? "" : "disabled"}>Import ${valid.length} sites</button></div>`;
      $("#cancelImport").onclick = closeModal;
      $("#confirmImport").onclick = async () => {
        const btn = $("#confirmImport"); btn.disabled = true; btn.textContent = "Importing…";
        let inserted=0, duplicates=0, rejected=0;
        try {
          for (let i=0; i<valid.length; i+=50) {
            const chunk = valid.slice(i,i+50).map(({name,url}) => ({name,url}));
            const res = await api(`/api/projects/${projectId}/import`, { method:"POST", body: JSON.stringify({ sites: chunk }) });
            inserted += res.inserted; duplicates += res.duplicates; rejected += res.rejected;
          }
          closeModal(); toast(`Imported ${inserted} sites${duplicates ? ` · ${duplicates} existing` : ""}${rejected ? ` · ${rejected} rejected` : ""}.`); await renderProject(projectId);
        } catch (err) { toast(err.message,"error"); btn.disabled=false; btn.textContent=`Import ${valid.length} sites`; }
      };
    } catch (err) { $("#csvPreview").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`; }
  };
}

async function openSettings() {
  try {
    const settings = await api("/api/settings");
    const sourceBadge = settings.apiKeySource === "env"
      ? statusBadge("Worker Secret", "good")
      : settings.apiKeySource === "database"
      ? statusBadge("Database", "good")
      : statusBadge("Missing", "bad");

    const sourceDesc = settings.apiKeySource === "env"
      ? `<p class="muted small">Configured via encrypted Cloudflare secret <span class="mono">GOOGLE_API_KEY</span>. To change or override it, enter a new key below or update the Worker secret.</p>`
      : settings.apiKeySource === "database"
      ? `<p class="muted small">Configured in database (<span class="mono">${escapeHtml(settings.maskedApiKey)}</span>). Free tier PageSpeed quota is 25,000 requests/day.</p>`
      : `<p class="muted small">A free Google PageSpeed Insights API key is required to run performance scans. You can obtain one instantly with zero credit card from Google Cloud Console.</p>`;

    modal(`<div class="modal-head"><h2>Settings</h2><button class="icon-button" id="modalClose">×</button></div><div class="modal-body"><div class="stack gap-12">
      <div class="card panel">
        <div class="section-head">
          <h2>Google PageSpeed API Key</h2>
          ${sourceBadge}
        </div>
        ${sourceDesc}
        <div class="stack gap-8" style="margin-top: 10px;">
          <div style="display: flex; gap: 8px;">
            <input type="password" id="inputGoogleApiKey" class="input" placeholder="${settings.maskedApiKey ? 'Leave blank to keep (' + escapeHtml(settings.maskedApiKey) + ')' : 'Enter API key (AIza...)'}" style="flex: 1;" />
            <button class="button small primary" id="btnSaveApiKey">Save Key</button>
            ${settings.apiKeySource === "database" ? '<button class="button small ghost" id="btnClearApiKey">Clear</button>' : ''}
          </div>
          <div class="muted small" style="font-size: 11px;">
            Get a free key from <a href="https://developers.google.com/speed/docs/insights/v5/get-started" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: underline;">Google PageSpeed API Docs</a> (25,000 free scans/day).
          </div>
        </div>
      </div>
      <div class="card panel"><div class="section-head"><h2>Scheduler</h2>${statusBadge("Enabled","good")}</div><p class="muted small">Cron: <span class="mono">${escapeHtml(settings.cron)}</span><br>Max tests per cron: ${settings.scheduleBatchSize}. Sites are only tested when their next-check time is due.</p></div>
      <div class="card panel"><div class="section-head"><h2>Security</h2>${settings.authConfigured ? statusBadge("Configured","good") : statusBadge("Missing","bad")}</div>
        <p class="muted small">Admin credentials remain Cloudflare Worker secrets. Rotate the password from the recovered project folder, then rotate the session secret to invalidate old sessions.</p>
        <span class="command-chip">npx wrangler secret put ADMIN_PASSWORD</span>
        <span class="command-chip">node scripts/generate-secret.mjs</span><span class="command-chip">npx wrangler secret put SESSION_SECRET</span>
        <div class="security-actions"><button class="button small" data-copy-command="npx wrangler secret put ADMIN_PASSWORD">Copy password command</button><button class="button small" data-copy-command="npx wrangler secret put SESSION_SECRET">Copy session command</button></div>
      </div>
    </div></div>`);

    const saveKeyBtn = $("#btnSaveApiKey");
    if (saveKeyBtn) {
      saveKeyBtn.onclick = async () => {
        const keyInput = $("#inputGoogleApiKey");
        const val = keyInput?.value?.trim() || "";
        if (!val) {
          toast("Please enter an API key", "error");
          return;
        }
        try {
          saveKeyBtn.disabled = true;
          saveKeyBtn.textContent = "Saving...";
          await api("/api/settings", {
            method: "POST",
            body: JSON.stringify({ googleApiKey: val })
          });
          toast("Google PageSpeed API key saved!");
          await openSettings();
          if (location.hash === "" || location.hash === "#dashboard") {
            await renderDashboard();
          }
        } catch (err) {
          toast(err.message, "error");
        } finally {
          saveKeyBtn.disabled = false;
          saveKeyBtn.textContent = "Save Key";
        }
      };
    }

    const clearKeyBtn = $("#btnClearApiKey");
    if (clearKeyBtn) {
      clearKeyBtn.onclick = async () => {
        if (!confirm("Are you sure you want to remove the database-stored API key?")) return;
        try {
          clearKeyBtn.disabled = true;
          await api("/api/settings", {
            method: "POST",
            body: JSON.stringify({ googleApiKey: "" })
          });
          toast("Database API key removed.");
          await openSettings();
          if (location.hash === "" || location.hash === "#dashboard") {
            await renderDashboard();
          }
        } catch (err) {
          toast(err.message, "error");
        } finally {
          clearKeyBtn.disabled = false;
        }
      };
    }

    $$('[data-copy-command]').forEach(button => button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyCommand);
        toast("Command copied.");
      } catch {
        toast("Copy failed. Select the command above manually.", "error");
      }
    });
  } catch (e) { toast(e.message,"error"); }
}

const fillDemoBtn = $("#btnFillDemoPassword");
if (fillDemoBtn) {
  fillDemoBtn.onclick = () => {
    const pwdInput = $("#loginPassword");
    if (pwdInput) {
      pwdInput.value = "demo";
      $("#loginForm").requestSubmit();
    }
  };
}

$("#loginForm").onsubmit = async e => {
  e.preventDefault(); $("#loginError").classList.add("hidden");
  try {
    const response = await fetch("/api/auth/login", { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body: JSON.stringify({ password: $("#loginPassword").value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Login failed");
    $("#loginPassword").value = ""; showApp(); if (!location.hash) location.hash="#dashboard"; else router();
  } catch (err) { $("#loginError").textContent=err.message; $("#loginError").classList.remove("hidden"); }
};

$("#logoutButton").onclick = async () => { try { await fetch("/api/auth/logout", {method:"POST",credentials:"same-origin"}); } finally { showLogin(); } };
$("#settingsButton").onclick = openSettings;
$("#mobileMenuButton").onclick = () => $(".sidebar").classList.toggle("open");
$$('[data-route]').forEach(btn => btn.onclick = () => location.hash = btn.dataset.route);
window.addEventListener("hashchange", router);

(async function boot() {
  try {
    const response = await fetch("/api/auth/me", { credentials:"same-origin" });
    const data = await response.json();
    if (!data.configured) return showLogin("Server authentication is not configured yet. Complete the secrets step in SETUP.md.");
    if (!data.authenticated) return showLogin();
    showApp(); if (!location.hash) location.hash="#dashboard"; else router();
  } catch (e) { showLogin("Could not reach the SpeedPulse API."); }
})();
