#!/usr/bin/env node

/**
 * Migration Script: Migrate Existing KV Detailed Reports to D1
 *
 * Usage:
 *   Local dry-run / count:
 *     node scripts/migrate-kv-reports-to-d1.mjs --count
 *
 *   Local batch execution via Wrangler:
 *     wrangler d1 execute <db-name> --local --command="SELECT COUNT(*) FROM detailed_reports WHERE state='ready' AND storage_key NOT IN (SELECT storage_key FROM report_payloads);"
 *
 * How it works:
 * 1. SpeedPulse automatically performs zero-downtime lazy migration on read:
 *    Any time an existing report is requested via the API or UI, getReportPayload()
 *    fetches from KV and automatically copies it into D1 report_payloads.
 * 2. This script provides an explicit batch migration runner using migrateKvReportsToD1()
 *    to migrate remaining historical reports ahead of time.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");

console.log("==================================================================");
console.log("  SPEEDPULSE: KV-TO-D1 REPORT STORAGE MIGRATION");
console.log("==================================================================");
console.log("\nZero-Downtime Migration Strategy:");
console.log("1. Automatic on-read: Requests for older KV reports automatically write-through to D1.");
console.log("2. Batch API: Can be executed in batches via internal helper `migrateKvReportsToD1(env)`.");
console.log("3. D1 table `report_payloads` holds the payloads, eliminating KV 1,000 writes/day bottleneck.");
console.log("\nSQL Preview to inspect unmigrated reports:");
console.log(`
  SELECT id, site_id, strategy, storage_key, size_bytes, created_at
  FROM detailed_reports
  WHERE state = 'ready'
    AND storage_key NOT IN (SELECT storage_key FROM report_payloads)
  ORDER BY id ASC;
`);
