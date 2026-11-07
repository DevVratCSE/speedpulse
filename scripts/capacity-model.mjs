#!/usr/bin/env node

/**
 * SpeedPulse Free-Tier Capacity Model
 *
 * Parametric model calculating daily resource consumption and theoretical / safe
 * capacity limits on Cloudflare's Free tier and Google PageSpeed API.
 *
 * Usage:
 *   node scripts/capacity-model.mjs [options]
 *
 * Options:
 *   --sites=<number>          Number of active sites (default: 165)
 *   --mobile-freq=<freq>      Mobile scan frequency: daily|weekly|hourly (default: daily)
 *   --desktop-freq=<freq>     Desktop scan frequency: daily|weekly|hourly (default: weekly)
 *   --cron-interval=<minutes> Cron tick interval in minutes (default: 5)
 *   --batch-size=<number>     Scheduler batch size dispatched per tick (default: 1)
 *   --next-batch-size=<num>   Next-scheduler batch size (default: 25)
 *   --retention-days=<number> D1 metrics retention window in days (default: 90)
 *   --kv-report-retention=<n> Detailed reports retained per strategy (default: 2)
 *   --format=<table|json|md>  Output format (default: table)
 */

import process from "node:process";

// -----------------------------------------------------------------------------
// Reference Free Limits (Verified official docs as of Nov 2026)
// -----------------------------------------------------------------------------
export const FREE_LIMITS = {
  workersRequests: {
    limit: 100_000,
    unit: "requests/day",
    source: "https://developers.cloudflare.com/workers/platform/limits/#request-limits",
    reset: "00:00 UTC",
    notes: "Platform invocations (cron triggers and queue consumers) count toward this limit"
  },
  workersCpuTime: {
    limit: 10,
    unit: "ms CPU / invocation",
    source: "https://developers.cloudflare.com/workers/platform/limits/#cpu-time",
    reset: "per invocation",
    notes: "Applies to HTTP requests and cron triggers. Network I/O does not count against CPU"
  },
  kvReads: {
    limit: 100_000,
    unit: "reads/day",
    source: "https://developers.cloudflare.com/kv/platform/limits/",
    reset: "00:00 UTC",
    notes: "Cache hit/miss on KV edge"
  },
  kvWrites: {
    limit: 1_000,
    unit: "writes/day",
    source: "https://developers.cloudflare.com/kv/platform/limits/",
    reset: "00:00 UTC",
    notes: "Max 1 write/sec to same key"
  },
  kvDeletes: {
    limit: 1_000,
    unit: "deletes/day",
    source: "https://developers.cloudflare.com/kv/platform/limits/",
    reset: "00:00 UTC",
    notes: "Asynchronous pruning operations"
  },
  kvStorage: {
    limit: 1_073_741_824, // 1 GB in bytes
    unit: "bytes (1 GB)",
    source: "https://developers.cloudflare.com/kv/platform/limits/",
    reset: "persistent",
    notes: "Total stored keys and values"
  },
  queuesOperations: {
    limit: 10_000,
    unit: "operations/day",
    source: "https://developers.cloudflare.com/queues/platform/limits/",
    reset: "00:00 UTC",
    notes: "Standard message = 3 ops (1 send + 1 consumer receive + 1 ack). Retries add reads"
  },
  d1RowsRead: {
    limit: 5_000_000,
    unit: "rows read/day",
    source: "https://developers.cloudflare.com/d1/platform/limits/",
    reset: "00:00 UTC",
    notes: "Rows scanned by query engine, not rows returned"
  },
  d1RowsWritten: {
    limit: 100_000,
    unit: "rows written/day",
    source: "https://developers.cloudflare.com/d1/platform/limits/",
    reset: "00:00 UTC",
    notes: "Includes inserts, updates, deletes"
  },
  d1Storage: {
    limit: 524_288_000, // 500 MB in bytes
    unit: "bytes (500 MB)",
    source: "https://developers.cloudflare.com/d1/platform/limits/",
    reset: "persistent",
    notes: "Per-database limit (5 GB total account limit across databases)"
  },
  pagespeedApi: {
    limit: 25_000,
    unit: "queries/day",
    source: "Google Cloud Console - PageSpeed Insights API Quotas",
    reset: "00:00 Pacific Time",
    notes: "Rate limit: 240 queries/minute"
  },
  r2OperationsClassA: {
    limit: 1_000_000, // per month = ~33,333/day
    unit: "ops/month (Class A writes)",
    source: "https://developers.cloudflare.com/r2/pricing/",
    reset: "monthly",
    notes: "R2 free tier includes 1M Class A operations/month and 10 GB storage"
  }
};

