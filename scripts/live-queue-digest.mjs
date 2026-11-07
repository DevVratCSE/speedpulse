#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

/*
 * ================================================================
 * SpeedPulse LIVE Queue / PageSpeed state digest
 * ================================================================
 *
 * READ ONLY.
 *
 * This script:
 *
 *   - does NOT deploy
 *   - does NOT run migrations
 *   - does NOT trigger PageSpeed
 *   - does NOT enqueue jobs
 *   - does NOT update D1
 *   - does NOT delete anything
 *
 * It only executes SELECT statements against the configured
 * remote D1 database.
 *
 * The script intentionally exits 0 even if it discovers problems,
 * so every diagnostic can finish and be reported.
 *
 * Output:
 *
 *   LIVE_QUEUE_DIGEST.md
 *
 * ================================================================
 */


const ROOT =
  process.cwd();


const WRANGLER_FILE =
  path.join(
    ROOT,
    "wrangler.jsonc"
  );


const AUDIT_FILE =
  path.join(
    ROOT,
    "PRE_FREEZE_AUDIT.md"
  );


const OUTPUT_FILE =
  path.join(
    ROOT,
    "LIVE_QUEUE_DIGEST.md"
  );


const WRANGLER_BIN =
  path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32"
      ? "wrangler.cmd"
      : "wrangler"
  );


function clean(
  value
) {
  return String(
    value ?? ""
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
  maximum = 12000
) {
  const text =
    clean(
      value
    );


  if (
    text.length <=
    maximum
  ) {
    return text;
  }


  return (
    text.slice(
      0,
      maximum
    ) +
    `\n... [truncated ${
      text.length -
      maximum
    } chars]`
  );
}


function dieSoft(
  message
) {
  console.error(
    `\nERROR: ${message}`
  );


  console.error(
    "\nThe diagnostic stopped safely. No data was changed."
  );


  process.exit(
    0
  );
}


/*
 * ---------------------------------------------------------------
 * Environment validation
 * ---------------------------------------------------------------
 */

if (
  !fs.existsSync(
    WRANGLER_FILE
  )
) {
  dieSoft(
    "wrangler.jsonc was not found. Run this from speedpulse-next."
  );
}


if (
  !fs.existsSync(
    WRANGLER_BIN
  )
) {
  dieSoft(
    "Local Wrangler was not found. Run npm install first."
  );
}


const wranglerText =
  fs.readFileSync(
    WRANGLER_FILE,
    "utf8"
  );


const databaseMatch =
  wranglerText.match(
    /"database_name"\s*:\s*"([^"]+)"/
  );


if (
  !databaseMatch
) {
  dieSoft(
    "Could not determine database_name from wrangler.jsonc."
  );
}


const DATABASE =
  databaseMatch[1];


console.log(
  "\n============================================================"
);


console.log(
  "SpeedPulse live Queue digest"
);


console.log(
  "============================================================"
);


console.log(
  `Database: ${DATABASE}`
);


console.log(
  "Mode: REMOTE D1 / SELECT ONLY"
);


console.log(
  "No scans will be triggered.\n"
);



/*
 * ---------------------------------------------------------------
 * Result handling
 * ---------------------------------------------------------------
 */

function parseWranglerRows(
  stdout
) {
  const text =
    clean(
      stdout
    );


  if (
    !text
  ) {
    return [];
  }


  let parsed;


  try {
    parsed =
      JSON.parse(
        text
      );
  } catch {
    /*
     * Wrangler normally emits pure JSON with --json.
     *
     * If some informational text appears before it, try to locate
     * the first JSON array/object.
     */
    const arrayAt =
      text.indexOf(
        "["
      );


    const objectAt =
      text.indexOf(
        "{"
      );


    let start =
      -1;


    if (
      arrayAt >= 0 &&
      objectAt >= 0
    ) {
      start =
        Math.min(
          arrayAt,
          objectAt
        );
    } else {
      start =
        Math.max(
          arrayAt,
          objectAt
        );
    }


    if (
      start < 0
    ) {
      throw new Error(
        "Wrangler output did not contain JSON."
      );
    }


    parsed =
      JSON.parse(
        text.slice(
          start
        )
      );
  }


  const collect =
    (
      value,
      rows
    ) => {
      if (
        value ===
          null ||
        value ===
          undefined
      ) {
        return;
      }


      if (
        Array.isArray(
          value
        )
      ) {
        for (
          const item
          of value
        ) {
          collect(
            item,
            rows
          );
        }


        return;
      }


      if (
        typeof value !==
        "object"
      ) {
        return;
      }


      if (
        Array.isArray(
          value.results
        )
      ) {
        rows.push(
          ...value.results
        );


        return;
      }


      if (
        value.result
      ) {
        collect(
          value.result,
          rows
        );
      }
    };


  const rows =
    [];


  collect(
    parsed,
    rows
  );


  return rows;
}


