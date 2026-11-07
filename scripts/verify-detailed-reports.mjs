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
      `DETAILED-REPORT CHECK FAILED: ${message}`
    );
  }
}


const files = {
  migration:
    read(
      "migrations/0006_detailed_reports.sql"
    ),

  types:
    read(
      "src/types.ts"
    ),

  cloudflare:
    read(
      "src/cloudflare.d.ts"
    ),

  pagespeed:
    read(
      "src/pagespeed.ts"
    ),

  reports:
    read(
      "src/detailed-reports.ts"
    ),

  db:
    read(
      "src/db.ts"
    ),

  queue:
    read(
      "src/queue.ts"
    ),

  control:
    read(
      "src/control-plane.ts"
    ),

  scheduler:
    read(
      "src/scheduler.ts"
    ),

  schedule:
    read(
      "src/schedule-engine.ts"
    ),

  bulk:
    read(
      "src/bulk.ts"
    ),

  index:
    read(
      "src/index.ts"
    ),

  html:
    read(
      "public/next.html"
    ),

  ui:
    read(
      "public/next.js"
    ),

  wrangler:
    read(
      "wrangler.jsonc"
    )
};


check(
  files.migration.includes(
    "report_cleanup_tasks"
  ) &&
  files.migration.includes(
    "report_daily_usage"
  ),
  "cleanup/usage schema missing"
);


check(
  files.migration.includes(
    "size_bytes <= 409600"
  ),
  "400 KiB database guard missing"
);


check(
  files.types.includes(
    "REPORTS: KVNamespace"
  ),
  "REPORTS is not Workers KV"
);


check(
  !files.types.includes(
    "R2Bucket"
  ),
  "R2 remains in Env"
);


check(
  files.cloudflare.includes(
    "interface KVNamespace"
  ) &&
  !files.cloudflare.includes(
    "interface R2Bucket"
  ),
  "Cloudflare storage types are not KV-only"
);


check(
  files.pagespeed.includes(
    "buildDetailedReportPayload"
  ) &&
  files.pagespeed.includes(
    "COMPACT_REPORT_TARGET_BYTES"
  ),
  "compact Lighthouse builder missing"
);


check(
  !files.pagespeed.includes(
    "rawJson"
  ),
  "full raw PSI payload is still retained"
);


check(
  files.reports.includes(
    "MAX_DETAILED_REPORT_BYTES"
  ) &&
  files.reports.includes(
    "env.REPORTS.put"
  ) &&
  files.reports.includes(
    "env.REPORTS.get"
  ) &&
  files.reports.includes(
    "env.REPORTS.delete"
  ),
  "KV report lifecycle incomplete"
);


check(
  files.reports.includes(
    "reserveWrite"
  ) &&
  files.reports.includes(
    "reserveDelete"
  ),
  "KV operation budgets missing"
);


check(
  files.reports.includes(
    "report_cleanup_tasks"
  ) &&
  files.reports.includes(
    "cleanup_pending"
  ),
  "retention cleanup queue missing"
);


check(
  files.db.includes(
    "storeDetailedReport"
  ) &&
  files.db.includes(
    "detailedReportStatus"
  ),
  "scan/report integration missing"
);


check(
  files.queue.includes(
    "linkedSuccessfulRun"
  ) &&
  files.queue.includes(
    "result.completedAt"
  ),
  "provider-free Queue recovery missing"
);


check(
  files.control.includes(
    "countScheduledJobsSince"
  ),
  "scheduler usage counting missing"
);


check(
  files.scheduler.includes(
    "budgetRemaining"
  ) &&
  files.scheduler.includes(
    "600"
  ),
  "600/day automatic scan budget missing"
);


check(
  files.schedule.includes(
    "deterministicIntervalJitterMinutes"
  ) &&
  files.schedule.includes(
    "strategyOffset"
  ),
  "mobile/desktop phase spreading missing"
);


check(
  files.bulk.includes(
    "spreadApplied"
  ),
  "bulk deterministic spreading missing"
);


check(
  files.index.includes(
    "getDetailedReportJsonResponse"
  ) &&
  files.index.includes(
    "processDetailedReportCleanup"
  ) &&
  files.index.includes(
    "/api/next/reports/cleanup"
  ),
  "KV Worker API integration missing"
);


check(
  !files.index.includes(
    "getDetailedReportRawResponse"
  ),
  "R2 raw-report API remains"
);


check(
  files.html.includes(
    'id="reportPanel"'
  ) &&
  files.ui.includes(
    "Detailed JSON"
  ) &&
  files.ui.includes(
    "/json"
  ),
  "detailed report UI incomplete"
);


check(
  files.wrangler.includes(
    '"kv_namespaces"'
  ) &&
  files.wrangler.includes(
    '"binding": "REPORTS"'
  ),
  "KV Worker binding missing"
);


check(
  !files.wrangler.includes(
    '"r2_buckets"'
  ),
  "R2 configuration remains"
);


check(
  files.wrangler.includes(
    '"DETAILED_REPORTS_DAILY_WRITE_BUDGET": "800"'
  ) &&
  files.wrangler.includes(
    '"DETAILED_REPORTS_DAILY_DELETE_BUDGET": "800"'
  ),
  "KV operation safety budgets missing"
);


check(
  files.wrangler.includes(
    '"DETAILED_REPORTS_CLEANUP_PER_CRON": "3"'
  ),
  "cleanup throughput configuration missing"
);


check(
  files.wrangler.includes(
    '"NEXT_SCHEDULER_DAILY_BUDGET": "600"'
  ),
  "automatic scheduler budget config missing"
);


console.log(
  "Detailed report KV regression checks: PASS"
);
