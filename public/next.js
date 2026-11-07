"use strict";

const state = {
  page: 1,
  pageSize: 50,
  q: "",
  projectId: "",
  active: "",
  sites: [],
  pagination: null,
  selected: new Set(),
  jobs: [],
  bulkJobs: [],

  reportSiteId: null,
  reportSiteName: "",
  reportStrategy: "mobile"
};

const $ = (id) =>
  document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(value);
  }

  return new Intl.DateTimeFormat(
    undefined,
    {
      dateStyle: "medium",
      timeStyle: "short"
    }
  ).format(date);
}

function parseConfig(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function scheduleLabel(
  site,
  strategy
) {
  const type =
    site[
      `${strategy}_schedule_type`
    ];

  const enabled =
    Number(
      site[
        `${strategy}_enabled`
      ] || 0
    ) !== 0;

  if (!type) {
    return {
      main: "Not configured",
      sub: "No target"
    };
  }

  const config =
    parseConfig(
      site[
        `${strategy}_schedule_config_json`
      ]
    );

  const timezone =
    site[
      `${strategy}_timezone`
    ] || "UTC";

  let main;

  if (type === "manual") {
    main = "Manual only";
  } else if (
    type === "interval"
  ) {
    const minutes =
      Number(
        config.minutes || 0
      );

    if (
      minutes > 0 &&
      minutes % 1440 === 0
    ) {
      main =
        `Every ${minutes / 1440} day(s)`;
    } else if (
      minutes > 0 &&
      minutes % 60 === 0
    ) {
      main =
        `Every ${minutes / 60} hour(s)`;
    } else {
      main =
        `Every ${minutes} min`;
    }
  } else if (
    type === "daily"
  ) {
    main =
      `Daily ${config.time || ""}`;
  } else if (
    type === "weekly"
  ) {
    main =
      `Weekly ${config.time || ""}`;
  } else {
    main = type;
  }

  if (
    !enabled &&
    type !== "manual"
  ) {
    main += " · paused";
  }

  const next =
    formatDate(
      site[
        `${strategy}_next_due_at`
      ]
    );

  return {
    main,
    sub:
      `${timezone} · next ${next}`
  };
}

async function api(
  path,
  options = {}
) {
  const response =
    await fetch(
      path,
      {
        credentials:
          "same-origin",
        ...options,
        headers: {
          ...(options.body
            ? {
                "content-type":
                  "application/json"
              }
            : {}),
          ...(options.headers || {})
        }
      }
    );

  let data;

  try {
    data =
      await response.json();
  } catch {
    data = {};
  }

  if (
    response.status === 401
  ) {
    showLogin();
    throw new Error(
      "Authentication required"
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      `Request failed (${response.status})`
    );
  }

  return data;
}

function showLogin() {
  $("appView")
    .classList.add(
      "hidden"
    );

  $("loginView")
    .classList.remove(
      "hidden"
    );

  $("loginPassword")
    .focus();
}

function showApp() {
  $("loginView")
    .classList.add(
      "hidden"
    );

  $("appView")
    .classList.remove(
      "hidden"
    );
}

async function login(event) {
  event.preventDefault();

  $("loginError").textContent =
    "";

  const password =
    $("loginPassword").value;

  try {
    await api(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          password
        })
      }
    );

    $("loginPassword").value =
      "";

    showApp();

    await loadEverything();
  } catch (error) {
    $("loginError").textContent =
      error.message;
  }
}

function siteQuery(
  includePaging = true
) {
  const params =
    new URLSearchParams();

  if (includePaging) {
    params.set(
      "page",
      String(state.page)
    );

    params.set(
      "pageSize",
      String(state.pageSize)
    );
  }

  if (state.q) {
    params.set(
      "q",
      state.q
    );
  }

  if (state.projectId) {
    params.set(
      "projectId",
      state.projectId
    );
  }

  if (state.active !== "") {
    params.set(
      "active",
      state.active
    );
  }

  return params.toString();
}