// -----------------------------------------------------------------------------
// Measured Production Coefficients (From Step 1 Analytics & D1 Inspections)
// -----------------------------------------------------------------------------
export const PRODUCTION_COEFFICIENTS = {
  // Scans
  subrequestsPerScan: 2,           // 1 PSI + 1 CrUX
  kvWritesPerScan: 1,              // 1 detailed report JSON
  kvDeletesPerScan: 1,             // 1 pruned report (steady state)
  queueOpsPerScan: 3.06,           // 3 base ops + 2% retry probability * 3 ops
  d1QueriesPerScan: 10,            // Claim, test_run, metric, site_latest, report, states
  d1RowsWrittenPerScan: 9,         // INSERT test_runs, metrics, site_latest, scan_jobs, report
  d1RowsReadPerScan: 8,            // Site check, target check, lease verification
  workerLogEventsPerScan: 4,       // start, psi, complete, queue ack

  // Detailed Reports (KV Storage)
  detailedReportAvgBytes: 106_739, // ~104.2 KB observed average
  detailedReportMinBytes: 95_266,
  detailedReportMaxBytes: 115_255,

  // D1 Storage
  d1BytesPerScanRecord: 620,       // test_runs + metrics + scan_jobs + index overhead

  // Dashboard Loads
  dashboardLoadsPerDay: 50,        // Estimated daily internal admin visits
  d1RowsScannedPerDashboard: 1_056 // Measured across covering index lookups
};

// -----------------------------------------------------------------------------
// Frequency Parser
// -----------------------------------------------------------------------------
function parseFrequency(val, defaultFreq = "daily") {
  const norm = String(val || defaultFreq).toLowerCase();
  switch (norm) {
    case "hourly": return 24;
    case "daily": return 1;
    case "weekly": return 1 / 7;
    case "monthly": return 1 / 30;
    default:
      if (!Number.isNaN(Number(norm)) && Number(norm) > 0) {
        return Number(norm);
      }
      return 1;
  }
}