function runSql(
  name,
  sql
) {
  const started =
    Date.now();


  const result =
    spawnSync(
      WRANGLER_BIN,
      [
        "d1",
        "execute",
        DATABASE,
        "--remote",
        "--command",
        sql,
        "--json"
      ],
      {
        cwd:
          ROOT,

        encoding:
          "utf8",

        timeout:
          90000,

        maxBuffer:
          16 *
          1024 *
          1024,

        env: {
          ...process.env,
          NO_COLOR:
            "1"
        }
      }
    );


  const seconds =
    (
      (
        Date.now() -
        started
      ) /
      1000
    ).toFixed(
      2
    );


  if (
    result.error
  ) {
    return {
      name,
      sql,
      ok:
        false,
      rows:
        [],
      seconds,
      error:
        result.error.message
    };
  }


  if (
    result.status !==
    0
  ) {
    return {
      name,
      sql,
      ok:
        false,
      rows:
        [],
      seconds,
      error:
        clip(
          result.stderr ||
          result.stdout
        )
    };
  }


  try {
    return {
      name,
      sql,
      ok:
        true,
      rows:
        parseWranglerRows(
          result.stdout
        ),
      seconds,
      error:
        null
    };
  } catch (
    error
  ) {
    return {
      name,
      sql,
      ok:
        false,
      rows:
        [],
      seconds,
      error:
        `Could not parse Wrangler JSON: ${
          error instanceof Error
            ? error.message
            : String(
                error
              )
        }\n\nRaw output:\n${clip(
          result.stdout
        )}`
    };
  }
}



/*
 * ---------------------------------------------------------------
 * Queries
 * ---------------------------------------------------------------
 */