async function loadProjects() {
  const data =
    await api(
      "/api/next/projects"
    );

  const select =
    $("projectFilter");

  const previous =
    select.value;

  select.innerHTML =
    '<option value="">All projects</option>';

  for (
    const project
    of data.projects || []
  ) {
    const option =
      document.createElement(
        "option"
      );

    option.value =
      String(project.id);

    option.textContent =
      `${project.name} (${project.site_count})`;

    select.appendChild(
      option
    );
  }

  select.value =
    previous;
}

async function loadSites() {
  $("siteRows").innerHTML =
    '<tr><td colspan="6" class="empty">Loading…</td></tr>';

  const data =
    await api(
      `/api/next/sites?${siteQuery()}`
    );

  state.sites =
    data.sites || [];

  state.pagination =
    data.pagination;

  renderSites();
  renderPagination();
  renderSelection();

  $("nowValue").textContent =
    String(
      data.pagination?.total || 0
    );

  $("nowDetail").textContent =
    "sites matching current filters";
}

function renderSites() {
  if (
    state.sites.length === 0
  ) {
    $("siteRows").innerHTML =
      '<tr><td colspan="6" class="empty">No matching sites.</td></tr>';

    return;
  }


  $("siteRows").innerHTML =
    state.sites
      .map(
        (site) => {
          const mobile =
            scheduleLabel(
              site,
              "mobile"
            );

          const desktop =
            scheduleLabel(
              site,
              "desktop"
            );

          const checked =
            state.selected.has(
              Number(
                site.id
              )
            )
              ? "checked"
              : "";

          const active =
            Number(
              site.active
            ) !== 0;


          return `
            <tr>
              <td class="check-cell">
                <input
                  class="site-check"
                  type="checkbox"
                  data-id="${Number(site.id)}"
                  ${checked}
                >
              </td>

              <td>
                <div class="site-name">
                  ${escapeHtml(site.name)}
                </div>

                <a
                  class="site-url"
                  href="${escapeHtml(site.url)}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ${escapeHtml(site.url)}
                </a>

                <div>
                  <button
                    class="ghost report-link"
                    type="button"
                    data-report-site="${Number(site.id)}"
                    data-report-name="${escapeHtml(site.name)}"
                  >
                    Detailed reports
                  </button>
                </div>
              </td>

              <td>
                ${escapeHtml(site.project_name)}
              </td>

              <td>
                <div class="schedule-block">
                  <div class="schedule-main">
                    ${escapeHtml(mobile.main)}
                  </div>

                  <div class="schedule-sub">
                    ${escapeHtml(mobile.sub)}
                  </div>
                </div>
              </td>

              <td>
                <div class="schedule-block">
                  <div class="schedule-main">
                    ${escapeHtml(desktop.main)}
                  </div>

                  <div class="schedule-sub">
                    ${escapeHtml(desktop.sub)}
                  </div>
                </div>
              </td>

              <td>
                <span
                  class="status-chip ${
                    active
                      ? "status-success"
                      : ""
                  }"
                >
                  ${
                    active
                      ? "Active"
                      : "Inactive"
                  }
                </span>
              </td>
            </tr>
          `;
        }
      )
      .join("");


  document
    .querySelectorAll(
      ".site-check"
    )
    .forEach(
      (checkbox) => {
        checkbox.addEventListener(
          "change",
          () => {
            const id =
              Number(
                checkbox.dataset.id
              );

            if (
              checkbox.checked
            ) {
              state.selected.add(
                id
              );
            } else {
              state.selected.delete(
                id
              );
            }

            renderSelection();
          }
        );
      }
    );


  document
    .querySelectorAll(
      ".report-link"
    )
    .forEach(
      (button) => {
        button.addEventListener(
          "click",
          () => {
            openReports(
              Number(
                button.dataset.reportSite
              ),

              button.dataset.reportName ||
                `Site ${button.dataset.reportSite}`
            );
          }
        );
      }
    );
}


