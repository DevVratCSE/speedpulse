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