const queries = [
  {
    key:
      "active",

    level:
      "INFO",

    title:
      "CURRENT ACTIVE / RETRYING QUEUE",

    sql:
      `
SELECT

  j.id,

  j.site_id,

  s.name
    AS site_name,

  p.name
    AS project_name,

  j.strategy,

  j.trigger,

  j.status,

  CASE

    WHEN
      j.status = 'queued'
      AND j.attempt > 0
      AND j.error_class = 'TRANSIENT_SCAN_ERROR'

      THEN 'retrying'

    ELSE
      j.status

  END
    AS effective_status,

  j.attempt,

  j.priority,

  j.test_run_id,

  j.error_class,

  substr(
    j.error_message,
    1,
    300
  )
    AS error_message,

  j.created_at,

  j.queued_at,

  j.started_at,

  j.updated_at,

  CAST(
    MAX(
      0,

      (
        julianday('now') -
        julianday(j.created_at)
      ) *
      86400
    )
    AS INTEGER
  )
    AS age_seconds,

  CASE

    WHEN
      j.status = 'queued'
      AND j.attempt > 0
      AND j.error_class = 'TRANSIENT_SCAN_ERROR'

    THEN
      CAST(
        MAX(
          0,

          (
            julianday(
              j.updated_at,
              '+120 seconds'
            ) -
            julianday('now')
          ) *
          86400
        )
        AS INTEGER
      )

    ELSE
      NULL

  END
    AS approximate_retry_in_seconds

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

  CASE

    WHEN
      j.status = 'running'
      THEN 0

    WHEN
      j.status = 'queued'
      AND j.attempt > 0
      THEN 1

    WHEN
      j.status = 'queued'
      THEN 2

    ELSE 3

  END,

  j.priority DESC,

  j.created_at ASC,

  j.id ASC

LIMIT 1000;
      `.trim()
  },


  {
    key:
      "contradictions",

    level:
      "CRITICAL",

    title:
      "ACTIVE QUEUE JOBS WHOSE SITE ALREADY SAYS FAILED",

    sql:
      `
SELECT

  j.id
    AS job_id,

  j.status
    AS queue_status,

  j.attempt,

  j.strategy,

  j.error_class,

  substr(
    j.error_message,
    1,
    250
  )
    AS queue_error,

  s.id
    AS site_id,

  s.name
    AS site_name,

  p.name
    AS project_name,

  CASE

    WHEN
      j.strategy = 'mobile'

      THEN
        s.mobile_last_status

    ELSE
      s.desktop_last_status

  END
    AS site_last_status,

  substr(
    CASE

      WHEN
        j.strategy = 'mobile'

        THEN
          s.mobile_last_error

      ELSE
        s.desktop_last_error

    END,
    1,
    400
  )
    AS site_last_error,

  j.created_at,

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

  AND

  CASE

    WHEN
      j.strategy = 'mobile'

      THEN
        s.mobile_last_status = 'failed'

    ELSE
      s.desktop_last_status = 'failed'

  END

ORDER BY
  j.updated_at DESC

LIMIT 500;
      `.trim()
  },


  {
    key:
      "duplicates",

    level:
      "CRITICAL",

    title:
      "DUPLICATE ACTIVE LOGICAL SCANS",

    sql:
      `
SELECT

  j.site_id,

  s.name
    AS site_name,

  j.strategy,

  COUNT(*)
    AS active_count,

  GROUP_CONCAT(
    j.id
  )
    AS job_ids,

  GROUP_CONCAT(
    j.status
  )
    AS statuses

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

WHERE
  j.status IN (
    'pending',
    'queued',
    'running'
  )

GROUP BY
  j.site_id,
  s.name,
  j.strategy

HAVING
  COUNT(*) > 1

ORDER BY
  active_count DESC;
      `.trim()
  },


  {
    key:
      "stale",

    level:
      "WARN",

    title:
      "RUNNING QUEUE JOBS OLDER THAN FIVE MINUTES",

    sql:
      `
SELECT

  j.id,

  j.site_id,

  s.name
    AS site_name,

  j.strategy,

  j.trigger,

  j.attempt,

  j.test_run_id,

  j.started_at,

  j.updated_at,

  CAST(
    (
      julianday('now') -
      julianday(j.started_at)
    ) *
    86400
    AS INTEGER
  )
    AS running_seconds,

  j.error_class,

  substr(
    j.error_message,
    1,
    300
  )
    AS error_message

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

WHERE

  j.status = 'running'

  AND
  j.started_at IS NOT NULL

  AND
  julianday(j.started_at) <
  julianday(
    'now',
    '-5 minutes'
  )

ORDER BY
  j.started_at ASC;
      `.trim()
  },


  {
    key:
      "successfulButActive",

    level:
      "WARN",

    title:
      "ACTIVE QUEUE JOBS ALREADY LINKED TO SUCCESSFUL TEST RUNS",

    sql:
      `
SELECT

  j.id
    AS job_id,

  j.status
    AS queue_status,

  j.site_id,

  s.name
    AS site_name,

  j.strategy,

  j.attempt,

  j.test_run_id,

  tr.status
    AS test_run_status,

  tr.completed_at
    AS test_completed_at,

  j.updated_at

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

JOIN test_runs tr
  ON tr.id = j.test_run_id

WHERE

  j.status IN (
    'pending',
    'queued',
    'running'
  )

  AND
  tr.status = 'success'

ORDER BY
  j.updated_at ASC;
      `.trim()
  },


  {
    key:
      "terminalFailures",

    level:
      "INFO",

    title:
      "TERMINAL QUEUE FAILURES IN LAST 24 HOURS",

    sql:
      `
SELECT

  j.id,

  j.site_id,

  s.name
    AS site_name,

  p.name
    AS project_name,

  j.strategy,

  j.trigger,

  j.attempt,

  j.error_class,

  substr(
    j.error_message,
    1,
    500
  )
    AS error_message,

  j.created_at,

  j.completed_at

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

JOIN projects p
  ON p.id = s.project_id

WHERE

  j.status = 'failed'

  AND
  j.completed_at IS NOT NULL

  AND
  julianday(
    j.completed_at
  ) >=
  julianday(
    'now',
    '-1 day'
  )

ORDER BY
  j.completed_at DESC

LIMIT 100;
      `.trim()
  },


  {
    key:
      "failedAttempts",

    level:
      "INFO",

    title:
      "FAILED PAGESPEED TEST ATTEMPTS",

    sql:
      `
SELECT

  tr.id
    AS test_run_id,

  tr.site_id,

  s.name
    AS site_name,

  tr.strategy,

  tr.source,

  tr.started_at,

  tr.completed_at,

  CAST(
    (
      julianday(tr.completed_at) -
      julianday(tr.started_at)
    ) *
    86400
    AS INTEGER
  )
    AS duration_seconds,

  substr(
    tr.error_message,
    1,
    500
  )
    AS error_message

FROM test_runs tr

JOIN sites s
  ON s.id = tr.site_id

WHERE
  tr.status = 'failed'

ORDER BY
  tr.completed_at DESC,
  tr.id DESC

LIMIT 50;
      `.trim()
  },


  {
    key:
      "recentSuccess",

    level:
      "INFO",

    title:
      "RECENT SUCCESSFUL LOGICAL SCANS",

    sql:
      `
SELECT

  j.id,

  j.site_id,

  s.name
    AS site_name,

  j.strategy,

  j.trigger,

  j.attempt,

  j.test_run_id,

  j.created_at,

  j.started_at,

  j.completed_at,

  CAST(
    (
      julianday(j.completed_at) -
      julianday(j.created_at)
    ) *
    86400
    AS INTEGER
  )
    AS total_job_seconds

FROM scan_jobs j

JOIN sites s
  ON s.id = j.site_id

WHERE
  j.status = 'success'

ORDER BY
  j.completed_at DESC

LIMIT 30;
      `.trim()
  },


  {
    key:
      "reportRetention",

    level:
      "WARN",

    title:
      "DETAILED REPORT RETENTION VIOLATIONS (>2 READY)",

    sql:
      `
SELECT

  dr.site_id,

  s.name
    AS site_name,

  dr.strategy,

  COUNT(*)
    AS ready_reports,

  GROUP_CONCAT(
    dr.id
  )
    AS report_ids

FROM detailed_reports dr

JOIN sites s
  ON s.id = dr.site_id

WHERE
  dr.state = 'ready'

GROUP BY
  dr.site_id,
  s.name,
  dr.strategy

HAVING
  COUNT(*) > 2

ORDER BY
  ready_reports DESC;
      `.trim()
  },


  {
    key:
      "reportOverview",

    level:
      "INFO",

    title:
      "DETAILED REPORT STORAGE / CLEANUP STATE",

    sql:
      `
SELECT

  (
    SELECT
      COUNT(*)

    FROM detailed_reports

    WHERE
      state = 'ready'
  )
    AS ready_reports,

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
    AS cleanup_tasks,

  (
    SELECT
      COALESCE(
        SUM(size_bytes),
        0
      )

    FROM detailed_reports

    WHERE
      state = 'ready'
  )
    AS ready_bytes;
      `.trim()
  },


  {
    key:
      "systemState",

    level:
      "INFO",

    title:
      "RECENT QUEUE / SCHEDULER SYSTEM STATE",

    sql:
      `
SELECT

  key,

  value_json,

  updated_at

FROM system_state

WHERE

  key LIKE 'queue.%'

  OR
  key LIKE 'scheduler.%'

ORDER BY
  updated_at DESC

LIMIT 50;
      `.trim()
  },


  {
    key:
      "targetHealth",

    level:
      "INFO",

    title:
      "SCHEDULER TARGET HEALTH",

    sql:
      `
SELECT

  COUNT(*)
    AS total_targets,

  SUM(
    CASE
      WHEN enabled = 1
      THEN 1
      ELSE 0
    END
  )
    AS enabled_targets,

  SUM(
    CASE
      WHEN
        enabled = 1

        AND
        next_due_at IS NOT NULL

        AND
        julianday(next_due_at) <=
        julianday('now')

      THEN 1

      ELSE 0
    END
  )
    AS due_targets,

  SUM(
    CASE
      WHEN last_failure_at IS NOT NULL
      THEN 1
      ELSE 0
    END
  )
    AS targets_with_recorded_failure

FROM scan_targets;
      `.trim()
  }
];



