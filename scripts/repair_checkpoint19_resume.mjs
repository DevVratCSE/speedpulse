import fs from "node:fs";
import path from "node:path";
import process from "node:process";


/*
 * ================================================================
 * Checkpoint-19 partial-install repair
 * ================================================================
 *
 * PURPOSE
 *
 * The first Checkpoint-19 installer stopped after it had already:
 *
 *   - added SCAN_QUEUE_RETRY_DELAY_SECONDS
 *   - imported it into control-plane.ts
 *   - added getQueueWorkspace()
 *   - imported the retry policy into queue.ts
 *
 * It then failed because it expected two retry statements to have
 * identical whitespace.
 *
 * This script ONLY repairs that interrupted step.
 *
 * It does not:
 *
 *   - deploy
 *   - run migrations
 *   - contact Cloudflare
 *   - modify D1
 *   - trigger scans
 *
 * After this script succeeds, the original Checkpoint-19 installer
 * can safely be rerun. Its idempotency markers will skip the pieces
 * that were already applied and continue with the remaining UI/API.
 * ================================================================
 */


const ROOT =
  process.cwd();


const queuePath =
  path.join(
    ROOT,
    "src",
    "queue.ts"
  );


const policyPath =
  path.join(
    ROOT,
    "src",
    "scan-policy.ts"
  );


const controlPath =
  path.join(
    ROOT,
    "src",
    "control-plane.ts"
  );


const installerPath =
  path.join(
    ROOT,
    "scripts",
    "apply_checkpoint19.py"
  );


const requiredFiles = [
  queuePath,
  policyPath,
  controlPath,
  installerPath
];


function stop(
  message
) {
  console.error();
  console.error(
    `ERROR: ${message}`
  );

  console.error();
  console.error(
    "Repair stopped safely."
  );

  console.error(
    "No deployment or remote database operation was performed."
  );

  process.exit(
    1
  );
}


for (
  const file
  of requiredFiles
) {
  if (
    !fs.existsSync(
      file
    )
  ) {
    stop(
      `Missing required file: ${path.relative(
        ROOT,
        file
      )}`
    );
  }
}


/*
 * ================================================================
 * Backup
 * ================================================================
 */

const stamp =
  new Date()
    .toISOString()
    .replace(
      /[-:TZ.]/g,
      ""
    )
    .slice(
      0,
      14
    );


const backupRoot =
  path.join(
    ROOT,
    "backups",
    `checkpoint19_resume_${stamp}`
  );


fs.mkdirSync(
  backupRoot,
  {
    recursive:
      true
  }
);


function backup(
  source
) {
  const relative =
    path.relative(
      ROOT,
      source
    );


  const destination =
    path.join(
      backupRoot,
      relative
    );


  fs.mkdirSync(
    path.dirname(
      destination
    ),
    {
      recursive:
        true
    }
  );


  fs.copyFileSync(
    source,
    destination
  );
}


backup(
  queuePath
);


backup(
  policyPath
);


backup(
  controlPath
);


backup(
  installerPath
);


console.log(
  `Backup created: ${backupRoot}`
);


/*
 * ================================================================
 * Validate the partial Checkpoint-19 state
 * ================================================================
 */

let queue =
  fs.readFileSync(
    queuePath,
    "utf8"
  );


const policy =
  fs.readFileSync(
    policyPath,
    "utf8"
  );


const control =
  fs.readFileSync(
    controlPath,
    "utf8"
  );


if (
  !policy.includes(
    "SCAN_QUEUE_RETRY_DELAY_SECONDS"
  )
) {
  stop(
    "src/scan-policy.ts does not contain SCAN_QUEUE_RETRY_DELAY_SECONDS."
  );
}


if (
  !queue.includes(
    "SCAN_QUEUE_RETRY_DELAY_SECONDS"
  )
) {
  stop(
    "src/queue.ts does not contain the shared retry-policy import."
  );
}


if (
  !control.includes(
    "CHECKPOINT-19: main Queue workspace"
  )
) {
  stop(
    "The partially-installed getQueueWorkspace() backend was not found."
  );
}


console.log(
  "PASS: shared retry-delay policy exists"
);


console.log(
  "PASS: queue.ts imports shared retry-delay policy"
);


console.log(
  "PASS: partial Queue workspace backend exists"
);


/*
 * ================================================================
 * Inspect Queue retry statements before repair
 * ================================================================
 */