function renderPagination() {
  const p =
    state.pagination;

  if (!p) {
    return;
  }

  $("pageLabel").textContent =
    `Page ${p.page} of ${p.pages} · ${p.total} sites`;

  $("previousPage").disabled =
    !p.hasPrevious;

  $("nextPage").disabled =
    !p.hasNext;
}

function renderSelection() {
  $("selectionCount").textContent =
    `${state.selected.size} selected`;
}

function selectPage() {
  for (
    const site
    of state.sites
  ) {
    state.selected.add(
      Number(site.id)
    );
  }

  renderSites();
  renderSelection();
}

async function selectAllMatching() {
  setMessage(
    "Selecting matching sites…"
  );

  try {
    const data =
      await api(
        `/api/next/sites/ids?${siteQuery(false)}`
      );

    state.selected.clear();

    for (
      const id
      of data.ids || []
    ) {
      state.selected.add(
        Number(id)
      );
    }

    renderSites();
    renderSelection();

    setMessage(
      data.truncated
        ? `Selected first 500 of ${data.total} matching sites.`
        : `Selected ${data.ids.length} matching sites.`
    );
  } catch (error) {
    setMessage(
      error.message,
      true
    );
  }
}

function selectedIds() {
  const ids =
    Array.from(
      state.selected
    );

  if (
    ids.length === 0
  ) {
    throw new Error(
      "Select at least one site."
    );
  }

  if (
    ids.length > 500
  ) {
    throw new Error(
      "Bulk actions are limited to 500 sites per request."
    );
  }

  return ids;
}

function bulkStrategies() {
  return $("bulkStrategy").value;
}

function setMessage(
  message,
  error = false
) {
  const element =
    $("actionMessage");

  element.textContent =
    message || "";

  element.classList.toggle(
    "error",
    error
  );
}

function currentSchedule() {
  const type =
    $("scheduleType").value;

  const timezone =
    $("scheduleTimezone")
      .value
      .trim() || "UTC";

  if (type === "manual") {
    return {
      type,
      timezone,
      config: {}
    };
  }

  if (type === "interval") {
    return {
      type,
      timezone,
      config: {
        minutes:
          Number(
            $("intervalMinutes").value
          )
      }
    };
  }

  if (type === "daily") {
    return {
      type,
      timezone,
      config: {
        time:
          $("scheduleTime").value
      }
    };
  }

  const days =
    $("scheduleDays")
      .value
      .split(",")
      .map(
        (value) =>
          Number(
            value.trim()
          )
      )
      .filter(
        (value) =>
          Number.isInteger(value)
      );

  return {
    type,
    timezone,
    config: {
      days,
      time:
        $("scheduleTime").value
    }
  };
}

function updateScheduleFields() {
  const type =
    $("scheduleType").value;

  $("intervalField")
    .classList.toggle(
      "hidden",
      type !== "interval"
    );

  $("timeField")
    .classList.toggle(
      "hidden",
      ![
        "daily",
        "weekly"
      ].includes(type)
    );

  $("daysField")
    .classList.toggle(
      "hidden",
      type !== "weekly"
    );
}

async function bulkAction(
  path,
  payload,
  message
) {
  try {
    const ids =
      selectedIds();

    setMessage(
      `${message}…`
    );

    const data =
      await api(
        path,
        {
          method: "POST",
          body:
            JSON.stringify({
              siteIds: ids,
              ...payload
            })
        }
      );

    const bulk =
      data.bulk || {};

    const affected =
      bulk.completed ??
      bulk.queued ??
      0;

    setMessage(
      `${message}: ${affected} target(s), ${bulk.skipped || 0} skipped.`
    );

    await Promise.all([
      loadSites(),
      loadOperational()
    ]);
  } catch (error) {
    setMessage(
      error.message,
      true
    );
  }
}