/*
 * ---------------------------------------------------------------
 * Execute everything
 * ---------------------------------------------------------------
 */

const results =
  [];


for (
  let i = 0;
  i < queries.length;
  i += 1
) {
  const query =
    queries[
      i
    ];


  process.stdout.write(
    `[${i + 1}/${queries.length}] ${query.title} ... `
  );


  const result =
    runSql(
      query.title,
      query.sql
    );


  result.key =
    query.key;


  result.level =
    query.level;


  results.push(
    result
  );


  if (
    !result.ok
  ) {
    console.log(
      "QUERY ERROR"
    );
  } else {
    console.log(
      `${result.rows.length} row(s)`
    );
  }
}



/*
 * ---------------------------------------------------------------
 * Extract WARN headings from PRE_FREEZE_AUDIT.md
 * ---------------------------------------------------------------
 */

function extractAuditWarnings() {
  if (
    !fs.existsSync(
      AUDIT_FILE
    )
  ) {
    return [];
  }


  const text =
    fs.readFileSync(
      AUDIT_FILE,
      "utf8"
    );


  const start =
    text.indexOf(
      "\n## WARN\n"
    );


  if (
    start < 0
  ) {
    return [];
  }


  const rest =
    text.slice(
      start +
      1
    );


  const nextSection =
    rest.search(
      /\n## (?:PASS|INFO|CRITICAL|FAIL|GAP|Command execution details|Remote SQL)/m
    );


  const section =
    nextSection >= 0
      ? rest.slice(
          0,
          nextSection
        )
      : rest;


  return [
    ...section.matchAll(
      /^### (.+)$/gm
    )
  ].map(
    (match) =>
      match[1]
  );
}