// -----------------------------------------------------------------------------
// Model Computation Engine
// -----------------------------------------------------------------------------
export function calculateCapacity(options = {}) {
  const sites = Number(options.sites) || 165;
  const mobileFreq = parseFrequency(options.mobileFreq, "daily");
  const desktopFreq = parseFrequency(options.desktopFreq, "weekly");
  const cronInterval = Number(options.cronInterval) || 5;
  const legacyBatchSize = Number(options.batchSize) || 1;
  const nextBatchSize = Number(options.nextBatchSize) || 25;
  const retentionDays = Number(options.retentionDays) || 90;
  const kvReportRetention = Number(options.kvReportRetention) || 2;
  const dashboardLoads = Number(options.dashboardLoads) || PRODUCTION_COEFFICIENTS.dashboardLoadsPerDay;

  // Workload calculations
  const scansPerSitePerDay = mobileFreq + desktopFreq;
  const totalScansPerDay = sites * scansPerSitePerDay;

  const cronTicksPerDay = Math.floor(1440 / cronInterval); // 288 at 5-min interval
  const legacyMaxSchedulerCapacity = cronTicksPerDay * legacyBatchSize;
  const nextMaxSchedulerCapacity = cronTicksPerDay * nextBatchSize;

  // Daily Resource Consumptions
  const kvWritesDaily = totalScansPerDay * PRODUCTION_COEFFICIENTS.kvWritesPerScan;
  const kvDeletesDaily = totalScansPerDay * PRODUCTION_COEFFICIENTS.kvDeletesPerScan;
  const kvReadsDaily = dashboardLoads * 2 + 10; // preview and admin loads
  const queueOpsDaily = totalScansPerDay * PRODUCTION_COEFFICIENTS.queueOpsPerScan;
  const d1RowsWrittenDaily = totalScansPerDay * PRODUCTION_COEFFICIENTS.d1RowsWrittenPerScan;
  const d1RowsReadDaily = (totalScansPerDay * PRODUCTION_COEFFICIENTS.d1RowsReadPerScan) +
                          (dashboardLoads * PRODUCTION_COEFFICIENTS.d1RowsScannedPerDashboard);
  const workersRequestsDaily = cronTicksPerDay + totalScansPerDay + dashboardLoads;
  const pagespeedQueriesDaily = totalScansPerDay;

  // Storage Models
  // KV Detailed Reports: sites * 2 strategies * retention * avgBytes
  const activeReportCount = sites * 2 * kvReportRetention;
  const kvStorageBytes = activeReportCount * PRODUCTION_COEFFICIENTS.detailedReportAvgBytes;

  // D1 Cumulative Storage Growth
  const d1DailyGrowthBytes = totalScansPerDay * PRODUCTION_COEFFICIENTS.d1BytesPerScanRecord;
  const d1StorageAt30Days = d1DailyGrowthBytes * Math.min(30, retentionDays);
  const d1StorageAt90Days = d1DailyGrowthBytes * Math.min(90, retentionDays);
  const d1StorageAt365Days = d1DailyGrowthBytes * retentionDays; // bounded by pruning retention window
  const d1StorageUnpruned365Days = d1DailyGrowthBytes * 365;

  // Individual Resource Limits and Maximum Sites
  const resourceAnalysis = [
    {
      name: "Legacy Scheduler Dispatch (batch=1)",
      category: "Scheduler",
      unit: "scans/day",
      limit: legacyMaxSchedulerCapacity,
      currentUsage: Math.min(totalScansPerDay, legacyMaxSchedulerCapacity),
      currentPct: (totalScansPerDay / legacyMaxSchedulerCapacity) * 100,
      costPerSite: scansPerSitePerDay,
      maxSites100: Math.floor(legacyMaxSchedulerCapacity / scansPerSitePerDay),
      safeSites70: Math.floor((legacyMaxSchedulerCapacity * 0.70) / scansPerSitePerDay),
      notes: `cron */${cronInterval} = ${cronTicksPerDay} ticks/day x batch ${legacyBatchSize}`
    },
    {
      name: "Next Scheduler Dispatch (batch=25, budget=600)",
      category: "Scheduler",
      unit: "scans/day",
      limit: 600, // Budget ceiling defined in wrangler.jsonc
      currentUsage: Math.min(totalScansPerDay, 600),
      currentPct: (totalScansPerDay / 600) * 100,
      costPerSite: scansPerSitePerDay,
      maxSites100: Math.floor(600 / scansPerSitePerDay),
      safeSites70: Math.floor((600 * 0.70) / scansPerSitePerDay),
      notes: "Capped by NEXT_SCHEDULER_DAILY_BUDGET=600 to protect Queue free tier"
    },
    {
      name: "KV Writes",
      category: "Cloudflare KV",
      unit: "writes/day",
      limit: FREE_LIMITS.kvWrites.limit,
      currentUsage: kvWritesDaily,
      currentPct: (kvWritesDaily / FREE_LIMITS.kvWrites.limit) * 100,
      costPerSite: scansPerSitePerDay * PRODUCTION_COEFFICIENTS.kvWritesPerScan,
      maxSites100: Math.floor(FREE_LIMITS.kvWrites.limit / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.kvWritesPerScan)),
      safeSites70: Math.floor((FREE_LIMITS.kvWrites.limit * 0.70) / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.kvWritesPerScan)),
      notes: "1 detailed report JSON written per successful test"
    },
    {
      name: "KV Deletes",
      category: "Cloudflare KV",
      unit: "deletes/day",
      limit: FREE_LIMITS.kvDeletes.limit,
      currentUsage: kvDeletesDaily,
      currentPct: (kvDeletesDaily / FREE_LIMITS.kvDeletes.limit) * 100,
      costPerSite: scansPerSitePerDay * PRODUCTION_COEFFICIENTS.kvDeletesPerScan,
      maxSites100: Math.floor(FREE_LIMITS.kvDeletes.limit / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.kvDeletesPerScan)),
      safeSites70: Math.floor((FREE_LIMITS.kvDeletes.limit * 0.70) / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.kvDeletesPerScan)),
      notes: "Steady state pruning of older report payloads"
    },
    {
      name: "KV Storage (1 GB)",
      category: "Cloudflare KV",
      unit: "bytes",
      limit: FREE_LIMITS.kvStorage.limit,
      currentUsage: kvStorageBytes,
      currentPct: (kvStorageBytes / FREE_LIMITS.kvStorage.limit) * 100,
      costPerSite: 2 * kvReportRetention * PRODUCTION_COEFFICIENTS.detailedReportAvgBytes,
      maxSites100: Math.floor(FREE_LIMITS.kvStorage.limit / (2 * kvReportRetention * PRODUCTION_COEFFICIENTS.detailedReportAvgBytes)),
      safeSites70: Math.floor((FREE_LIMITS.kvStorage.limit * 0.70) / (2 * kvReportRetention * PRODUCTION_COEFFICIENTS.detailedReportAvgBytes)),
      notes: `${kvReportRetention} reports retained per strategy (~${(2 * kvReportRetention * PRODUCTION_COEFFICIENTS.detailedReportAvgBytes / 1024).toFixed(0)} KB/site)`
    },
    {
      name: "Queues Operations",
      category: "Cloudflare Queues",
      unit: "ops/day",
      limit: FREE_LIMITS.queuesOperations.limit,
      currentUsage: queueOpsDaily,
      currentPct: (queueOpsDaily / FREE_LIMITS.queuesOperations.limit) * 100,
      costPerSite: scansPerSitePerDay * PRODUCTION_COEFFICIENTS.queueOpsPerScan,
      maxSites100: Math.floor(FREE_LIMITS.queuesOperations.limit / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.queueOpsPerScan)),
      safeSites70: Math.floor((FREE_LIMITS.queuesOperations.limit * 0.70) / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.queueOpsPerScan)),
      notes: "3 ops per delivered message (1 send + 1 receive + 1 ack) + retries"
    },
    {
      name: "D1 Rows Written",
      category: "Cloudflare D1",
      unit: "rows/day",
      limit: FREE_LIMITS.d1RowsWritten.limit,
      currentUsage: d1RowsWrittenDaily,
      currentPct: (d1RowsWrittenDaily / FREE_LIMITS.d1RowsWritten.limit) * 100,
      costPerSite: scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1RowsWrittenPerScan,
      maxSites100: Math.floor(FREE_LIMITS.d1RowsWritten.limit / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1RowsWrittenPerScan)),
      safeSites70: Math.floor((FREE_LIMITS.d1RowsWritten.limit * 0.70) / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1RowsWrittenPerScan)),
      notes: "~9 D1 write queries per scan across test_runs, metrics, states"
    },
    {
      name: "D1 Rows Read (Scanned)",
      category: "Cloudflare D1",
      unit: "rows read/day",
      limit: FREE_LIMITS.d1RowsRead.limit,
      currentUsage: d1RowsReadDaily,
      currentPct: (d1RowsReadDaily / FREE_LIMITS.d1RowsRead.limit) * 100,
      costPerSite: scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1RowsReadPerScan,
      maxSites100: Math.floor(FREE_LIMITS.d1RowsRead.limit / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1RowsReadPerScan)),
      safeSites70: Math.floor((FREE_LIMITS.d1RowsRead.limit * 0.70) / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1RowsReadPerScan)),
      notes: "Includes ~1,056 rows scanned per admin dashboard load"
    },
    {
      name: "D1 Storage (500 MB DB Cap)",
      category: "Cloudflare D1",
      unit: "bytes",
      limit: FREE_LIMITS.d1Storage.limit,
      currentUsage: d1StorageAt90Days,
      currentPct: (d1StorageAt90Days / FREE_LIMITS.d1Storage.limit) * 100,
      costPerSite: scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1BytesPerScanRecord * retentionDays,
      maxSites100: Math.floor(FREE_LIMITS.d1Storage.limit / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1BytesPerScanRecord * retentionDays)),
      safeSites70: Math.floor((FREE_LIMITS.d1Storage.limit * 0.70) / (scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1BytesPerScanRecord * retentionDays)),
      notes: `At ${retentionDays}-day retention (~${(scansPerSitePerDay * PRODUCTION_COEFFICIENTS.d1BytesPerScanRecord * retentionDays / 1024).toFixed(0)} KB/site)`
    },
    {
      name: "PageSpeed Insights API",
      category: "Google Cloud",
      unit: "queries/day",
      limit: FREE_LIMITS.pagespeedApi.limit,
      currentUsage: pagespeedQueriesDaily,
      currentPct: (pagespeedQueriesDaily / FREE_LIMITS.pagespeedApi.limit) * 100,
      costPerSite: scansPerSitePerDay,
      maxSites100: Math.floor(FREE_LIMITS.pagespeedApi.limit / scansPerSitePerDay),
      safeSites70: Math.floor((FREE_LIMITS.pagespeedApi.limit * 0.70) / scansPerSitePerDay),
      notes: "Google project quota (resets 00:00 Pacific, 240/min rate limit)"
    },
    {
      name: "Workers Total Requests",
      category: "Cloudflare Workers",
      unit: "requests/day",
      limit: FREE_LIMITS.workersRequests.limit,
      currentUsage: workersRequestsDaily,
      currentPct: (workersRequestsDaily / FREE_LIMITS.workersRequests.limit) * 100,
      costPerSite: scansPerSitePerDay, // 1 queue consumer dispatch per scan
      maxSites100: Math.floor((FREE_LIMITS.workersRequests.limit - cronTicksPerDay - dashboardLoads) / scansPerSitePerDay),
      safeSites70: Math.floor(((FREE_LIMITS.workersRequests.limit * 0.70) - cronTicksPerDay - dashboardLoads) / scansPerSitePerDay),
      notes: "Sum of cron ticks (288) + Queue consumers (batch=1) + HTTP"
    }
  ];

  // Identify Bottlenecks
  const sortedBy100 = [...resourceAnalysis].sort((a, b) => a.maxSites100 - b.maxSites100);
  const primaryBottleneck = sortedBy100[0];
  const secondaryBottleneck = sortedBy100[1];

  return {
    inputs: {
      sites,
      mobileFreq,
      desktopFreq,
      cronInterval,
      legacyBatchSize,
      nextBatchSize,
      retentionDays,
      kvReportRetention,
      dashboardLoads,
      scansPerSitePerDay,
      totalScansPerDay
    },
    storageGrowth: {
      kvStorageMb: (kvStorageBytes / (1024 * 1024)).toFixed(2),
      d1DailyGrowthKb: (d1DailyGrowthBytes / 1024).toFixed(2),
      d1StorageAt30DaysMb: (d1StorageAt30Days / (1024 * 1024)).toFixed(2),
      d1StorageAt90DaysMb: (d1StorageAt90Days / (1024 * 1024)).toFixed(2),
      d1StorageAt365DaysPrunedMb: (d1StorageAt365Days / (1024 * 1024)).toFixed(2),
      d1StorageAt365DaysUnprunedMb: (d1StorageUnpruned365Days / (1024 * 1024)).toFixed(2),
      daysUntilD1500MbAtCurrentPace: Math.floor(FREE_LIMITS.d1Storage.limit / d1DailyGrowthBytes)
    },
    primaryBottleneck,
    secondaryBottleneck,
    resourceAnalysis
  };
}

