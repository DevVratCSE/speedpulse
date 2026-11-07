import fs from "node:fs";


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
      `CHECKPOINT-20 CHECK FAILED: ${message}`
    );
  }
}


const control =
  read(
    "src/control-plane.ts"
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


const reports =
  read(
    "src/detailed-reports.ts"
  );


const packageJson =
  JSON.parse(
    read(
      "package.json"
    )
  );


/*
 * ================================================================
 * Extract the Checkpoint-20 recent-scan function so assertions apply
 * to that function rather than unrelated code elsewhere.
 * ================================================================
 */

const functionStart =
  control.indexOf(
    "export async function listRecentSiteScanJobs"
  );


const functionEnd =
  control.indexOf(
    "export async function listScanTargets",
    functionStart
  );


check(
  functionStart >= 0 &&
  functionEnd >
    functionStart,
  "listRecentSiteScanJobs() could not be isolated"
);


const recentFunction =
  control.slice(
    functionStart,
    functionEnd
  );


/*
 * ================================================================
 * Most important invariant: logical jobs, not provider attempts.
 * ================================================================
 */

check(
  recentFunction.includes(
    "FROM scan_jobs j"
  ),
  "recent site scans are not sourced from scan_jobs"
);


check(
  !recentFunction.includes(
    "FROM test_runs"
  ),
  "recent site scans incorrectly query test_runs/provider attempts"
);


check(
  recentFunction.includes(
    "Math.min(\n        2"
  ) ||
  recentFunction.includes(
    "Math.min(\n          2"
  ),
  "recent logical scan API is not capped at two jobs"
);


check(
  recentFunction.includes(
    "j.attempt"
  ) ||
  recentFunction.includes(
    "j.*"
  ),
  "logical job attempt count is not returned"
);


check(
  recentFunction.includes(
    "detailed_report_id"
  ),
  "recent successful logical jobs do not expose retained report linkage"
);


/*
 * ================================================================
 * API
 * ================================================================
 */

check(
  index.includes(
    "/recent-scans$"
  ) &&
  index.includes(
    "listRecentSiteScanJobs("
  ),
  "site recent logical scan endpoint is missing"
);


check(
  index.includes(
    "scanStrategy"
  ),
  "recent scan endpoint is not strategy-aware"
);


/*
 * ================================================================
 * Existing retained detailed reports remain canonical.
 * ================================================================
 */

check(
  reports.includes(
    "LIMIT 2"
  ) &&
  reports.includes(
    "dr.state='ready'"
  ),
  "existing two-report ready retention/list contract is missing"
);


check(
  reports.includes(
    "export async function getDetailedReportComparison"
  ) &&
  reports.includes(
    "latest"
  ) &&
  reports.includes(
    "previous"
  ) &&
  reports.includes(
    "deltas"
  ),
  "existing report comparison backend is missing"
);


/*
 * ================================================================
 * Main site UI integration
 * ================================================================
 */

check(
  ui.includes(
    "siteRecentScans"
  ) &&
  ui.includes(
    "siteDetailedReports"
  ) &&
  ui.includes(
    "siteReportComparison"
  ),
  "main site state does not store scan/report data"
);


check(
  ui.includes(
    "loadSiteOperationalPanels"
  ),
  "main site does not load recent scans and reports"
);


check(
  ui.includes(
    "/recent-scans?strategy="
  ),
  "main site does not call recent logical scan API"
);


check(
  ui.includes(
    "/api/next/sites/${siteId}/reports?strategy="
  ),
  "main site does not call retained detailed-report API"
);


check(
  ui.includes(
    "/api/next/sites/${siteId}/report-comparison?strategy="
  ),
  "main site does not call detailed-report comparison API"
);


check(
  ui.includes(
    "renderRecentLogicalScansSection"
  ),
  "recent logical scans section is missing"
);


check(
  ui.includes(
    "Latest two logical scan jobs"
  ),
  "site UI does not explain logical scan semantics"
);


check(
  ui.includes(
    "Provider retries included"
  ),
  "retry attempts are not represented inside logical scan rows"
);


check(
  ui.includes(
    "renderSiteDetailedReportsSection"
  ),
  "main detailed-report section is missing"
);


check(
  ui.includes(
    "Latest vs previous retained success"
  ),
  "retained-report comparison UI is missing"
);


check(
  ui.includes(
    "/api/next/reports/${reportId}/json"
  ) ||
  ui.includes(
    "/api/next/reports/${Number("
  ),
  "successful scan/report rows do not link to Detailed JSON"
);


check(
  ui.includes(
    "data-focus-report-panel"
  ),
  "successful recent scan rows do not link into comparison panel"
);


/*
 * ================================================================
 * Device-tab refresh safety
 * ================================================================
 */

check(
  ui.includes(
    "strategyAtStart"
  ) &&
  ui.includes(
    "sitePanelGeneration"
  ),
  "Mobile/Desktop report requests lack stale-response protection"
);


check(
  ui.includes(
    "Promise.allSettled"
  ),
  "a detailed-report failure can unnecessarily hide recent logical scans"
);


/*
 * ================================================================
 * CSS
 * ================================================================
 */

check(
  css.includes(
    "CHECKPOINT-20: recent logical scans + detailed reports"
  ),
  "Checkpoint-20 CSS marker is missing"
);


check(
  css.includes(
    ".recent-scans-table"
  ) &&
  css.includes(
    ".site-report-metric-grid"
  ) &&
  css.includes(
    ".site-report-list"
  ),
  "Checkpoint-20 site scan/report styling is incomplete"
);


/*
 * ================================================================
 * npm validation integration
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
  "Checkpoint-18 verifier disappeared"
);


check(
  checkScript.includes(
    "verify-checkpoint-19.mjs"
  ),
  "Checkpoint-19 verifier disappeared"
);


check(
  checkScript.includes(
    "verify-checkpoint-20.mjs"
  ),
  "Checkpoint-20 verifier is not part of npm run check"
);


console.log(
  "Checkpoint-20 recent logical scans + detailed reports regression checks: PASS"
);

