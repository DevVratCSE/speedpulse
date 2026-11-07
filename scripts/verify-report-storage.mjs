#!/usr/bin/env node

/**
 * Automated Verification: Item 5 Report Storage
 *
 * Verifies:
 * 1. D1 storage lifecycle: store, retrieve via HTTP response, delete via cleanup.
 * 2. Automatic quota recording in quota_ledger (d1_writes).
 * 3. Backward-compatibility & Lazy migration: reading a KV-only report in D1 mode
 *    returns the report and lazily copies it into report_payloads.
 * 4. Batch migration: migrateKvReportsToD1() moves existing KV reports into D1.
 * 5. KV storage backend: still functional when explicitly configured with REPORT_STORAGE = 'kv'.
 * 6. Sizing and limits: 400 KiB application guard protects SQLite 2 MB row limit;
 *    oversize payload rejection verified.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import esbuild from "esbuild";

import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");

// Compile TypeScript sources into memory
const bundle = esbuild.buildSync({
  stdin: {
    contents: `
      export * from "./src/detailed-reports";
      export * from "./src/quota";
      export * from "./src/utils";
    `,
    resolveDir: projectRoot,
    sourcefile: "virtual-entry.ts",
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false
});

const tempModulePath = path.resolve(projectRoot, ".verify-storage-bundle.mjs");
fs.writeFileSync(tempModulePath, bundle.outputFiles[0].text);

let mod;
try {
  mod = await import(tempModulePath);
} finally {
  try {
    fs.unlinkSync(tempModulePath);
  } catch {}
}

const {
  MAX_DETAILED_REPORT_BYTES,
  getReportStorageBackend,
  getDetailedReportWriteBudget,
  getDetailedReportDeleteBudget,
  putReportPayload,
  getReportPayload,
  deleteReportPayload,
  storeDetailedReport,
  getDetailedReportJsonResponse,
  processDetailedReportCleanup,
  migrateKvReportsToD1,
  queueDetailedReportCleanup,
  getQuotaUsage
} = mod;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function createTestD1() {
  const rawDb = new DatabaseSync(":memory:");
  rawDb.exec("PRAGMA foreign_keys = OFF;");

  const migrationFiles = [
    "0001_init.sql",
    "0002_run_safety.sql",
    "0003_next_control_plane.sql",
    "0004_custom_schedules.sql",
    "0005_control_plane_convergence.sql",
    "0006_detailed_reports.sql",
    "0007_quota_ledger.sql",
    "0008_d1_report_storage.sql",
    "0009_metrics_daily_rollup.sql"
  ];

  for (const f of migrationFiles) {
    const sql = fs.readFileSync(path.join(projectRoot, "migrations", f), "utf8");
    rawDb.exec(sql);
  }

  rawDb.exec("INSERT OR IGNORE INTO projects (id, name, description) VALUES (1, 'Test', 'Test');");
  rawDb.exec(`INSERT INTO sites (id, project_id, name, url, origin, active, mobile_frequency, desktop_frequency, created_at, updated_at)
              VALUES (1, 1, 'Site 1', 'https://site1.com', 'site1.com', 1, 'daily', 'weekly', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');`);

  const d1 = {
    raw: rawDb,
    prepare(sql) {
      const stmt = rawDb.prepare(sql);
      return {
        _params: [],
        bind(...params) {
          this._params = params;
          return this;
        },
        first(col) {
          const row = stmt.get(...this._params);
          if (!row) return null;
          if (col && typeof col === "string") return row[col] !== undefined ? row[col] : null;
          return row;
        },
        all() {
          const rows = stmt.all(...this._params);
          return Promise.resolve({ results: rows, meta: { changes: 0 } });
        },
        run() {
          if (sql.trim().toUpperCase().startsWith("SELECT")) {
            const rows = stmt.all(...this._params);
            return Promise.resolve({ results: rows, meta: { changes: 0, last_row_id: 0 } });
          }
          const res = stmt.run(...this._params);
          return Promise.resolve({
            results: [],
            meta: { changes: Number(res.changes || 0), last_row_id: Number(res.lastInsertRowid || 0) }
          });
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const s of statements) {
        results.push(await s.run());
      }
      return results;
    }
  };

  return d1;
}

function createKvMock() {
  const store = new Map();
  const meta = new Map();
  return {
    _store: store,
    _meta: meta,
    async get(key, type = "text") {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options = {}) {
      store.set(key, String(value));
      if (options.metadata) meta.set(key, options.metadata);
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
    }
  };
}

console.log("==================================================================");
console.log("  RUNNING ITEM 5: REPORT STORAGE & MIGRATION TESTS");
console.log("==================================================================");

// [Test 1] Sizing and Budget Limits
console.log("\n[Test 1] Sizing guards and daily budget calculation");
assert.strictEqual(MAX_DETAILED_REPORT_BYTES, 400 * 1024, "MAX_DETAILED_REPORT_BYTES must be 400 KiB");
pass("MAX_DETAILED_REPORT_BYTES is 400 KiB (safe for SQLite 2 MB limit)");

const dummyEnvD1 = { DB: {}, REPORT_STORAGE: "d1" };
const d1WriteBudget = getDetailedReportWriteBudget(dummyEnvD1);
assert(d1WriteBudget >= 50000, `D1 write budget must be >= 50,000 (was ${d1WriteBudget})`);
pass(`D1 write budget dynamically scales to ${d1WriteBudget} writes/day`);

const dummyEnvKv = { DB: {}, REPORT_STORAGE: "kv" };
const kvWriteBudget = getDetailedReportWriteBudget(dummyEnvKv);
assert.strictEqual(kvWriteBudget, 800, "KV write budget must be 800 writes/day");
pass(`KV write budget remains constrained to safety budget of ${kvWriteBudget} writes/day`);

// [Test 2] D1 Storage Lifecycle (Store, Retrieve, Delete, Quota)
console.log("\n[Test 2] D1 Storage Lifecycle: Store, Retrieve, Delete");
{
  const db = createTestD1();
  const kv = createKvMock();
  const env = {
    DB: db,
    REPORTS: kv,
    DETAILED_REPORTS_ENABLED: "1",
    REPORT_STORAGE: "d1"
  };

  // Seed a test run
  db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
              VALUES (101, 1, 'mobile', 'scheduled', 'success', '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z');`);

  const samplePayload = JSON.stringify({
    lighthouseVersion: "12.0.0",
    finalUrl: "https://site1.com/",
    categories: { performance: { score: 0.95 } }
  });

  const storeRes = await storeDetailedReport(env, {
    siteId: 1,
    strategy: "mobile",
    testRunId: 101,
    capturedAt: "2026-11-04T10:00:00.000Z",
    finalUrl: "https://site1.com/",
    lighthouseVersion: "12.0.0",
    payloadJson: samplePayload,
    sizeBytes: Buffer.byteLength(samplePayload),
    detailLevel: "compact"
  });

  assert.strictEqual(storeRes.status, "stored", "Report should be stored successfully");
  pass("Report successfully stored with REPORT_STORAGE = 'd1'");

  // Verify stored in report_payloads table
  const payloadRow = db.raw.prepare("SELECT * FROM report_payloads WHERE storage_key = ?").get("reports/1/mobile/101.json");
  assert(payloadRow, "Payload must exist in report_payloads table");
  assert.strictEqual(payloadRow.payload_json, samplePayload, "Payload content must match");
  assert.strictEqual(payloadRow.size_bytes, Buffer.byteLength(samplePayload), "Payload size must match");
  pass("Row correctly inserted into report_payloads table");

  // Verify KV was NOT touched for payload storage
  assert.strictEqual(kv._store.size, 0, "KV store must not be populated in D1 mode");
  pass("Workers KV not consumed when using D1 storage backend");

  // Verify D1 write quota tracked in quota_ledger
  const d1Writes = await getQuotaUsage(db, "d1_writes");
  assert(d1Writes > 0, `d1_writes should be recorded in quota_ledger (count: ${d1Writes})`);
  pass(`Quota ledger tracks ${d1Writes} D1 write operation(s)`);

  // Retrieve report via HTTP Response endpoint
  const reportId = storeRes.report.id;
  const httpRes = await getDetailedReportJsonResponse(env, reportId);
  assert.strictEqual(httpRes.status, 200, "HTTP status must be 200 OK");
  const retrievedBody = await httpRes.text();
  assert.strictEqual(retrievedBody, samplePayload, "Retrieved body must match stored payload");
  pass("getDetailedReportJsonResponse successfully serves payload directly from D1");

  // Queue cleanup and process deletion
  db.raw.exec(`INSERT INTO report_cleanup_tasks (report_id, storage_key, reason, attempts, created_at, updated_at)
              VALUES (${reportId}, 'reports/1/mobile/101.json', 'retention_rotation', 0, '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z');`);
  db.raw.exec(`UPDATE detailed_reports SET state = 'cleanup_pending' WHERE id = ${reportId};`);
  const cleanupRes = await processDetailedReportCleanup(env, 1);
  assert.strictEqual(cleanupRes.deleted, 1, "Cleanup must delete 1 report");

  // Verify deletion from report_payloads and detailed_reports
  const deletedPayload = db.raw.prepare("SELECT * FROM report_payloads WHERE storage_key = ?").get("reports/1/mobile/101.json");
  assert.strictEqual(deletedPayload, undefined, "Payload must be deleted from report_payloads");
  const deletedMetadata = db.raw.prepare("SELECT * FROM detailed_reports WHERE id = ?").get(reportId);
  assert.strictEqual(deletedMetadata, undefined, "Metadata row must be deleted from detailed_reports");
  pass("processDetailedReportCleanup cleanly deletes from report_payloads and detailed_reports");
}

// [Test 3] Oversize Payload Rejection
console.log("\n[Test 3] Rejection of oversize payloads");
{
  const db = createTestD1();
  const env = {
    DB: db,
    REPORTS: createKvMock(),
    DETAILED_REPORTS_ENABLED: "1",
    REPORT_STORAGE: "d1"
  };

  const largePayload = "x".repeat(MAX_DETAILED_REPORT_BYTES + 1);
  const storeRes = await storeDetailedReport(env, {
    siteId: 1,
    strategy: "desktop",
    testRunId: 102,
    capturedAt: "2026-11-04T10:00:00.000Z",
    finalUrl: "https://site1.com/",
    lighthouseVersion: "12.0.0",
    payloadJson: largePayload,
    sizeBytes: largePayload.length,
    detailLevel: "compact"
  });

  assert.strictEqual(storeRes.status, "oversize", "Payload over 400 KiB must be rejected as oversize");
  const count = db.raw.prepare("SELECT COUNT(*) as cnt FROM report_payloads").get().cnt;
  assert.strictEqual(count, 0, "No payload should be written to DB when oversize");
  pass("Oversize payload > 400 KiB safely rejected without writing to database");
}

// [Test 4] Backward-Compatibility & Lazy Migration on Read
console.log("\n[Test 4] Backward-compatibility & Lazy Migration on Read");
{
  const db = createTestD1();
  const kv = createKvMock();
  const env = {
    DB: db,
    REPORTS: kv,
    DETAILED_REPORTS_ENABLED: "1",
    REPORT_STORAGE: "d1"
  };

  // Seed test run and legacy KV report
  const storageKey = "reports/1/desktop/201.json";
  const legacyPayload = JSON.stringify({ legacy: true, score: 0.88 });

  db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
              VALUES (201, 1, 'desktop', 'scheduled', 'success', '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z');`);

  db.raw.exec(`INSERT INTO detailed_reports (id, site_id, strategy, test_run_id, storage_key, captured_at, size_bytes, detail_level, state, created_at, updated_at)
              VALUES (501, 1, 'desktop', 201, '${storageKey}', '2026-11-03T10:00:00.000Z', ${legacyPayload.length}, 'compact', 'ready', '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z');`);

  // Stored ONLY in KV
  await kv.put(storageKey, legacyPayload);

  // Verify NOT in report_payloads initially
  const beforeRead = db.raw.prepare("SELECT * FROM report_payloads WHERE storage_key = ?").get(storageKey);
  assert.strictEqual(beforeRead, undefined, "Must not exist in D1 report_payloads prior to read");

  // Read report
  const res = await getDetailedReportJsonResponse(env, 501);
  assert.strictEqual(res.status, 200, "Should read successfully");
  const body = await res.text();
  assert.strictEqual(body, legacyPayload, "Payload content from KV must match");
  pass("Historical KV-only report cleanly resolved when REPORT_STORAGE = 'd1'");

  // Verify lazily migrated to D1 report_payloads
  const afterRead = db.raw.prepare("SELECT * FROM report_payloads WHERE storage_key = ?").get(storageKey);
  assert(afterRead, "Historical report must be lazily persisted into report_payloads table");
  assert.strictEqual(afterRead.payload_json, legacyPayload, "Migrated payload must match KV payload");
  pass("Historical KV report is automatically copied to D1 on first read");
}

// [Test 5] Batch Migration: migrateKvReportsToD1
console.log("\n[Test 5] Batch Migration from KV to D1");
{
  const db = createTestD1();
  const kv = createKvMock();
  const env = {
    DB: db,
    REPORTS: kv,
    DETAILED_REPORTS_ENABLED: "1",
    REPORT_STORAGE: "d1"
  };

  // Seed 5 historical reports in KV
  for (let i = 1; i <= 5; i++) {
    const runId = 300 + i;
    const storageKey = `reports/1/mobile/${runId}.json`;
    const payload = JSON.stringify({ index: i, note: `Historical report ${i}` });

    db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
                VALUES (${runId}, 1, 'mobile', 'scheduled', 'success', '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z');`);

    db.raw.exec(`INSERT INTO detailed_reports (id, site_id, strategy, test_run_id, storage_key, captured_at, size_bytes, detail_level, state, created_at, updated_at)
                VALUES (${600 + i}, 1, 'mobile', ${runId}, '${storageKey}', '2026-11-02T10:00:00.000Z', ${payload.length}, 'compact', 'ready', '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z');`);

    await kv.put(storageKey, payload);
  }

  // Run batch migration
  const migrationResult = await migrateKvReportsToD1(env, 10);
  assert.strictEqual(migrationResult.inspected, 5, "Should inspect 5 candidate reports");
  assert.strictEqual(migrationResult.migrated, 5, "Should migrate all 5 reports");
  assert.strictEqual(migrationResult.missingInKv, 0, "No reports should be missing in KV");
  assert.strictEqual(migrationResult.remaining, 0, "Zero unmigrated ready reports remaining");
  pass("migrateKvReportsToD1 successfully moved 5/5 reports from KV to D1");

  // Verify all rows in report_payloads table
  const d1Count = db.raw.prepare("SELECT COUNT(*) as cnt FROM report_payloads").get().cnt;
  assert.strictEqual(d1Count, 5, "5 rows must exist in report_payloads");
  pass("All 5 migrated payloads verified in report_payloads table");
}

// [Test 6] KV Storage Backend Mode (REPORT_STORAGE = 'kv')
console.log("\n[Test 6] KV Storage Backend Fallback (REPORT_STORAGE = 'kv')");
{
  const db = createTestD1();
  const kv = createKvMock();
  const env = {
    DB: db,
    REPORTS: kv,
    DETAILED_REPORTS_ENABLED: "1",
    REPORT_STORAGE: "kv"
  };

  db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
              VALUES (401, 1, 'desktop', 'scheduled', 'success', '2026-11-04T11:00:00.000Z', '2026-11-04T11:00:00.000Z');`);

  const kvPayload = JSON.stringify({ mode: "kv-explicit" });
  const storeRes = await storeDetailedReport(env, {
    siteId: 1,
    strategy: "desktop",
    testRunId: 401,
    capturedAt: "2026-11-04T11:00:00.000Z",
    finalUrl: "https://site1.com/",
    lighthouseVersion: "12.0.0",
    payloadJson: kvPayload,
    sizeBytes: kvPayload.length,
    detailLevel: "compact"
  });

  assert.strictEqual(storeRes.status, "stored");
  assert.strictEqual(kv._store.get("reports/1/desktop/401.json"), kvPayload);
  const d1Payload = db.raw.prepare("SELECT * FROM report_payloads WHERE storage_key = ?").get("reports/1/desktop/401.json");
  assert.strictEqual(d1Payload, undefined, "Payload must NOT be written to D1 table when in KV mode");
  pass("Explicit REPORT_STORAGE = 'kv' stores exclusively to KV");

  // Verify kv_writes tracked in quota_ledger
  const kvWrites = await getQuotaUsage(db, "kv_writes");
  assert.strictEqual(kvWrites, 1, "kv_writes must be recorded in quota_ledger when in KV mode");
  pass("Quota ledger recorded kv_writes operation");
}

console.log("\n==================================================================");
console.log("  ALL ITEM 5 REPORT STORAGE & MIGRATION TESTS PASSED! (6/6)");
console.log("==================================================================");