// -----------------------------------------------------------------------------
// CLI Formatting & Execution
// -----------------------------------------------------------------------------
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + " KB";
  return bytes + " B";
}

function parseCliArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      args[k] = v === undefined ? true : v;
    }
  }
  return args;
}

function printCliReport() {
  const cliArgs = parseCliArgs();
  const format = cliArgs.format || "table";

  const model = calculateCapacity({
    sites: cliArgs.sites,
    mobileFreq: cliArgs["mobile-freq"],
    desktopFreq: cliArgs["desktop-freq"],
    cronInterval: cliArgs["cron-interval"],
    batchSize: cliArgs["batch-size"],
    nextBatchSize: cliArgs["next-batch-size"],
    retentionDays: cliArgs["retention-days"],
    kvReportRetention: cliArgs["kv-report-retention"],
    dashboardLoads: cliArgs["dashboard-loads"]
  });

  if (format === "json") {
    console.log(JSON.stringify(model, null, 2));
    return;
  }

  const { inputs, storageGrowth, primaryBottleneck, secondaryBottleneck, resourceAnalysis } = model;

  console.log("\n==========================================================================================================");
  console.log("                        SPEEDPULSE FREE-TIER CAPACITY & BOTTLENECK MODEL");
  console.log("==========================================================================================================");
  console.log(` Active Sites:             ${inputs.sites}`);
  console.log(` Scan Schedule:            Mobile daily (1.0/day) + Desktop weekly (~0.143/day) = ${inputs.scansPerSitePerDay.toFixed(3)} scans/site/day`);
  console.log(` Daily Scan Workload:      ${inputs.totalScansPerDay.toFixed(1)} scans/day`);
  console.log(` D1 Retention Window:      ${inputs.retentionDays} days`);
  console.log(` KV Report Retention:      ${inputs.kvReportRetention} reports per strategy`);
  console.log("----------------------------------------------------------------------------------------------------------");
  console.log(` PRIMARY BOTTLENECK:       ${primaryBottleneck.name}`);
  console.log(`   - 100% Theoretical Limit: ${primaryBottleneck.maxSites100} sites`);
  console.log(`   - 70% Safe Operating Cap: ${primaryBottleneck.safeSites70} sites`);
  console.log(` SECONDARY BOTTLENECK:     ${secondaryBottleneck.name}`);
  console.log(`   - 100% Theoretical Limit: ${secondaryBottleneck.maxSites100} sites`);
  console.log(`   - 70% Safe Operating Cap: ${secondaryBottleneck.safeSites70} sites`);
  console.log("----------------------------------------------------------------------------------------------------------\n");

  console.log("RESOURCE CONSUMPTION & CAPACITY CEILINGS:");
  console.log("--------------------------------------------------------------------------------------------------------------------------------");
  console.log(
    "Resource".padEnd(38) +
    "Daily Free Limit".padEnd(20) +
    "Today Usage".padEnd(16) +
    "Today %".padEnd(12) +
    "Max Sites (100%)".padEnd(18) +
    "Safe Sites (70%)"
  );
  console.log("--------------------------------------------------------------------------------------------------------------------------------");

  for (const r of resourceAnalysis) {
    const limitStr = typeof r.limit === "number" && r.limit > 10_000_000
      ? formatBytes(r.limit)
      : r.limit.toLocaleString() + " " + (r.unit.split("/")[1] || "");
    const usageStr = typeof r.currentUsage === "number" && r.limit > 10_000_000
      ? formatBytes(r.currentUsage)
      : Math.round(r.currentUsage).toLocaleString();
    const pctStr = r.currentPct.toFixed(1) + "%";
    const max100Str = r.maxSites100.toLocaleString();
    const safe70Str = r.safeSites70.toLocaleString();

    console.log(
      r.name.padEnd(38) +
      limitStr.padEnd(20) +
      usageStr.padEnd(16) +
      pctStr.padEnd(12) +
      max100Str.padEnd(18) +
      safe70Str
    );
  }
  console.log("--------------------------------------------------------------------------------------------------------------------------------\n");

  console.log("STORAGE GROWTH PROJECTIONS:");
  console.log(`  - Cloudflare KV Storage:     ${storageGrowth.kvStorageMb} MB (steady state capped by ${inputs.kvReportRetention} reports/strategy retention)`);
  console.log(`  - D1 Daily Ingestion Rate:   ${storageGrowth.d1DailyGrowthKb} KB/day`);
  console.log(`  - D1 Size at 30 Days:        ${storageGrowth.d1StorageAt30DaysMb} MB`);
  console.log(`  - D1 Size at 90 Days:        ${storageGrowth.d1StorageAt90DaysMb} MB`);
  console.log(`  - D1 Size at 365 Days:       ${storageGrowth.d1StorageAt365DaysPrunedMb} MB (with ${inputs.retentionDays}-day raw data pruning)`);
  console.log(`  - D1 Unpruned 1-Year Size:   ${storageGrowth.d1StorageAt365DaysUnprunedMb} MB`);
  console.log(`  - Time to reach 500 MB D1:   ${storageGrowth.daysUntilD1500MbAtCurrentPace} days (~${(storageGrowth.daysUntilD1500MbAtCurrentPace / 365).toFixed(1)} years at ${inputs.sites} sites)`);
  console.log("==========================================================================================================\n");
}

if (process.argv[1]?.endsWith("capacity-model.mjs")) {
  printCliReport();
}
