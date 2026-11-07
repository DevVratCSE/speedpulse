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