async function runNow() {
  await bulkAction(
    "/api/next/bulk/run",
    {
      strategies:
        bulkStrategies()
    },
    "Run queued"
  );
}

async function setMonitoring(
  enabled
) {
  await bulkAction(
    "/api/next/bulk/monitoring",
    {
      strategies:
        bulkStrategies(),
      enabled
    },
    enabled
      ? "Monitoring enabled"
      : "Monitoring disabled"
  );
}

async function applySchedule() {
  await bulkAction(
    "/api/next/bulk/schedule",
    {
      strategies:
        bulkStrategies(),
      schedule:
        currentSchedule()
    },
    "Schedule updated"
  );
}

function formatReportBytes(
  value
) {
  const bytes =
    Number(
      value || 0
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
    return (
      `${(
        bytes /
        (
          1024 *
          1024
        )
      ).toFixed(2)} MB`
    );
  }

  if (
    bytes >= 1024
  ) {
    return (
      `${(
        bytes /
        1024
      ).toFixed(1)} KB`
    );
  }

  return `${bytes} B`;
}


function formatReportMetric(
  value,
  key
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
    [
      "lcp_ms",
      "tbt_ms",
      "fcp_ms",
      "field_lcp_ms",
      "field_inp_ms"
    ].includes(
      key
    )
  ) {
    return `${Math.round(number)} ms`;
  }

  if (
    [
      "cls",
      "field_cls"
    ].includes(
      key
    )
  ) {
    return number
      .toFixed(3)
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


function formatReportDelta(
  value,
  key
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

  const sign =
    number > 0
      ? "+"
      : "";

  if (
    [
      "lcp_ms",
      "tbt_ms",
      "fcp_ms",
      "field_lcp_ms",
      "field_inp_ms"
    ].includes(
      key
    )
  ) {
    return (
      `${sign}${Math.round(number)} ms vs previous`
    );
  }

  if (
    [
      "cls",
      "field_cls"
    ].includes(
      key
    )
  ) {
    return (
      `${sign}${number.toFixed(3)} vs previous`
    );
  }

  return (
    `${sign}${Math.round(number)} vs previous`
  );
}


const reportMetrics = [
  [
    "Performance",
    "performance_score"
  ],

  [
    "Accessibility",
    "accessibility_score"
  ],

  [
    "SEO",
    "seo_score"
  ],

  [
    "Best practices",
    "best_practices_score"
  ],

  [
    "Lab LCP",
    "lcp_ms"
  ],

  [
    "TBT",
    "tbt_ms"
  ],

  [
    "Lab CLS",
    "cls"
  ],

  [
    "Field LCP",
    "field_lcp_ms"
  ],

  [
    "Field INP",
    "field_inp_ms"
  ],

  [
    "Field CLS",
    "field_cls"
  ]
];


function updateReportStrategyButtons() {
  const mobile =
    $("reportMobileButton");

  const desktop =
    $("reportDesktopButton");

  const mobileActive =
    state.reportStrategy ===
    "mobile";

  mobile.classList.toggle(
    "primary",
    mobileActive
  );

  mobile.classList.toggle(
    "secondary",
    !mobileActive
  );

  desktop.classList.toggle(
    "primary",
    !mobileActive
  );

  desktop.classList.toggle(
    "secondary",
    mobileActive
  );
}


function renderReportComparison(
  comparison
) {
  const latest =
    comparison?.latest;

  const previous =
    comparison?.previous;

  const deltas =
    comparison?.deltas ||
    {};


  if (!latest) {
    $("reportComparison").innerHTML =
      '<div class="empty">No successful detailed report has been stored for this strategy yet.</div>';

    return;
  }


  const metricHtml =
    reportMetrics
      .map(
        (
          [
            label,
            key
          ]
        ) => `
          <div class="report-metric">
            <div class="report-metric-label">
              ${escapeHtml(label)}
            </div>

            <div class="report-metric-value">
              ${escapeHtml(
                formatReportMetric(
                  latest[key],
                  key
                )
              )}
            </div>

            <div class="report-metric-delta">
              ${
                previous
                  ? escapeHtml(
                      formatReportDelta(
                        deltas[key],
                        key
                      )
                    )
                  : "First retained report"
              }
            </div>
          </div>
        `
      )
      .join("");


  $("reportComparison").innerHTML =
    `
      <div class="report-comparison-head">
        <div>
          <div class="report-comparison-title">
            Latest · ${escapeHtml(formatDate(latest.captured_at))}
          </div>

          <div class="report-comparison-sub">
            CrUX: ${escapeHtml(latest.crux_status || "unknown")}
            · ${escapeHtml(formatReportBytes(latest.size_bytes))}
          </div>
        </div>

        <div>
          ${
            previous
              ? `
                <div class="report-comparison-title">
                  Previous · ${escapeHtml(formatDate(previous.captured_at))}
                </div>

                <div class="report-comparison-sub">
                  Report #${Number(previous.id)}
                </div>
              `
              : `
                <div class="report-comparison-sub">
                  A second successful scan will enable comparison.
                </div>
              `
          }
        </div>
      </div>

      <div class="report-metric-grid">
        ${metricHtml}
      </div>
    `;
}


function renderReportHistory(
  reports
) {
  if (
    !reports ||
    reports.length === 0
  ) {
    $("reportHistory").innerHTML =
      "";

    return;
  }


  $("reportHistory").innerHTML =
    reports
      .map(
        (
          report,
          index
        ) => `
          <div class="report-item">
            <div>
              <div class="report-item-main">
                ${
                  index === 0
                    ? "Latest retained report"
                    : "Previous retained report"
                }
              </div>

              <div class="report-item-sub">
                ${escapeHtml(formatDate(report.captured_at))}
                · ${escapeHtml(formatReportBytes(report.size_bytes))}
                · Lighthouse ${escapeHtml(report.lighthouse_version || "unknown")}
                · CrUX ${escapeHtml(report.crux_status || "unknown")}
              </div>
            </div>

            <a
              class="report-json-link"
              href="/api/next/reports/${Number(report.id)}/json"
              target="_blank"
              rel="noopener noreferrer"
            >
              Detailed JSON
            </a>
          </div>
        `
      )
      .join("");
}


async function loadReports() {
  if (
    !state.reportSiteId
  ) {
    return;
  }


  updateReportStrategyButtons();


  $("reportComparison").innerHTML =
    '<div class="empty">Loading detailed reports…</div>';

  $("reportHistory").innerHTML =
    "";


  try {
    const [
      reportData,
      comparisonData
    ] =
      await Promise.all([
        api(
          `/api/next/sites/${state.reportSiteId}/reports?strategy=${encodeURIComponent(state.reportStrategy)}`
        ),

        api(
          `/api/next/sites/${state.reportSiteId}/report-comparison?strategy=${encodeURIComponent(state.reportStrategy)}`
        )
      ]);


    renderReportComparison(
      comparisonData.comparison
    );

    renderReportHistory(
      reportData.reports ||
      []
    );
  } catch (error) {
    $("reportComparison").innerHTML =
      `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}


function openReports(
  siteId,
  siteName
) {
  state.reportSiteId =
    siteId;

  state.reportSiteName =
    siteName;

  state.reportStrategy =
    "mobile";


  $("reportSiteName").textContent =
    `${siteName} · newest two successful reports are retained per strategy`;


  loadReports()
    .catch(
      (error) =>
        setMessage(
          error.message,
          true
        )
    );


  $("reportPanel")
    .scrollIntoView({
      behavior:
        "smooth",

      block:
        "start"
    });
}


function statusClass(status) {
  return [
    "success",
    "failed",
    "running",
    "queued",
    "pending"
  ].includes(status)
    ? `status-${status}`
    : "";
}

function renderActivity(
  elementId,
  rows,
  kind
) {
  const element =
    $(elementId);

  if (
    !rows ||
    rows.length === 0
  ) {
    element.innerHTML =
      '<div class="empty">No activity yet.</div>';
    return;
  }

  element.innerHTML =
    rows.slice(
      0,
      12
    )
      .map(
        (row) => {
          const title =
            kind === "scan"
              ? `${row.site_name || `Site ${row.site_id}`} · ${row.strategy}`
              : `${row.action} · #${row.id}`;

          const subtitle =
            kind === "scan"
              ? `${row.trigger} · attempt ${row.attempt} · ${formatDate(row.completed_at || row.started_at || row.created_at)}`
              : `${row.completed_count}/${row.total_count} complete · ${row.failed_count} failed · ${row.skipped_count} skipped`;

          return `
            <div class="activity-item">
              <div>
                <div class="activity-main">
                  ${escapeHtml(title)}
                </div>

                <div class="activity-sub">
                  ${escapeHtml(subtitle)}
                </div>
              </div>

              <span
                class="status-chip ${statusClass(row.status)}"
              >
                ${escapeHtml(row.status)}
              </span>
            </div>
          `;
        }
      )
      .join("");
}