const auditWarnings =
  extractAuditWarnings();



/*
 * ---------------------------------------------------------------
 * Severity evaluation
 * ---------------------------------------------------------------
 */

const byKey =
  Object.fromEntries(
    results.map(
      (result) => [
        result.key,
        result
      ]
    )
  );


const liveFindings =
  [];


function addFinding(
  level,
  message
) {
  liveFindings.push({
    level,
    message
  });
}


if (
  byKey.contradictions?.ok &&
  byKey.contradictions.rows.length >
  0
) {
  addFinding(
    "CRITICAL",
    `${byKey.contradictions.rows.length} active Queue job(s) currently have a site-level FAILED status.`
  );
}


if (
  byKey.duplicates?.ok &&
  byKey.duplicates.rows.length >
  0
) {
  addFinding(
    "CRITICAL",
    `${byKey.duplicates.rows.length} site/strategy pair(s) have duplicate active logical jobs.`
  );
}


if (
  byKey.stale?.ok &&
  byKey.stale.rows.length >
  0
) {
  addFinding(
    "WARN",
    `${byKey.stale.rows.length} running job(s) are older than the five-minute execution lease.`
  );
}


if (
  byKey.successfulButActive?.ok &&
  byKey.successfulButActive.rows.length >
  0
) {
  addFinding(
    "WARN",
    `${byKey.successfulButActive.rows.length} Queue job(s) are still active despite already having a successful linked test_run.`
  );
}


if (
  byKey.reportRetention?.ok &&
  byKey.reportRetention.rows.length >
  0
) {
  addFinding(
    "WARN",
    `${byKey.reportRetention.rows.length} site/strategy pair(s) have more than two ready detailed reports.`
  );
}


const queryFailures =
  results.filter(
    (result) =>
      !result.ok
  );


if (
  queryFailures.length >
  0
) {
  addFinding(
    "WARN",
    `${queryFailures.length} read-only diagnostic query/queries failed to execute or parse.`
  );
}


if (
  liveFindings.length ===
  0
) {
  addFinding(
    "PASS",
    "No live contradiction, duplicate-active-job, stale-job, successful-but-active, or report-retention problem was detected by these queries."
  );
}



/*
 * ---------------------------------------------------------------
 * Human-friendly terminal summary
 * ---------------------------------------------------------------
 */

console.log(
  "\n============================================================"
);


console.log(
  "LIVE FINDINGS"
);


console.log(
  "============================================================\n"
);


for (
  const finding
  of liveFindings
) {
  console.log(
    `[${finding.level}] ${finding.message}`
  );
}


if (
  auditWarnings.length >
  0
) {
  console.log(
    "\nStatic audit WARN headings:"
  );


  for (
    const warning
    of auditWarnings
  ) {
    console.log(
      `  - ${warning}`
    );
  }
}



/*
 * Print the sections we most need directly into Terminal.
 */

