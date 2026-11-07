#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

/*
 * ================================================================
 * SpeedPulse pre-freeze audit
 * ================================================================
 *
 * PURPOSE
 * -------
 * This script performs a broad inspection before freezing the app.
 *
 * It checks:
 *
 *   - required project files
 *   - npm/typecheck/regression tests
 *   - Cloudflare Worker dry-run build
 *   - Queue producer + consumer wiring
 *   - Queue retry configuration
 *   - duplicate active-job protection
 *   - PageSpeed transient-error handling
 *   - the known transient-failure/site-status contradiction
 *   - manual polling timeout vs Queue retry timing
 *   - raw provider error rendering
 *   - two-report retention
 *   - missing Queue main-navigation UI
 *   - missing Queue route
 *   - missing last-two logical scans on normal site page
 *   - detailed-report UI wiring
 *   - Settings/runtime drift
 *   - documentation drift
 *   - literal DOM ID references
 *   - TODO/FIXME/HACK/not-implemented markers
 *
 * Optional --remote mode performs READ-ONLY Cloudflare D1 queries:
 *
 *   - recent jobs
 *   - currently active/retrying jobs
 *   - Queue-active but site-last-status=failed contradictions
 *   - duplicate logical jobs
 *   - stale running jobs
 *   - recent terminal Queue errors
 *   - detailed-report retention violations
 *   - cleanup backlog
 *   - recent failed PageSpeed attempts
 *
 * Optional --tail=30 captures approximately 30 seconds of Worker logs.
 *
 * NOTHING in this script:
 *
 *   - deploys
 *   - applies migrations
 *   - deletes rows
 *   - updates D1
 *   - triggers scans
 *   - alters Queue jobs
 *
 * Default exit code is deliberately zero so the whole diagnostic can
 * finish even when problems are found.
 *
 * Use --strict when you want CRITICAL/FAIL findings to exit non-zero.
 *
 * Examples:
 *
 *   node scripts/pre-freeze-audit.mjs
 *
 *   node scripts/pre-freeze-audit.mjs --remote
 *
 *   node scripts/pre-freeze-audit.mjs --remote --tail=30
 *
 *   node scripts/pre-freeze-audit.mjs --strict
 *
 *   node scripts/pre-freeze-audit.mjs --remote --tail=45 --strict
 *
 * ================================================================
 */


const rawArgs =
  process.argv.slice(
    2
  );


const argSet =
  new Set(
    rawArgs
  );


const strict =
  argSet.has(
    "--strict"
  );


const remote =
  argSet.has(
    "--remote"
  );


const skipCommands =
  argSet.has(
    "--skip-commands"
  );


const noDryRun =
  argSet.has(
    "--no-dry-run"
  );


const tailArg =
  rawArgs.find(
    (arg) =>
      arg.startsWith(
        "--tail="
      )
  );


const tailSeconds =
  tailArg
    ? Math.max(
        5,
        Math.min(
          300,
          Number(
            tailArg.split(
              "="
            )[1]
          ) || 30
        )
      )
    : 0;



/*
 * ================================================================
 * Find project root
 * ================================================================
 */

function findProjectRoot(
  startDir
) {
  let current =
    path.resolve(
      startDir
    );


  for (
    let i = 0;
    i < 8;
    i += 1
  ) {
    const packagePath =
      path.join(
        current,
        "package.json"
      );


    if (
      fs.existsSync(
        packagePath
      )
    ) {
      try {
        const pkg =
          JSON.parse(
            fs.readFileSync(
              packagePath,
              "utf8"
            )
          );


        if (
          pkg?.name ===
            "speedpulse" ||
          fs.existsSync(
            path.join(
              current,
              "wrangler.jsonc"
            )
          )
        ) {
          return current;
        }
      } catch {
        if (
          fs.existsSync(
            path.join(
              current,
              "wrangler.jsonc"
            )
          )
        ) {
          return current;
        }
      }
    }


    const parent =
      path.dirname(
        current
      );


    if (
      parent ===
      current
    ) {
      break;
    }


    current =
      parent;
  }


  return null;
}



const root =
  findProjectRoot(
    process.cwd()
  );


if (
  !root
) {
  console.error(
    "[AUDIT] Could not locate the SpeedPulse project root."
  );


  console.error(
    "Run this from the speedpulse-next folder or one of its subfolders."
  );


  process.exit(
    strict
      ? 2
      : 0
  );
}


process.chdir(
  root
);



/*
 * ================================================================
 * Report state
 * ================================================================
 */

const reportPath =
  path.join(
    root,
    "PRE_FREEZE_AUDIT.md"
  );


const findings =
  [];


const commandResults =
  [];


const remoteResults =
  [];


const LEVEL_ORDER =
  [
    "CRITICAL",
    "FAIL",
    "GAP",
    "WARN",
    "PASS",
    "INFO"
  ];



/*
 * ================================================================
 * Generic helpers
 * ================================================================
 */

