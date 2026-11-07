import fs from "node:fs";


function read(path) {
  return fs.readFileSync(
    path,
    "utf8"
  );
}


function assert(
  condition,
  message
) {
  if (!condition) {
    throw new Error(
      `CONTROL-PLANE CHECK FAILED: ${message}`
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

const db =
  read(
    "src/db.ts"
  );

const index =
  read(
    "src/index.ts"
  );

const scheduler =
  read(
    "src/scheduler.ts"
  );

const migration =
  read(
    "migrations/0005_control_plane_convergence.sql"
  );

const legacyUi =
  read(
    "public/app.js"
  );

const nextUi =
  read(
    "public/next.js"
  );

const packageJson =
  JSON.parse(
    read(
      "package.json"
    )
  );


/*
 * --------------------------------------------------------------
 * Shared execution lease
 * --------------------------------------------------------------
 */

assert(
  policy.includes(
    "SCAN_RUN_LEASE_MS"
  ),
  "shared scan lease constant is missing"
);

assert(
  control.includes(
    'from "./scan-policy"'
  ) &&
  control.includes(
    "SCAN_RUN_LEASE_MS"
  ),
  "scan_jobs do not use shared lease policy"
);

assert(
  db.includes(
    'from "./scan-policy"'
  ) &&
  db.includes(
    "SCAN_RUN_LEASE_MS"
  ),
  "test_runs do not use shared lease policy"
);

assert(
  !db.includes(
    "20 * 60_000"
  ),
  "old 20-minute test_run lease still exists"
);


/*
 * --------------------------------------------------------------
 * Canonical Queue execution
 * --------------------------------------------------------------
 */

assert(
  !index.includes(
    "runSiteTest("
  ),
  "index.ts still directly executes runSiteTest"
);

assert(
  index.includes(
    "async function queueManualScan"
  ),
  "shared manual Queue helper is missing"
);

assert(
  index.includes(
    'trigger: "manual"'
  ),
  "manual Queue job trigger is missing"
);

assert(
  index.includes(
    "getScanJobById("
  ) &&
  index.includes(
    "const jobMatch"
  ) &&
  index.includes(
    "Scan job not found"
  ),
  "authenticated single-job status route is missing"
);

assert(
  index.includes(
    "queueBulkScans("
  ),
  "project-wide queue path does not use Queue jobs"
);


/*
 * --------------------------------------------------------------
 * Old dashboard compatibility
 * --------------------------------------------------------------
 */

assert(
  legacyUi.includes(
    "async function waitForScanJob"
  ),
  "legacy dashboard does not poll asynchronous jobs"
);

assert(
  legacyUi.includes(
    "/api/next/jobs/${jobId}"
  ),
  "legacy dashboard does not use the job-status API"
);

assert(
  legacyUi.includes(
    "test queued"
  ),
  "legacy Run Now UI was not converted to async semantics"
);


/*
 * --------------------------------------------------------------
 * Scheduler correctness
 * --------------------------------------------------------------
 */

assert(
  control.includes(
    "export async function countDueTargets"
  ),
  "exact scheduler backlog counter is missing"
);

assert(
  scheduler.includes(
    "countDueTargets("
  ),
  "scheduler is not using exact backlog count"
);

const dueSelections =
  scheduler.match(
    /await listDueTargets\(/g
  ) || [];

assert(
  dueSelections.length === 2,
  `expected one listDueTargets call in preview and one in real tick; found ${dueSelections.length}`
);

assert(
  scheduler.includes(
    "candidates:"
  ),
  "scheduler tick state does not record bounded candidates"
);


/*
 * --------------------------------------------------------------
 * Database invariants
 * --------------------------------------------------------------
 */

assert(
  migration.includes(
    "CREATE TRIGGER trg_sites_create_scan_targets"
  ),
  "new-site target trigger is missing"
);

assert(
  migration.includes(
    "CREATE TRIGGER trg_sites_disable_scan_targets"
  ),
  "site deactivation trigger is missing"
);

assert(
  migration.includes(
    "CREATE TRIGGER trg_sites_reactivate_scan_targets"
  ),
  "site reactivation trigger is missing"
);

assert(
  migration.includes(
    "trg_sites_sync_mobile_frequency"
  ) &&
  migration.includes(
    "trg_sites_sync_desktop_frequency"
  ),
  "legacy frequency compatibility triggers are missing"
);


/*
 * --------------------------------------------------------------
 * Management UI observability
 * --------------------------------------------------------------
 */

assert(
  nextUi.includes(
    "statusData?.health"
  ),
  "Next UI does not consume real health data"
);

assert(
  nextUi.includes(
    "counts.activeJobs"
  ),
  "Next UI does not use authoritative active-job count"
);

assert(
  nextUi.includes(
    "counts.dueTargets"
  ),
  "Next UI does not use authoritative due-target count"
);

assert(
  nextUi.includes(
    "counts.failedJobs24h"
  ),
  "Next UI does not expose 24-hour failures"
);

assert(
  nextUi.includes(
    "scheduler.next.last_tick"
  ) &&
  nextUi.includes(
    "tickFresh"
  ),
  "Next UI does not verify scheduler freshness"
);

assert(
  nextUi.includes(
    "state.selected.clear()"
  ),
  "filter changes do not protect against hidden bulk selections"
);


/*
 * --------------------------------------------------------------
 * Static validation coverage
 * --------------------------------------------------------------
 */

const checkScript =
  packageJson.scripts?.check || "";

assert(
  checkScript.includes(
    "public/app.js"
  ),
  "legacy frontend syntax check missing"
);

assert(
  checkScript.includes(
    "public/next.js"
  ),
  "Next frontend syntax check missing"
);

assert(
  checkScript.includes(
    "verify-control-plane.mjs"
  ),
  "control-plane regression checker is not part of npm check"
);


console.log(
  "Control-plane regression checks: PASS"
);