async function loadOperational() {
  const [
    jobsData,
    bulkData,
    statusData
  ] =
    await Promise.all([
      api(
        "/api/next/jobs?limit=30"
      ),

      api(
        "/api/next/bulk/jobs?limit=20"
      ),

      api(
        "/api/next/status"
      )
    ]);


  state.jobs =
    jobsData.jobs ||
    [];

  state.bulkJobs =
    bulkData.jobs ||
    [];


  renderActivity(
    "recentJobs",
    state.jobs,
    "scan"
  );


  renderActivity(
    "bulkJobs",
    state.bulkJobs,
    "bulk"
  );


  const latest =
    state.jobs[0];


  $("changedValue").textContent =
    latest
      ? String(
          latest.status
        ).toUpperCase()
      : "—";


  $("changedDetail").textContent =
    latest
      ? `${latest.site_name || "Site"} · ${latest.strategy} · ${formatDate(latest.completed_at || latest.created_at)}`
      : "No recent scans";


  const health =
    statusData?.health ||
    {};

  const counts =
    health.counts ||
    {};


  const activeJobs =
    Number(
      counts.activeJobs ||
      0
    );

  const dueTargets =
    Number(
      counts.dueTargets ||
      0
    );

  const failedJobs24h =
    Number(
      counts.failedJobs24h ||
      0
    );


  $("doNextValue").textContent =
    String(
      activeJobs
    );


  $("doNextDetail").textContent =
    `${dueTargets} due · ${failedJobs24h} failed in 24h`;


  const features =
    statusData?.features ||
    {};


  const lastTick =
    health.state?.[
      "scheduler.next.last_tick"
    ];


  const tickTimestamp =
    Date.parse(
      lastTick?.updatedAt ||
      ""
    );


  const tickFresh =
    Number.isFinite(
      tickTimestamp
    ) &&
    Date.now() -
      tickTimestamp <=
      15 * 60 * 1000;


  const tickValue =
    lastTick?.value ||
    {};


  const tickOk =
    tickValue.ok !==
    false;


  const budgetRemaining =
    Number(
      tickValue
        .budgetRemaining ??
      1
    );


  let systemText =
    "Status unavailable";

  let systemClass =
    "status-failed";


  if (
    !features.nextScheduler ||
    !features.queueScans
  ) {
    systemText =
      "Next misconfigured";
  } else if (
    !tickFresh
  ) {
    systemText =
      "Scheduler stale";
  } else if (
    !tickOk
  ) {
    systemText =
      "Scheduler degraded";
  } else if (
    dueTargets > 0 &&
    budgetRemaining <= 0
  ) {
    systemText =
      "Daily budget reached";

    systemClass =
      "status-running";
  } else {
    systemText =
      "Next healthy";

    systemClass =
      "status-success";
  }


  const system =
    $("systemStatus");


  system.textContent =
    systemText;


  const reports =
    statusData?.reports ||
    {};


  system.title =
    `Detailed reports: ${Number(reports.ready || 0)} ready · ${Number(reports.cleanupPending || 0)} cleanup pending`;


  system.classList.remove(
    "status-success",
    "status-failed",
    "status-running",
    "status-queued",
    "status-pending"
  );


  system.classList.add(
    systemClass
  );
}