function delayValues(
  source
) {
  return [
    ...source.matchAll(
      /delaySeconds\s*:\s*([A-Za-z0-9_]+)/g
    )
  ].map(
    (match) =>
      match[1]
  );
}


console.log();
console.log(
  "delaySeconds values before repair:"
);


for (
  const [
    index,
    value
  ]
  of delayValues(
    queue
  ).entries()
) {
  console.log(
    `  ${index + 1}. ${value}`
  );
}


/*
 * ================================================================
 * Robust repair
 *
 * Match:
 *
 *     delaySeconds: 120
 *
 * as well as:
 *
 *     delaySeconds:
 *       120
 *
 * regardless of whitespace.
 *
 * We do NOT replace the separate 300-second queue-disabled delay.
 * ================================================================
 */

const literalRetryPattern =
  /delaySeconds\s*:\s*120\b/g;


const sharedRetryPattern =
  /delaySeconds\s*:\s*SCAN_QUEUE_RETRY_DELAY_SECONDS\b/g;


const literalBefore =
  (
    queue.match(
      literalRetryPattern
    ) ||
    []
  ).length;


const sharedBefore =
  (
    queue.match(
      sharedRetryPattern
    ) ||
    []
  ).length;


console.log();
console.log(
  `Literal 120-second Queue retry values: ${literalBefore}`
);


console.log(
  `Already shared-policy Queue retry values: ${sharedBefore}`
);


/*
 * Replace every remaining literal retry value.
 *
 * The replacement formatting deliberately matches the
 * already_marker used by apply_checkpoint19.py:
 *
 *   delaySeconds:
 *             SCAN_QUEUE_RETRY_DELAY_SECONDS
 *
 * Therefore, when the original installer is rerun, its brittle
 * replacement step will now SKIP before checking an exact count.
 */
if (
  literalBefore >
  0
) {
  queue =
    queue.replace(
      literalRetryPattern,
      "delaySeconds:\n            SCAN_QUEUE_RETRY_DELAY_SECONDS"
    );


  fs.writeFileSync(
    queuePath,
    queue,
    "utf8"
  );


  console.log(
    `PASS: replaced ${literalBefore} remaining literal Queue retry value(s)`
  );
} else {
  console.log(
    "PASS: no literal 120-second retry values remain"
  );
}


/*
 * ================================================================
 * Reload + strict verification
 * ================================================================
 */

queue =
  fs.readFileSync(
    queuePath,
    "utf8"
  );


const literalAfter =
  (
    queue.match(
      literalRetryPattern
    ) ||
    []
  ).length;


const sharedAfter =
  (
    queue.match(
      sharedRetryPattern
    ) ||
    []
  ).length;


if (
  literalAfter !==
  0
) {
  stop(
    `${literalAfter} literal delaySeconds: 120 value(s) remain.`
  );
}


if (
  sharedAfter <
  2
) {
  stop(
    `Expected at least two shared Queue retry sites; found ${sharedAfter}.`
  );
}


console.log(
  `PASS: ${sharedAfter} Queue retry sites now use SCAN_QUEUE_RETRY_DELAY_SECONDS`
);


/*
 * The Queue-disabled safety path is intentionally 300 seconds.
 */
const hasDisabledDelay =
  /delaySeconds\s*:\s*300\b/.test(
    queue
  );


if (
  !hasDisabledDelay
) {
  console.warn(
    "WARN: the expected 300-second queue-disabled retry was not detected."
  );
} else {
  console.log(
    "PASS: separate 300-second queue-disabled safety delay remains unchanged"
  );
}


/*
 * ================================================================
 * Show resulting retry-related source lines
 * ================================================================
 */

console.log();
console.log(
  "Retry-policy source lines after repair:"
);


const lines =
  queue.split(
    "\n"
  );


for (
  let index = 0;
  index <
  lines.length;
  index += 1
) {
  const line =
    lines[
      index
    ];


  if (
    line.includes(
      "delaySeconds"
    ) ||
    line.includes(
      "SCAN_QUEUE_RETRY_DELAY_SECONDS"
    )
  ) {
    console.log(
      `  ${index + 1}: ${line.trim()}`
    );
  }
}


console.log();
console.log(
  "============================================================"
);


console.log(
  "CHECKPOINT-19 PARTIAL REPAIR PASSED"
);


console.log(
  "============================================================"
);


console.log();
console.log(
  "The original Checkpoint-19 installer can now be rerun."
);


console.log(
  "Previously applied sections should be skipped automatically."
);


console.log();
console.log(
  `Backup: ${backupRoot}`
);