function cleanText(
  value
) {
  return String(
    value ??
    ""
  )
    .replace(
      /\u001b\[[0-9;]*m/g,
      ""
    )
    .replace(
      /\r/g,
      ""
    )
    .trim();
}



function clip(
  value,
  max = 5000
) {
  const text =
    cleanText(
      value
    );


  if (
    text.length <=
    max
  ) {
    return text;
  }


  return `${text.slice(
    0,
    max
  )}\n... [truncated ${
    text.length -
    max
  } chars]`;
}



function add(
  level,
  area,
  title,
  detail = "",
  evidence = ""
) {
  findings.push({
    level,
    area,
    title,
    detail,
    evidence
  });
}



function pass(
  area,
  title,
  detail = "",
  evidence = ""
) {
  add(
    "PASS",
    area,
    title,
    detail,
    evidence
  );
}



function warn(
  area,
  title,
  detail = "",
  evidence = ""
) {
  add(
    "WARN",
    area,
    title,
    detail,
    evidence
  );
}



function gap(
  area,
  title,
  detail = "",
  evidence = ""
) {
  add(
    "GAP",
    area,
    title,
    detail,
    evidence
  );
}



function fail(
  area,
  title,
  detail = "",
  evidence = ""
) {
  add(
    "FAIL",
    area,
    title,
    detail,
    evidence
  );
}



function critical(
  area,
  title,
  detail = "",
  evidence = ""
) {
  add(
    "CRITICAL",
    area,
    title,
    detail,
    evidence
  );
}



function info(
  area,
  title,
  detail = "",
  evidence = ""
) {
  add(
    "INFO",
    area,
    title,
    detail,
    evidence
  );
}



function fileExists(
  rel
) {
  return fs.existsSync(
    path.join(
      root,
      rel
    )
  );
}



function read(
  rel,
  required = true
) {
  const full =
    path.join(
      root,
      rel
    );


  try {
    return fs.readFileSync(
      full,
      "utf8"
    );
  } catch (
    error
  ) {
    if (
      required
    ) {
      fail(
        "Filesystem",
        `Could not read ${rel}`,
        error instanceof Error
          ? error.message
          : String(
              error
            )
      );
    }


    return "";
  }
}



function check(
  condition,
  area,
  title,
  okDetail,
  badLevel = "WARN",
  badDetail = ""
) {
  if (
    condition
  ) {
    pass(
      area,
      title,
      okDetail ||
        "Detected."
    );


    return true;
  }


  add(
    badLevel,
    area,
    title,
    badDetail ||
      "Not detected."
  );


  return false;
}



/*
 * ================================================================
 * Safe child-process runner
 * ================================================================
 */

function runCommand(
  label,
  command,
  args,
  options = {}
) {
  const timeout =
    options.timeout ??
    120000;


  const cwd =
    options.cwd ??
    root;


  const started =
    Date.now();


  let result;


  try {
    result =
      spawnSync(
        command,
        args,
        {
          cwd,

          encoding:
            "utf8",

          timeout,

          maxBuffer:
            12 *
            1024 *
            1024,

          env: {
            ...process.env,

            CI:
              process.env.CI ||
              "1",

            NO_COLOR:
              process.env.NO_COLOR ||
              "1"
          }
        }
      );
  } catch (
    error
  ) {
    const record = {
      label,

      ok:
        false,

      status:
        null,

      durationMs:
        Date.now() -
        started,

      stdout:
        "",

      stderr:
        error instanceof Error
          ? error.message
          : String(
              error
            ),

      timedOut:
        false
    };


    commandResults.push(
      record
    );


    return record;
  }


  const timedOut =
    Boolean(
      result.error &&
      result.error.code ===
        "ETIMEDOUT"
    );


  const ok =
    result.status ===
      0 ||
    (
      options.timeoutIsExpected &&
      timedOut
    );


  const record = {
    label,

    ok,

    status:
      result.status,

    durationMs:
      Date.now() -
      started,

    stdout:
      clip(
        result.stdout,
        options.maxOutput ??
          8000
      ),

    stderr:
      clip(
        result.stderr,
        options.maxOutput ??
          8000
      ),

    timedOut
  };


  commandResults.push(
    record
  );


  return record;
}



function localWranglerPath() {
  const bin =
    process.platform ===
      "win32"
      ? "wrangler.cmd"
      : "wrangler";


  const candidate =
    path.join(
      root,
      "node_modules",
      ".bin",
      bin
    );


  return fs.existsSync(
    candidate
  )
    ? candidate
    : null;
}



/*
 * ================================================================
 * UI inspection helpers
 * ================================================================
 */

function extractLiteralIds(
  source
) {
  const ids =
    new Set();


  const patterns = [
    /\bid\s*=\s*["'`]([A-Za-z][A-Za-z0-9_:\-.]*)["'`]/g,

    /getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g
  ];


  for (
    const pattern
    of patterns
  ) {
    for (
      const match
      of source.matchAll(
        pattern
      )
    ) {
      ids.add(
        match[1]
      );
    }
  }


  return ids;
}



function extractDollarIdRefs(
  source
) {
  const ids =
    new Set();


  const patterns = [
    /\$\(\s*["'`]#([^"'`]+)["'`]\s*\)/g,

    /querySelector\(\s*["'`]#([^"'`]+)["'`]\s*\)/g
  ];


  for (
    const pattern
    of patterns
  ) {
    for (
      const match
      of source.matchAll(
        pattern
      )
    ) {
      ids.add(
        match[1]
      );
    }
  }


  return ids;
}



function extractApiRefs(
  source
) {
  const refs =
    new Set();


  const regex =
    /\/api\/[A-Za-z0-9_?=&${}./:\-]+/g;


  for (
    const match
    of source.matchAll(
      regex
    )
  ) {
    refs.add(
      match[0]
        .replace(
          /["'`),;]+$/g,
          ""
        )
    );
  }


  return [
    ...refs
  ].sort();
}



function extractRouteValues(
  html
) {
  const routes =
    new Set();


  const regex =
    /data-route\s*=\s*["']([^"']+)["']/g;


  for (
    const match
    of html.matchAll(
      regex
    )
  ) {
    routes.add(
      match[1]
    );
  }


  return [
    ...routes
  ];
}



/*
 * ================================================================
 * Incomplete-code marker scanning
 * ================================================================
 */

function scanMarkers(
  rel,
  source
) {
  const patterns = [
    {
      name:
        "TODO",

      regex:
        /\bTODO\b/gi
    },

    {
      name:
        "FIXME",

      regex:
        /\bFIXME\b/gi
    },

    {
      name:
        "HACK",

      regex:
        /\bHACK\b/gi
    },

    {
      name:
        "XXX",

      regex:
        /\bXXX\b/g
    },

    {
      name:
        "not implemented",

      regex:
        /not implemented/gi
    },

    {
      name:
        "coming soon",

      regex:
        /coming soon/gi
    }
  ];


  for (
    const item
    of patterns
  ) {
    const matches =
      source.match(
        item.regex
      ) ||
      [];


    if (
      matches.length >
      0
    ) {
      warn(
        "Incomplete-code markers",

        `${rel}: ${item.name}`,

        `${matches.length} occurrence(s). Inspect before freeze.`
      );
    }
  }
}



/*
 * ================================================================
 * Wrangler/D1 helpers
 * ================================================================
 */

function parseDatabaseName(
  wrangler
) {
  const match =
    wrangler.match(
      /"database_name"\s*:\s*"([^"]+)"/
    );


  return match?.[1] ||
    null;
}



function runRemoteSql(
  wranglerBin,
  databaseName,
  label,
  sql
) {
  const record =
    runCommand(
      `Remote D1: ${label}`,

      wranglerBin,

      [
        "d1",
        "execute",
        databaseName,
        "--remote",
        "--command",
        sql,
        "--json"
      ],

      {
        timeout:
          90000,

        maxOutput:
          20000
      }
    );


  remoteResults.push({
    label,
    sql,
    ...record
  });


  if (
    !record.ok
  ) {
    warn(
      "Remote diagnostics",

      `${label} could not be queried`,

      "Remote mode is best-effort. This usually means Wrangler is not authenticated, the database binding/name is wrong, or the network is unavailable.",

      record.stderr ||
        record.stdout
    );
  } else {
    pass(
      "Remote diagnostics",

      label,

      "Read-only D1 query completed."
    );
  }


  return record;
}



function countLevels() {
  const counts =
    Object.fromEntries(
      LEVEL_ORDER.map(
        (level) => [
          level,
          0
        ]
      )
    );


  for (
    const item
    of findings
  ) {
    counts[
      item.level
    ] =
      (
        counts[
          item.level
        ] ||
        0
      ) +
      1;
  }


  return counts;
}



/*
 * ================================================================
 * Start
 * ================================================================
 */

console.log(
  "\nSpeedPulse pre-freeze audit"
);


console.log(
  `Project: ${root}`
);


console.log(
  `Mode: ${
    remote
      ? "local + remote read-only diagnostics"
      : "local/static diagnostics"
  }`
);


console.log(
  `Strict exit: ${
    strict
      ? "yes"
      : "no"
  }\n`
);



/*
 * ================================================================
 * 1. FILE AND REPOSITORY SANITY
 * ================================================================
 */

const requiredFiles = [
  "package.json",
  "wrangler.jsonc",
  "tsconfig.json",

  "src/index.ts",
  "src/db.ts",
  "src/queue.ts",
  "src/control-plane.ts",
  "src/pagespeed.ts",
  "src/scan-policy.ts",
  "src/detailed-reports.ts",
  "src/types.ts",

  "public/index.html",
  "public/app.js",
  "public/next.html",
  "public/next.js",

  "scripts/verify-control-plane.mjs",
  "scripts/verify-detailed-reports.mjs"
];


for (
  const rel
  of requiredFiles
) {
  check(
    fileExists(
      rel
    ),

    "Filesystem",

    rel,

    "Present.",

    "FAIL",

    "Required source/check file is missing."
  );
}



const migrationDir =
  path.join(
    root,
    "migrations"
  );


if (
  fs.existsSync(
    migrationDir
  )
) {
  try {
    const migrations =
      fs.readdirSync(
        migrationDir
      )
        .filter(
          (name) =>
            /\.sql$/i.test(
              name
            )
        )
        .sort();


    pass(
      "Filesystem",

      "Migration directory readable",

      `${migrations.length} SQL migration(s): ${migrations.join(
        ", "
      )}`
    );


    check(
      migrations.some(
        (name) =>
          name.startsWith(
            "0006_"
          )
      ),

      "Detailed reports",

      "Checkpoint-17 detailed-report migration",

      "0006 migration found.",

      "WARN",

      "Could not find a 0006 migration. Confirm the detailed_reports/report_cleanup schema migration is present."
    );
  } catch (
    error
  ) {
    warn(
      "Filesystem",

      "Could not enumerate migrations",

      error instanceof Error
        ? error.message
        : String(
            error
          )
    );
  }
} else {
  fail(
    "Filesystem",

    "migrations/ directory missing",

    "Database migrations cannot be verified."
  );
}



const pkgText =
  read(
    "package.json"
  );


let pkg =
  null;


try {
  pkg =
    JSON.parse(
      pkgText
    );


  pass(
    "Package",

    "package.json parses",

    `${pkg.name || "unknown"}@${
      pkg.version ||
      "unknown"
    }`
  );
} catch (
  error
) {
  fail(
    "Package",

    "package.json is invalid JSON",

    error instanceof Error
      ? error.message
      : String(
          error
        )
  );
}



if (
  pkg
) {
  check(
    Boolean(
      pkg.scripts?.check
    ),

    "Package",

    "npm run check exists",

    pkg.scripts?.check ||
      "",

    "FAIL",

    "Add a project-wide validation script before freeze."
  );


  check(
    Boolean(
      pkg.scripts?.typecheck
    ),

    "Package",

    "TypeScript typecheck exists",

    pkg.scripts?.typecheck ||
      "",

    "FAIL",

    "No typecheck script detected."
  );
}



/*
 * ================================================================
 * 2. LOAD SOURCE
 * ================================================================
 */

const wrangler =
  read(
    "wrangler.jsonc"
  );


const indexTs =
  read(
    "src/index.ts"
  );


const dbTs =
  read(
    "src/db.ts"
  );


const queueTs =
  read(
    "src/queue.ts"
  );


const controlTs =
  read(
    "src/control-plane.ts"
  );


const pagespeedTs =
  read(
    "src/pagespeed.ts"
  );


const policyTs =
  read(
    "src/scan-policy.ts"
  );


const reportsTs =
  read(
    "src/detailed-reports.ts"
  );


const typesTs =
  read(
    "src/types.ts"
  );


const indexHtml =
  read(
    "public/index.html"
  );


const appJs =
  read(
    "public/app.js"
  );


const nextHtml =
  read(
    "public/next.html"
  );


const nextJs =
  read(
    "public/next.js"
  );


const readme =
  read(
    "README.md",
    false
  );


const architecture =
  read(
    "ARCHITECTURE.md",
    false
  );



/*
 * ================================================================
 * 3. QUEUE / RUNTIME ARCHITECTURE
 * ================================================================
 */

check(
  wrangler.includes(
    '"QUEUE_SCANS_ENABLED": "1"'
  ),

  "Queue runtime",

  "Queue scanning enabled",

  "QUEUE_SCANS_ENABLED=1.",

  "CRITICAL",

  "Queue scanning is not visibly enabled in wrangler.jsonc."
);



check(
  wrangler.includes(
    '"NEXT_SCHEDULER_ENABLED": "1"'
  ) &&
  wrangler.includes(
    '"LEGACY_SCHEDULER_ENABLED": "0"'
  ),

  "Scheduler",

  "Next scheduler active / legacy scheduler off",

  "Next is enabled and legacy is disabled.",

  "CRITICAL",

  "Scheduler feature flags are not in the expected safe state."
);



check(
  /"queues"\s*:/.test(
    wrangler
  ) &&
  wrangler.includes(
    '"binding": "SCAN_QUEUE"'
  ),

  "Queue runtime",

  "SCAN_QUEUE binding configured",

  "Producer binding found.",

  "CRITICAL",

  "SCAN_QUEUE producer binding is missing."
);



check(
  wrangler.includes(
    '"max_concurrency": 1'
  ),

  "Queue runtime",

  "Single concurrent Lighthouse consumer",

  "max_concurrency=1.",

  "WARN",

  "Queue concurrency is not 1. Re-evaluate Google PSI load, rate limits, and ETA logic before freeze."
);



check(
  wrangler.includes(
    '"max_retries": 3'
  ) &&
  wrangler.includes(
    '"retry_delay": 120'
  ),

  "Queue runtime",

  "Cloudflare Queue retry policy",

  "max_retries=3 and retry_delay=120 seconds detected.",

  "WARN",

  "Expected Queue retry configuration was not found."
);



check(
  wrangler.includes(
    "dead_letter_queue"
  ),

  "Queue runtime",

  "Dead-letter queue configured",

  "DLQ configuration detected.",

  "WARN",

  "No dead-letter queue configuration detected."
);



check(
  indexTs.includes(
    "async queue("
  ) &&
  indexTs.includes(
    "processScanQueueBatch"
  ),

  "Queue runtime",

  "Worker Queue consumer handler",

  "Worker queue() handler delegates to processScanQueueBatch().",

  "CRITICAL",

  "The Worker queue consumer handler is missing or disconnected."
);



check(
  queueTs.includes(
    "enqueueScanJob"
  ) &&
  queueTs.includes(
    "env.SCAN_QUEUE.send"
  ),

  "Queue runtime",

  "Queue producer sends messages",

  "enqueueScanJob() sends to SCAN_QUEUE.",

  "CRITICAL",

  "Queue producer path is missing."
);



check(
  queueTs.includes(
    "isTransientScanError"
  ) &&
  /PageSpeed API \(429\|500\|502\|503\|504\)/i.test(
    queueTs
  ),

  "Error handling",

  "Transient PageSpeed status classification",

  "429/500/502/503/504 classification detected.",

  "CRITICAL",

  "Transient PageSpeed status classification is incomplete or missing."
);



check(
  queueTs.includes(
    "job.attempt < 3"
  ) &&
  queueTs.includes(
    "TRANSIENT_SCAN_ERROR"
  ) &&
  queueTs.includes(
    "TRANSIENT_SCAN_EXHAUSTED"
  ),

  "Error handling",

  "Logical scan retry state",

  "Transient retries and exhausted terminal state detected.",

  "CRITICAL",

  "Expected logical retry / exhausted-state handling is missing."
);



check(
  policyTs.includes(
    "SCAN_RUN_LEASE_MS"
  ) &&
  /5\s*\*\s*60\s*\*\s*1000/.test(
    policyTs
  ),

  "Queue runtime",

  "Shared 5-minute execution lease",

  "Shared scan lease detected.",

  "WARN",

  "Expected shared 5-minute scan lease was not detected."
);



check(
  controlTs.includes(
    "getActiveJob"
  ) &&
  controlTs.includes(
    "status IN ('pending','queued','running')"
  ),

  "Queue correctness",

  "Duplicate-active-job protection",

  "Active-job lookup covers pending/queued/running.",

  "CRITICAL",

  "Could not verify duplicate-active-job protection."
);



check(
  indexTs.includes(
    "/api/next/jobs"
  ) &&
  indexTs.includes(
    "getScanJobById"
  ),

  "Queue observability",

  "Authenticated job status API",

  "Single-job and recent-job API support detected.",

  "CRITICAL",

  "Queue job status API is missing."
);



check(
  indexTs.includes(
    "/api/next/status"
  ) &&
  controlTs.includes(
    "getSystemHealth"
  ),

  "Queue observability",

  "System health API",

  "Queue/scheduler health endpoint detected.",

  "WARN",

  "System health endpoint is missing."
);



/*
 * ================================================================
 * 4. PROVIDER ERROR AND STATE-BOUNDARY CHECKS
 * ================================================================
 */

const providerThrowsOnNonOk =
  pagespeedTs.includes(
    "if (!response.ok)"
  ) &&
  pagespeedTs.includes(
    "PageSpeed API ${response.status}"
  );


check(
  providerThrowsOnNonOk,

  "PageSpeed",

  "Non-2xx provider errors are preserved",

  "PageSpeed HTTP failures are surfaced with status/body.",

  "FAIL",

  "Could not verify that PageSpeed non-2xx responses preserve diagnostic information."
);



const dbWritesSiteFailed =
  dbTs.includes(
    "SET ${columns.status}='failed'"
  ) &&
  dbTs.includes(
    "${columns.error}=?"
  );


const queueCanRetryAfterThrownRun =
  queueTs.includes(
    "return await handleScanFailure"
  ) &&
  queueTs.includes(
    "requeueScanJob"
  );


if (
  dbWritesSiteFailed &&
  queueCanRetryAfterThrownRun
) {
  critical(
    "State correctness",

    "Intermediate transient attempts can mark the SITE failed before Queue retries are exhausted",

    "runSiteTest() writes the site-level last status/error as failed when the provider attempt throws, while queue.ts can then requeue the same logical job. This creates the exact refresh pattern where the page shows a red final-looking error even though the Queue is still retrying.",

    "Fix target: keep failed test_runs, but only promote site.*_last_status/site.*_last_error to failed after the logical scan job reaches terminal failure."
  );
} else {
  pass(
    "State correctness",

    "Intermediate failure/site state separation",

    "The known premature site-failure pattern was not detected by the audit heuristic."
  );
}



/*
 * ================================================================
 * 5. POLLING / RETRY TIMING
 * ================================================================
 */

const browserWait120 =
  /timeoutMs\s*=\s*120000/.test(
    appJs
  );


const retryDelay120 =
  wrangler.includes(
    '"retry_delay": 120'
  ) ||
  queueTs.includes(
    "delaySeconds:\n            120"
  ) ||
  queueTs.includes(
    "delaySeconds: 120"
  );


if (
  browserWait120 &&
  retryDelay120
) {
  warn(
    "Manual-run UX",

    "Browser wait window equals one Queue retry delay",

    "The site page stops following a job after 120 seconds, while a transient Queue retry itself waits about 120 seconds. A valid job can therefore outlive the UI's active follow window by several minutes.",

    "Recommended: show persistent job state on the site and Queue page; do not treat the polling timeout as failure."
  );
} else {
  info(
    "Manual-run UX",

    "Polling/retry timing heuristic",

    "The exact 120s/120s timing pattern was not detected."
  );
}



/*
 * ================================================================
 * 6. RAW ERROR PRESENTATION
 * ================================================================
 */

if (
  appJs.includes(
    "lastError ?"
  ) &&
  appJs.includes(
    "form-error"
  )
) {
  warn(
    "Error presentation",

    "Raw site last_error is rendered directly as the primary red banner",

    "This exposes large Google JSON/provider messages to the user and makes transient failures look terminal.",

    "Recommended: friendly summary first; raw provider details under an expandable technical-details control."
  );
}



/*
 * ================================================================
 * 7. LAST-TWO DETAILED REPORTS
 * ================================================================
 */

check(
  /const\s+RETAIN_READY_REPORTS\s*=\s*2\s*;/.test(
    reportsTs
  ),

  "Detailed reports",

  "Retention is two ready reports per site/strategy",

  "RETAIN_READY_REPORTS=2.",

  "CRITICAL",

  "Two-report retention constant was not detected."
);



check(
  reportsTs.includes(
    "OFFSET ?"
  ) &&
  reportsTs.includes(
    "RETAIN_READY_REPORTS"
  ),

  "Detailed reports",

  "Older ready reports are retired",

  "Retention enforcement query detected.",

  "WARN",

  "Could not verify retention cleanup selection."
);



check(
  /ORDER BY[\s\S]{0,180}captured_at DESC[\s\S]{0,180}LIMIT 2/.test(
    reportsTs
  ),

  "Detailed reports",

  "Report listing returns newest two",

  "Newest-two query detected.",

  "WARN",

  "Could not verify the listDetailedReports LIMIT 2 query."
);



/*
 * ================================================================
 * 8. LAST-TWO LOGICAL SCANS ON NORMAL SITE PAGE
 * ================================================================
 */

const mainSiteHasRecentScans =
  /Recent scans/i.test(
    appJs
  ) ||
  /last two scans/i.test(
    appJs
  ) ||
  /newest two/i.test(
    appJs
  );


if (
  !mainSiteHasRecentScans
) {
  gap(
    "Main site UI",

    "Last-two logical scans are not exposed on the normal site page",

    "The backend keeps Queue job history and detailed reports, but public/app.js does not appear to render a two-scan operational record on #site/:id.",

    "Implement from scan_jobs (logical jobs), not raw test_runs, so retries do not look like separate user scans."
  );
} else {
  pass(
    "Main site UI",

    "Recent/last-two scan UI detected",

    "A recent-scan section appears in public/app.js."
  );
}



/*
 * ================================================================
 * 9. DETAILED REPORT UI IN NORMAL APP
 * ================================================================
 */

const mainSiteUsesDetailedReports =
  appJs.includes(
    "/api/next/sites/"
  ) &&
  (
    appJs.includes(
      "reports?strategy"
    ) ||
    appJs.includes(
      "report-comparison"
    )
  );


if (
  !mainSiteUsesDetailedReports
) {
  gap(
    "Main site UI",

    "Checkpoint-17 detailed report UI is not wired into the normal site page",

    "The separate Next UI has report rendering, but the normal SpeedPulse site page does not appear to call the detailed-report endpoints.",

    "Port the comparison/report views into #site/:id instead of duplicating the report backend."
  );
} else {
  pass(
    "Main site UI",

    "Detailed report API wired into normal site UI",

    "Detected report endpoint usage in public/app.js."
  );
}



/*
 * ================================================================
 * 10. QUEUE WORKSPACE UI COMPLETENESS
 * ================================================================
 */

const mainRoutes =
  extractRouteValues(
    indexHtml
  );


const queueNavPresent =
  mainRoutes.some(
    (route) =>
      /queue/i.test(
        route
      )
  ) ||
  /data-route=["']#queue/i.test(
    indexHtml
  );


const queueRouterPresent =
  /#queue/.test(
    appJs
  ) &&
  /renderQueue|queue/i.test(
    appJs
  );


if (
  !queueNavPresent
) {
  gap(
    "Main navigation",

    "Queue menu item missing",

    `Detected routes: ${
      mainRoutes.join(
        ", "
      ) ||
      "none"
    }.`,

    "Add Queue under Overview/Projects in public/index.html."
  );
} else {
  pass(
    "Main navigation",

    "Queue menu item present",

    "A Queue route is present in the main sidebar."
  );
}



if (
  !queueRouterPresent
) {
  gap(
    "Main navigation",

    "Queue route/rendering missing in public/app.js",

    "No clear #queue rendering path was detected.",

    "Reuse /api/next/jobs and /api/next/status; poll while the Queue page is visible."
  );
} else {
  pass(
    "Main navigation",

    "Queue route/rendering detected",

    "#queue handling appears implemented."
  );
}



/*
 * Existing separate management UI can act as reference implementation.
 */

check(
  nextJs.includes(
    "/api/next/jobs?limit=30"
  ) &&
  nextJs.includes(
    "/api/next/status"
  ),

  "Reusable implementation",

  "Next management UI already consumes queue health/jobs",

  "Existing code can be ported into the main UI.",

  "INFO",

  "The separate management UI does not contain the expected operational API usage."
);



/*
 * ================================================================
 * 11. SETTINGS / RUNTIME DRIFT
 * ================================================================
 */

const nextSchedulerEnabled =
  wrangler.includes(
    '"NEXT_SCHEDULER_ENABLED": "1"'
  );


const legacyBatchStillExposed =
  indexTs.includes(
    "scheduleBatchSize"
  ) &&
  indexTs.includes(
    "SCHEDULE_BATCH_SIZE"
  );


if (
  nextSchedulerEnabled &&
  legacyBatchStillExposed
) {
  warn(
    "Settings",

    "Settings API still exposes legacy SCHEDULE_BATCH_SIZE while Next scheduler is active",

    "This can make the Settings modal describe the old execution model (for example, max tests per cron: 1) even though Next scheduler + Queue dispatch is active.",

    "Expose Next scheduler batch/budget and Queue concurrency/retry values instead."
  );
}



/*
 * ================================================================
 * 12. DOCUMENTATION DRIFT
 * ================================================================
 */

const staleDocPattern =
  /one due (target|test).*5-minute/i;


if (
  nextSchedulerEnabled &&
  (
    staleDocPattern.test(
      readme
    ) ||
    staleDocPattern.test(
      architecture
    )
  )
) {
  warn(
    "Documentation",

    "Old one-test-per-five-minutes scheduler wording remains",

    "Runtime is Next scheduler + Queue, but README/ARCHITECTURE still appear to describe the legacy direct scheduler in places.",

    "Refresh docs only after runtime semantics are frozen."
  );
}



/*
 * ================================================================
 * 13. UI SELECTOR SANITY
 * ================================================================
 */

function inspectUiPair(
  name,
  html,
  js
) {
  const defined =
    new Set([
      ...extractLiteralIds(
        html
      ),

      ...extractLiteralIds(
        js
      )
    ]);


  const referenced =
    extractDollarIdRefs(
      js
    );


  const missing =
    [
      ...referenced
    ]
      .filter(
        (id) =>
          !defined.has(
            id
          )
      )
      .sort();


  if (
    missing.length ===
    0
  ) {
    pass(
      "UI selector sanity",

      `${name}: literal #id references resolve`,

      `${referenced.size} selector ID(s) checked against static + template-defined IDs.`
    );
  } else {
    warn(
      "UI selector sanity",

      `${name}: ${missing.length} selector ID(s) have no literal definition`,

      missing
        .slice(
          0,
          40
        )
        .join(
          ", "
        ),

      "This is a heuristic: dynamically constructed IDs may be legitimate. Inspect each before freeze."
    );
  }
}



inspectUiPair(
  "Main UI",
  indexHtml,
  appJs
);


inspectUiPair(
  "Next UI",
  nextHtml,
  nextJs
);



/*
 * ================================================================
 * 14. API INVENTORY
 * ================================================================
 */

const mainApiRefs =
  extractApiRefs(
    appJs
  );


const nextApiRefs =
  extractApiRefs(
    nextJs
  );


info(
  "API inventory",

  "Main UI API references",

  `${mainApiRefs.length} unique literal/dynamic references.`,

  mainApiRefs.join(
    "\n"
  )
);


info(
  "API inventory",

  "Next UI API references",

  `${nextApiRefs.length} unique literal/dynamic references.`,

  nextApiRefs.join(
    "\n"
  )
);



/*
 * ================================================================
 * 15. INCOMPLETE CODE MARKERS
 * ================================================================
 */

const scanFiles = {
  "src/index.ts":
    indexTs,

  "src/db.ts":
    dbTs,

  "src/queue.ts":
    queueTs,

  "src/control-plane.ts":
    controlTs,

  "src/pagespeed.ts":
    pagespeedTs,

  "src/detailed-reports.ts":
    reportsTs,

  "public/app.js":
    appJs,

  "public/next.js":
    nextJs,

  "README.md":
    readme,

  "ARCHITECTURE.md":
    architecture
};


for (
  const [
    rel,
    source
  ]
  of Object.entries(
    scanFiles
  )
) {
  if (
    source
  ) {
    scanMarkers(
      rel,
      source
    );
  }
}


if (
  !findings.some(
    (item) =>
      item.area ===
      "Incomplete-code markers"
  )
) {
  pass(
    "Incomplete-code markers",

    "No TODO/FIXME/HACK/XXX/coming-soon markers detected",

    "No obvious placeholder marker was found in the audited core files."
  );
}



/*
 * ================================================================
 * 16. LOCAL COMMAND QUALITY GATES
 * ================================================================
 */

if (
  !skipCommands
) {
  /*
   * Node
   */

  const nodeVersion =
    runCommand(
      "node --version",

      process.execPath,

      [
        "--version"
      ],

      {
        timeout:
          10000
      }
    );


  if (
    nodeVersion.ok
  ) {
    pass(
      "Local commands",

      "Node executable works",

      nodeVersion.stdout
    );
  } else {
    fail(
      "Local commands",

      "Node executable failed",

      nodeVersion.stderr ||
        nodeVersion.stdout
    );
  }


  /*
   * Git whitespace check
   */

  const gitDiffCheck =
    runCommand(
      "git diff --check",

      "git",

      [
        "diff",
        "--check"
      ],

      {
        timeout:
          30000
      }
    );


  if (
    gitDiffCheck.ok
  ) {
    pass(
      "Git",

      "git diff --check",

      "No whitespace errors in the working diff."
    );
  } else {
    warn(
      "Git",

      "git diff --check failed",

      gitDiffCheck.stderr ||
        gitDiffCheck.stdout
    );
  }


  /*
   * Working tree
   */

  const gitStatus =
    runCommand(
      "git status --short",

      "git",

      [
        "status",
        "--short"
      ],

      {
        timeout:
          30000
      }
    );


  if (
    gitStatus.ok
  ) {
    if (
      cleanText(
        gitStatus.stdout
      )
    ) {
      warn(
        "Git",

        "Working tree is not clean",

        "Uncommitted/untracked files exist. This is not automatically an error, but inspect before freeze.",

        gitStatus.stdout
      );
    } else {
      pass(
        "Git",

        "Working tree clean",

        "No uncommitted changes detected."
      );
    }
  } else {
    warn(
      "Git",

      "Could not read git status",

      gitStatus.stderr ||
        gitStatus.stdout
    );
  }


  /*
   * Project checks
   */

  if (
    fs.existsSync(
      path.join(
        root,
        "node_modules"
      )
    )
  ) {
    const npmCheck =
      runCommand(
        "npm run check",

        "npm",

        [
          "run",
          "check"
        ],

        {
          timeout:
            240000,

          maxOutput:
            16000
        }
      );


    if (
      npmCheck.ok
    ) {
      pass(
        "Local commands",

        "npm run check",

        `Passed in ${(
          npmCheck.durationMs /
          1000
        ).toFixed(
          1
        )}s.`,

        npmCheck.stdout
      );
    } else {
      fail(
        "Local commands",

        "npm run check failed",

        `Exit ${
          npmCheck.status ??
          "unknown"
        }.`,

        `${npmCheck.stdout}\n${npmCheck.stderr}`
      );
    }


    /*
     * Wrangler dry run
     */

    if (
      !noDryRun
    ) {
      const wranglerBin =
        localWranglerPath();


      if (
        wranglerBin
      ) {
        const dry =
          runCommand(
            "wrangler deploy --dry-run",

            wranglerBin,

            [
              "deploy",
              "--dry-run"
            ],

            {
              timeout:
                180000,

              maxOutput:
                16000
            }
          );


        if (
          dry.ok
        ) {
          pass(
            "Local commands",

            "Cloudflare Worker dry-run build",

            `Passed in ${(
              dry.durationMs /
              1000
            ).toFixed(
              1
            )}s.`,

            dry.stdout
          );
        } else {
          fail(
            "Local commands",

            "Cloudflare Worker dry-run build failed",

            `Exit ${
              dry.status ??
              "unknown"
            }.`,

            `${dry.stdout}\n${dry.stderr}`
          );
        }
      } else {
        warn(
          "Local commands",

          "Skipped Wrangler dry-run",

          "Local node_modules/.bin/wrangler was not found. Run npm install first; this audit intentionally does not install dependencies automatically."
        );
      }
    }
  } else {
    warn(
      "Local commands",

      "Skipped npm run check / Wrangler dry-run",

      "node_modules is missing. Run npm install, then rerun the audit. The audit does not mutate dependencies automatically."
    );
  }
} else {
  info(
    "Local commands",

    "Command execution skipped",

    "--skip-commands was provided; only static inspection ran."
  );
}



/*
 * ================================================================
 * 17. OPTIONAL LIVE / READ-ONLY REMOTE D1 DIAGNOSTICS
 * ================================================================
 */

if (
  remote
) {
  const wranglerBin =
    localWranglerPath();


  const databaseName =
    parseDatabaseName(
      wrangler
    );


  if (
    !wranglerBin
  ) {
    warn(
      "Remote diagnostics",

      "Remote diagnostics skipped",

      "Local Wrangler binary not found. Run npm install, authenticate Wrangler, and rerun with --remote."
    );
  } else if (
    !databaseName
  ) {
    warn(
      "Remote diagnostics",

      "Remote diagnostics skipped",

      "Could not parse database_name from wrangler.jsonc."
    );
  } else {
    info(
      "Remote diagnostics",

      "Remote database target",

      databaseName
    );


    /*
     * ------------------------------------------------------------
     * Recent Queue jobs
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Recent queue jobs",

      `
SELECT
  j.id,
  j.site_id,
  s.name AS site_name,
  p.name AS project_name,
  j.strategy,
  j.trigger,
  j.status,
  j.attempt,
  j.priority,
  j.queued_at,
  j.started_at,
  j.completed_at,
  j.error_class,
  substr(
    j.error_message,
    1,
    300
  ) AS error_message,
  j.created_at,
  j.updated_at

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

JOIN projects p
  ON p.id = s.project_id

ORDER BY
  j.created_at DESC,
  j.id DESC

LIMIT 50;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Current active/retrying jobs
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Active/retrying queue jobs",

      `
SELECT
  j.id,
  s.name AS site_name,
  p.name AS project_name,
  j.strategy,
  j.trigger,
  j.status,
  j.attempt,
  j.error_class,

  substr(
    j.error_message,
    1,
    240
  ) AS error_message,

  j.queued_at,
  j.started_at,
  j.updated_at

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

JOIN projects p
  ON p.id = s.project_id

WHERE
  j.status IN (
    'pending',
    'queued',
    'running'
  )

ORDER BY
  CASE j.status
    WHEN 'running'
      THEN 0
    WHEN 'queued'
      THEN 1
    ELSE 2
  END,

  j.priority DESC,
  j.created_at ASC

LIMIT 100;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * This query directly looks for the bug/pattern we discussed:
     *
     * Queue says job is alive.
     * Site says last scan failed.
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Active job vs site-failed contradictions",

      `
SELECT
  j.id AS job_id,

  j.status AS job_status,

  j.attempt,

  j.strategy,

  s.id AS site_id,

  s.name AS site_name,

  CASE
    WHEN j.strategy = 'mobile'
      THEN s.mobile_last_status
    ELSE s.desktop_last_status
  END AS site_last_status,

  substr(
    CASE
      WHEN j.strategy = 'mobile'
        THEN s.mobile_last_error
      ELSE s.desktop_last_error
    END,
    1,
    300
  ) AS site_last_error

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

WHERE
  j.status IN (
    'pending',
    'queued',
    'running'
  )

  AND

  CASE
    WHEN j.strategy = 'mobile'
      THEN s.mobile_last_status = 'failed'
    ELSE s.desktop_last_status = 'failed'
  END

ORDER BY
  j.updated_at DESC

LIMIT 100;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Duplicate logical jobs
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Duplicate active logical jobs",

      `
SELECT
  site_id,
  strategy,

  COUNT(*) AS active_count,

  GROUP_CONCAT(
    id
  ) AS job_ids

FROM scan_jobs

WHERE
  status IN (
    'pending',
    'queued',
    'running'
  )

GROUP BY
  site_id,
  strategy

HAVING
  COUNT(*) > 1

ORDER BY
  active_count DESC;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Stale running jobs
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Stale running jobs over five minutes",

      `
SELECT
  id,
  site_id,
  strategy,
  trigger,
  attempt,
  started_at,
  updated_at,
  error_class,

  substr(
    error_message,
    1,
    240
  ) AS error_message

FROM scan_jobs

WHERE
  status = 'running'

  AND
  started_at IS NOT NULL

  AND
  started_at <
    datetime(
      'now',
      '-5 minutes'
    )

ORDER BY
  started_at ASC;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Last 24h terminal queue failures
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Terminal queue failures in last 24 hours",

      `
SELECT
  j.id,
  s.name AS site_name,
  p.name AS project_name,
  j.strategy,
  j.trigger,
  j.attempt,
  j.error_class,

  substr(
    j.error_message,
    1,
    400
  ) AS error_message,

  j.completed_at

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

JOIN projects p
  ON p.id = s.project_id

WHERE
  j.status = 'failed'

  AND
  j.completed_at >=
    datetime(
      'now',
      '-24 hours'
    )

ORDER BY
  j.completed_at DESC

LIMIT 100;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Two-report retention invariant
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Detailed-report retention violations",

      `
SELECT
  site_id,
  strategy,

  COUNT(*) AS ready_reports

FROM detailed_reports

WHERE
  state = 'ready'

GROUP BY
  site_id,
  strategy

HAVING
  COUNT(*) > 2

ORDER BY
  ready_reports DESC;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Detailed-report cleanup health
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Detailed-report cleanup backlog",

      `
SELECT

  (
    SELECT
      COUNT(*)

    FROM detailed_reports

    WHERE
      state = 'cleanup_pending'
  )
  AS cleanup_pending_reports,

  (
    SELECT
      COUNT(*)

    FROM report_cleanup_tasks
  )
  AS cleanup_tasks;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Recent PageSpeed/test attempts that failed
     * ------------------------------------------------------------
     */

    runRemoteSql(
      wranglerBin,

      databaseName,

      "Recent failed PageSpeed attempts",

      `
SELECT
  tr.id AS test_run_id,

  tr.site_id,

  s.name AS site_name,

  tr.strategy,

  tr.source,

  tr.started_at,

  tr.completed_at,

  substr(
    tr.error_message,
    1,
    400
  ) AS error_message

FROM test_runs tr

JOIN sites s
  ON s.id = tr.site_id

WHERE
  tr.status = 'failed'

ORDER BY
  tr.completed_at DESC

LIMIT 50;
      `.trim()
    );


    /*
     * ------------------------------------------------------------
     * Optional short Worker log capture
     * ------------------------------------------------------------
     */

    if (
      tailSeconds >
      0
    ) {
      const tail =
        runCommand(
          `wrangler tail (${tailSeconds}s)`,

          wranglerBin,

          [
            "tail",
            "--format",
            "pretty"
          ],

          {
            timeout:
              tailSeconds *
              1000,

            /*
             * Timing out is expected because tail normally runs forever.
             */
            timeoutIsExpected:
              true,

            maxOutput:
              30000
          }
        );


      if (
        tail.ok
      ) {
        pass(
          "Remote diagnostics",

          `Live Worker log sample (${tailSeconds}s)`,

          "Tail window completed. Review captured log output in the report.",

          `${tail.stdout}\n${tail.stderr}`
        );
      } else {
        warn(
          "Remote diagnostics",

          "Live Worker tail failed",

          "Tail is optional and non-destructive.",

          `${tail.stdout}\n${tail.stderr}`
        );
      }
    }
  }
} else {
  info(
    "Remote diagnostics",

    "Remote checks not run",

    "Rerun with --remote for read-only D1 queue/error inspection. Add --tail=30 to capture 30 seconds of Worker logs."
  );
}



/*
 * ================================================================
 * 18. BUILD REPORT
 * ================================================================
 */

const counts =
  countLevels();


const orderedFindings =
  [
    ...findings
  ].sort(
    (
      a,
      b
    ) => {
      const la =
        LEVEL_ORDER.indexOf(
          a.level
        );


      const lb =
        LEVEL_ORDER.indexOf(
          b.level
        );


      return (
        la -
          lb ||
        a.area.localeCompare(
          b.area
        ) ||
        a.title.localeCompare(
          b.title
        )
      );
    }
  );



const report =
  [];


report.push(
  "# SpeedPulse Pre-Freeze Audit"
);


report.push(
  ""
);


report.push(
  `Generated: ${new Date().toISOString()}`
);


report.push(
  `Project: \`${root}\``
);


report.push(
  `Mode: ${
    remote
      ? "local + remote read-only diagnostics"
      : "local/static diagnostics"
  }`
);


report.push(
  ""
);


report.push(
  "## Summary"
);


report.push(
  ""
);


report.push(
  `- CRITICAL: ${counts.CRITICAL}`
);


report.push(
  `- FAIL: ${counts.FAIL}`
);


report.push(
  `- GAP: ${counts.GAP}`
);


report.push(
  `- WARN: ${counts.WARN}`
);


report.push(
  `- PASS: ${counts.PASS}`
);


report.push(
  `- INFO: ${counts.INFO}`
);


report.push(
  ""
);


report.push(
  "Default audit mode always completes and writes this report. Use `--strict` when you want CRITICAL/FAIL findings to produce a non-zero exit code."
);


report.push(
  ""
);



/*
 * ================================================================
 * Findings by severity
 * ================================================================
 */

for (
  const level
  of LEVEL_ORDER
) {
  const items =
    orderedFindings.filter(
      (item) =>
        item.level ===
        level
    );


  if (
    items.length ===
    0
  ) {
    continue;
  }


  report.push(
    `## ${level}`
  );


  report.push(
    ""
  );


  for (
    const item
    of items
  ) {
    report.push(
      `### ${item.area} — ${item.title}`
    );


    report.push(
      ""
    );


    if (
      item.detail
    ) {
      report.push(
        item.detail
      );
    }


    if (
      item.evidence
    ) {
      report.push(
        ""
      );


      report.push(
        "```text"
      );


      report.push(
        clip(
          item.evidence,
          12000
        )
      );


      report.push(
        "```"
      );
    }


    report.push(
      ""
    );
  }
}



/*
 * ================================================================
 * Command output
 * ================================================================
 */

if (
  commandResults.length >
  0
) {
  report.push(
    "## Command execution details"
  );


  report.push(
    ""
  );


  for (
    const cmd
    of commandResults
  ) {
    report.push(
      `### ${cmd.label}`
    );


    report.push(
      ""
    );


    report.push(
      `- ok: ${cmd.ok}`
    );


    report.push(
      `- exit: ${
        cmd.status ??
        "null"
      }`
    );


    report.push(
      `- duration: ${(
        cmd.durationMs /
        1000
      ).toFixed(
        2
      )}s`
    );


    report.push(
      `- timedOut: ${cmd.timedOut}`
    );


    if (
      cmd.stdout
    ) {
      report.push(
        ""
      );


      report.push(
        "stdout:"
      );


      report.push(
        "```text"
      );


      report.push(
        cmd.stdout
      );


      report.push(
        "```"
      );
    }


    if (
      cmd.stderr
    ) {
      report.push(
        ""
      );


      report.push(
        "stderr:"
      );


      report.push(
        "```text"
      );


      report.push(
        cmd.stderr
      );


      report.push(
        "```"
      );
    }


    report.push(
      ""
    );
  }
}



/*
 * ================================================================
 * Store remote SQL for auditing/reproducibility
 * ================================================================
 */

if (
  remoteResults.length >
  0
) {
  report.push(
    "## Remote SQL used (read-only)"
  );


  report.push(
    ""
  );


  for (
    const item
    of remoteResults
  ) {
    report.push(
      `### ${item.label}`
    );


    report.push(
      ""
    );


    report.push(
      "```sql"
    );


    report.push(
      item.sql
    );


    report.push(
      "```"
    );


    report.push(
      ""
    );
  }
}



/*
 * ================================================================
 * Recommended work order
 * ================================================================
 */

report.push(
  "## Recommended next engineering order"
);


report.push(
  ""
);


report.push(
  "1. Fix the transient-attempt/site-final-state boundary so intermediate Google 500s remain retrying, not final site failures."
);


report.push(
  "2. Add the main Queue workspace using existing `/api/next/jobs` + `/api/next/status` data."
);


report.push(
  "3. Add the last-two logical scan records to the normal site page, backed by `scan_jobs`, and link successful scans to retained detailed reports."
);


report.push(
  "4. Replace raw provider-error primary banners with friendly retry/failure state plus expandable technical details."
);


report.push(
  "5. Update Settings/docs to describe the Next scheduler + Queue runtime, then run this audit in `--remote --tail=30 --strict` mode before tagging the freeze."
);


report.push(
  ""
);



/*
 * ================================================================
 * Write report safely
 * ================================================================
 */

try {
  fs.writeFileSync(
    reportPath,
    `${report.join(
      "\n"
    )}\n`,
    "utf8"
  );


  console.log(
    `Audit report written: ${reportPath}`
  );
} catch (
  error
) {
  console.error(
    "Could not write PRE_FREEZE_AUDIT.md:",

    error instanceof Error
      ? error.message
      : String(
          error
        )
  );
}



/*
 * ================================================================
 * Terminal summary
 * ================================================================
 */

console.log(
  "\nSummary:"
);


for (
  const level
  of LEVEL_ORDER
) {
  if (
    counts[
      level
    ]
  ) {
    console.log(
      `  ${level.padEnd(
        8
      )} ${
        counts[
          level
        ]
      }`
    );
  }
}



const top =
  orderedFindings
    .filter(
      (item) =>
        [
          "CRITICAL",
          "FAIL",
          "GAP"
        ].includes(
          item.level
        )
    )
    .slice(
      0,
      12
    );


if (
  top.length >
  0
) {
  console.log(
    "\nTop items:"
  );


  for (
    const item
    of top
  ) {
    console.log(
      `  [${item.level}] ${item.area}: ${item.title}`
    );
  }
}



console.log(
  `\nDone. Full report: ${reportPath}`
);


if (
  !remote
) {
  console.log(
    "For live read-only queue diagnostics: node scripts/pre-freeze-audit.mjs --remote --tail=30"
  );
}


if (
  !strict
) {
  console.log(
    "For CI/freeze gating: node scripts/pre-freeze-audit.mjs --strict"
  );
}



/*
 * ================================================================
 * Default = finish successfully.
 *
 * Strict mode = fail CI if genuine hard issues remain.
 * ================================================================
 */

const hasHardFailure =
  findings.some(
    (item) =>
      item.level ===
        "CRITICAL" ||
      item.level ===
        "FAIL"
  );


process.exit(
  strict &&
  hasHardFailure
    ? 1
    : 0
);