async function loadEverything() {
  await Promise.all([
    loadProjects(),
    loadSites(),
    loadOperational()
  ]);
}

function applyFilters() {
  state.page = 1;

  /*
   * Selection belongs to the current visible filter scope.
   * Never carry hidden site IDs into a later bulk action.
   */
  state.selected.clear();
  renderSelection();

  state.q =
    $("searchInput")
      .value
      .trim();

  state.projectId =
    $("projectFilter").value;

  state.active =
    $("activeFilter").value;

  state.pageSize =
    Number(
      $("pageSize").value
    );

  loadSites().catch(
    (error) =>
      setMessage(
        error.message,
        true
      )
  );
}

async function boot() {
  const timezone =
    Intl.DateTimeFormat()
      .resolvedOptions()
      .timeZone;

  if (timezone) {
    $("scheduleTimezone").value =
      timezone;
  }

  try {
    const response =
      await fetch(
        "/api/auth/me",
        {
          credentials:
            "same-origin"
        }
      );

    const data =
      await response.json();

    if (
      response.ok &&
      data.authenticated
    ) {
      showApp();
      await loadEverything();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

$("loginForm")
  .addEventListener(
    "submit",
    login
  );

$("scheduleType")
  .addEventListener(
    "change",
    updateScheduleFields
  );

$("searchButton")
  .addEventListener(
    "click",
    applyFilters
  );

$("searchInput")
  .addEventListener(
    "keydown",
    (event) => {
      if (
        event.key === "Enter"
      ) {
        applyFilters();
      }
    }
  );

$("selectPageButton")
  .addEventListener(
    "click",
    selectPage
  );

$("selectAllButton")
  .addEventListener(
    "click",
    selectAllMatching
  );

$("clearSelectionButton")
  .addEventListener(
    "click",
    () => {
      state.selected.clear();
      renderSites();
      renderSelection();
    }
  );

$("runNowButton")
  .addEventListener(
    "click",
    runNow
  );

$("monitorOnButton")
  .addEventListener(
    "click",
    () =>
      setMonitoring(true)
  );

$("monitorOffButton")
  .addEventListener(
    "click",
    () =>
      setMonitoring(false)
  );

$("applyScheduleButton")
  .addEventListener(
    "click",
    applySchedule
  );

$("previousPage")
  .addEventListener(
    "click",
    () => {
      if (
        state.pagination
          ?.hasPrevious
      ) {
        state.page -= 1;
        loadSites();
      }
    }
  );

$("nextPage")
  .addEventListener(
    "click",
    () => {
      if (
        state.pagination
          ?.hasNext
      ) {
        state.page += 1;
        loadSites();
      }
    }
  );

$("refreshButton")
  .addEventListener(
    "click",
    loadEverything
  );

updateScheduleFields();
$("reportMobileButton")
  .addEventListener(
    "click",
    () => {
      if (
        !state.reportSiteId
      ) {
        return;
      }

      state.reportStrategy =
        "mobile";

      loadReports();
    }
  );


$("reportDesktopButton")
  .addEventListener(
    "click",
    () => {
      if (
        !state.reportSiteId
      ) {
        return;
      }

      state.reportStrategy =
        "desktop";

      loadReports();
    }
  );


boot();

setInterval(
  () => {
    if (
      !$("appView")
        .classList
        .contains("hidden")
    ) {
      loadOperational()
        .catch(() => {});
    }
  },
  30000
);