const importantKeys =
  [
    "active",
    "contradictions",
    "duplicates",
    "stale",
    "successfulButActive",
    "terminalFailures",
    "failedAttempts",
    "reportRetention",
    "reportOverview",
    "systemState"
  ];


for (
  const key
  of importantKeys
) {
  const result =
    byKey[
      key
    ];


  if (
    !result
  ) {
    continue;
  }


  console.log(
    "\n------------------------------------------------------------"
  );


  console.log(
    result.name
  );


  console.log(
    "------------------------------------------------------------"
  );


  if (
    !result.ok
  ) {
    console.log(
      `ERROR:\n${result.error}`
    );


    continue;
  }


  if (
    result.rows.length ===
    0
  ) {
    console.log(
      "(no rows)"
    );


    continue;
  }


  console.log(
    JSON.stringify(
      result.rows,
      null,
      2
    )
  );
}



/*
 * ---------------------------------------------------------------
 * Markdown report
 * ---------------------------------------------------------------
 */

const md =
  [];


md.push(
  "# SpeedPulse Live Queue Digest"
);


md.push(
  ""
);


md.push(
  `Generated: ${new Date().toISOString()}`
);


md.push(
  `Database: \`${DATABASE}\``
);


md.push(
  ""
);


md.push(
  "> Read-only diagnostic. No scans, writes, migrations, deploys or deletions were performed."
);


md.push(
  ""
);


md.push(
  "## Live findings"
);


md.push(
  ""
);


for (
  const finding
  of liveFindings
) {
  md.push(
    `- **${finding.level}** — ${finding.message}`
  );
}


md.push(
  ""
);


if (
  auditWarnings.length >
  0
) {
  md.push(
    "## Static audit warning headings"
  );


  md.push(
    ""
  );


  for (
    const warning
    of auditWarnings
  ) {
    md.push(
      `- ${warning}`
    );
  }


  md.push(
    ""
  );
}


for (
  const result
  of results
) {
  md.push(
    `## ${result.name}`
  );


  md.push(
    ""
  );


  md.push(
    `Execution: ${
      result.ok
        ? "OK"
        : "ERROR"
    } · ${result.seconds}s`
  );


  md.push(
    ""
  );


  if (
    !result.ok
  ) {
    md.push(
      "```text"
    );


    md.push(
      clip(
        result.error,
        20000
      )
    );


    md.push(
      "```"
    );


    md.push(
      ""
    );


    continue;
  }


  md.push(
    `Rows: ${result.rows.length}`
  );


  md.push(
    ""
  );


  md.push(
    "```json"
  );


  md.push(
    JSON.stringify(
      result.rows,
      null,
      2
    )
  );


  md.push(
    "```"
  );


  md.push(
    ""
  );
}


md.push(
  "## Interpretation guide"
);


md.push(
  ""
);


md.push(
  "- `ACTIVE QUEUE JOBS WHOSE SITE ALREADY SAYS FAILED` should ideally contain zero rows after the retry-state fix."
);


md.push(
  "- `DUPLICATE ACTIVE LOGICAL SCANS` must contain zero rows."
);


md.push(
  "- `RUNNING QUEUE JOBS OLDER THAN FIVE MINUTES` should normally contain zero rows."
);


md.push(
  "- `ACTIVE QUEUE JOBS ALREADY LINKED TO SUCCESSFUL TEST RUNS` should normally contain zero rows, except for a very short finalization window."
);


md.push(
  "- `DETAILED REPORT RETENTION VIOLATIONS` must contain zero rows."
);


md.push(
  "- Failed `test_runs` are not automatically a bug because retries intentionally preserve individual provider attempts."
);


md.push(
  "- Terminal `scan_jobs` failures are the user-visible logical failures we care about."
);


md.push(
  ""
);


try {
  fs.writeFileSync(
    OUTPUT_FILE,
    `${md.join(
      "\n"
    )}\n`,
    "utf8"
  );


  console.log(
    "\n============================================================"
  );


  console.log(
    `Report written: ${OUTPUT_FILE}`
  );
} catch (
  error
) {
  console.error(
    "\nCould not write LIVE_QUEUE_DIGEST.md:"
  );


  console.error(
    error instanceof Error
      ? error.message
      : String(
          error
        )
  );
}


console.log(
  "\nDiagnostic complete. No data was modified.\n"
);


/*
 * Always finish successfully so all results are available.
 */
process.exit(
  0
);

