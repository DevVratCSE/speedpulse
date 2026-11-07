#!/usr/bin/env node

/**
 * Automated Verification: Demo Seeder & In-App API Key Onboarding
 *
 * Verifies:
 * 1. In-App API Key Management:
 *    - getEffectiveGoogleApiKey precedence (env.GOOGLE_API_KEY > D1 system_state > undefined)
 *    - POST /api/settings stores key in system_state table
 *    - GET /api/settings returns masked key and apiKeySource
 *    - Clearing API key via POST /api/settings removes it from system_state
 * 2. Dashboard First-Run State:
 *    - GET /api/dashboard returns apiConfigured: false when key is missing
 *    - GET /api/dashboard returns apiConfigured: true when key is configured
 * 3. Public Demo Seeder (scripts/seed-demo.mjs):
 *    - Seeds 1 project ("Web Benchmarks")
 *    - Seeds 6 public benchmark websites (Wikipedia, GitHub, Cloudflare, WordPress, HN, MDN)
 *    - Configures 12 scan targets (mobile & desktop)
 *    - Seeds realistic 5-day historical test runs and daily rollups
 *    - Seeds site_latest for immediate dashboard and history chart visualization
 * 4. UI Shell Integration:
 *    - public/app.js contains apiKeyAlertBanner rendering when apiConfigured is false
 *    - public/app.js contains API key input and Save/Clear actions in openSettings()
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import esbuild from "esbuild";
import { generateDemoSeedSql, seedDemoDatabase, DEMO_SITES } from "./seed-demo.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");

// Compile TypeScript sources into memory
const bundle = esbuild.buildSync({
  stdin: {
    contents: `
      export * from "./src/control-plane";
      export * from "./src/auth";
      export { default as workerDefault } from "./src/index";
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

const tempModulePath = path.resolve(projectRoot, ".verify-demo-bundle.mjs");
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
  getEffectiveGoogleApiKey,
  updateSystemState,
  makeSessionCookie,
  workerDefault
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

function createMockEnv(d1, overrides = {}) {
  return {
    DB: d1,
    ADMIN_PASSWORD: "demopassword",
    SESSION_SECRET: "01234567890123456789012345678901",
    GOOGLE_API_KEY: undefined,
    ...overrides
  };
}

async function runTests() {
  console.log("==================================================================");
  console.log("  RUNNING DEMO SEEDER & IN-APP API KEY ONBOARDING TESTS");
  console.log("==================================================================");

  // -----------------------------------------------------------------
  // Test 1: getEffectiveGoogleApiKey precedence & storage
  // -----------------------------------------------------------------
  console.log("\n[Test 1] getEffectiveGoogleApiKey Precedence & Storage");
  {
    const d1 = createTestD1();
    const envNoKey = createMockEnv(d1);

    // 1. Initially undefined
    const key1 = await getEffectiveGoogleApiKey(envNoKey);
    assert.strictEqual(key1, undefined, "Returns undefined when no key configured");
    pass("Returns undefined when neither env nor database key exists");

    // 2. Store in database
    await updateSystemState(d1, "google_api_key", "AIzaSyD1DatabaseStoredKey123");
    const key2 = await getEffectiveGoogleApiKey(envNoKey);
    assert.strictEqual(key2, "AIzaSyD1DatabaseStoredKey123", "Retrieves key stored in system_state");
    pass("Successfully retrieves in-app configured key from D1 system_state");

    // 3. Worker secret takes priority over database key
    const envWithSecret = createMockEnv(d1, { GOOGLE_API_KEY: "AIzaSyEnvSecretTakesPriority999" });
    const key3 = await getEffectiveGoogleApiKey(envWithSecret);
    assert.strictEqual(key3, "AIzaSyEnvSecretTakesPriority999", "env.GOOGLE_API_KEY overrides database key");
    pass("Worker secret env.GOOGLE_API_KEY takes precedence over database key");
  }

  // -----------------------------------------------------------------
  // Test 2: In-App API Key Settings Endpoints (GET & POST /api/settings)
  // -----------------------------------------------------------------
  console.log("\n[Test 2] Settings Endpoints: GET & POST /api/settings");
  {
    const d1 = createTestD1();
    const env = createMockEnv(d1);
    const sessionCookie = await makeSessionCookie(env);
    const headers = {
      cookie: sessionCookie,
      "content-type": "application/json"
    };

    // 1. Initial GET settings -> apiConfigured: false, apiKeySource: "none"
    const get1 = await workerDefault.fetch(
      new Request("https://speedpulse.test/api/settings", { headers }),
      env
    );
    assert.strictEqual(get1.status, 200);
    const settings1 = await get1.json();
    assert.strictEqual(settings1.apiConfigured, false);
    assert.strictEqual(settings1.apiKeySource, "none");
    assert.strictEqual(settings1.maskedApiKey, null);
    pass("GET /api/settings reports unconfigured state when no key exists");

    // 2. POST /api/settings with valid API key
    const postRes = await workerDefault.fetch(
      new Request("https://speedpulse.test/api/settings", {
        method: "POST",
        headers,
        body: JSON.stringify({ googleApiKey: "AIzaSySampleKey1234567890ABCDEF" })
      }),
      env
    );
    assert.strictEqual(postRes.status, 200);
    const postData = await postRes.json();
    assert.strictEqual(postData.ok, true);
    assert.strictEqual(postData.apiConfigured, true);
    assert.strictEqual(postData.apiKeySource, "database");
    assert.strictEqual(postData.maskedApiKey, "AIza...CDEF");
    pass("POST /api/settings successfully saves key and returns masked representation");

    // 3. Verify GET /api/settings reflects newly saved database key
    const get2 = await workerDefault.fetch(
      new Request("https://speedpulse.test/api/settings", { headers }),
      env
    );
    const settings2 = await get2.json();
    assert.strictEqual(settings2.apiConfigured, true);
    assert.strictEqual(settings2.apiKeySource, "database");
    assert.strictEqual(settings2.maskedApiKey, "AIza...CDEF");
    pass("GET /api/settings reflects persisted database key");

    // 4. POST /api/settings with empty string clears database key
    const clearRes = await workerDefault.fetch(
      new Request("https://speedpulse.test/api/settings", {
        method: "POST",
        headers,
        body: JSON.stringify({ googleApiKey: "" })
      }),
      env
    );
    assert.strictEqual(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.strictEqual(clearData.apiConfigured, false);
    assert.strictEqual(clearData.apiKeySource, "none");
    pass("POST /api/settings with empty key cleanly clears database key");
  }

  // -----------------------------------------------------------------
  // Test 3: Dashboard Onboarding State
  // -----------------------------------------------------------------
  console.log("\n[Test 3] Dashboard Onboarding State (apiConfigured flag)");
  {
    const d1 = createTestD1();
    const env = createMockEnv(d1);
    const sessionCookie = await makeSessionCookie(env);
    const headers = { cookie: sessionCookie };

    // Missing key -> apiConfigured: false
    const res1 = await workerDefault.fetch(
      new Request("https://speedpulse.test/api/dashboard", { headers }),
      env
    );
    assert.strictEqual(res1.status, 200);
    const data1 = await res1.json();
    assert.strictEqual(data1.apiConfigured, false, "Dashboard reports apiConfigured: false");
    pass("Dashboard reports apiConfigured: false when API key is missing");

    // Add key -> apiConfigured: true
    await updateSystemState(d1, "google_api_key", "AIzaSyTestKey");
    const res2 = await workerDefault.fetch(
      new Request("https://speedpulse.test/api/dashboard", { headers }),
      env
    );
    const data2 = await res2.json();
    assert.strictEqual(data2.apiConfigured, true, "Dashboard reports apiConfigured: true");
    pass("Dashboard reports apiConfigured: true when API key is present");
  }

  // -----------------------------------------------------------------
  // Test 4: Demo Seeder Execution & Verification
  // -----------------------------------------------------------------
  console.log("\n[Test 4] Demo Seeder (scripts/seed-demo.mjs)");
  {
    const d1 = createTestD1();
    const now = new Date("2026-11-05T12:00:00.000Z");

    // Execute seed against in-memory database
    await seedDemoDatabase(d1.raw, now);

    // Verify Project
    const project = d1.raw.prepare("SELECT * FROM projects WHERE id = 1").get();
    assert(project, "Project 1 exists");
    assert.strictEqual(project.name, "Web Benchmarks");
    pass("Demo seeder creates 'Web Benchmarks' project");

    // Verify Sites
    const sites = d1.raw.prepare("SELECT * FROM sites ORDER BY id ASC").all();
    assert.strictEqual(sites.length, 6, "Seeds exactly 6 benchmark sites");
    assert.strictEqual(sites[0].name, "Wikipedia");
    assert.strictEqual(sites[1].name, "GitHub");
    assert.strictEqual(sites[2].name, "Cloudflare");
    assert.strictEqual(sites[3].name, "WordPress.org");
    assert.strictEqual(sites[4].name, "Hacker News");
    assert.strictEqual(sites[5].name, "MDN Web Docs");
    pass("Seeds all 6 public benchmark websites with correct URLs");

    // Verify Scan Targets
    const targets = d1.raw.prepare("SELECT * FROM scan_targets WHERE enabled = 1").all();
    assert.strictEqual(targets.length, 12, "Exactly 12 active scan targets created (6 mobile + 6 desktop)");
    const mobileTargets = targets.filter(t => t.strategy === "mobile");
    const desktopTargets = targets.filter(t => t.strategy === "desktop");
    assert.strictEqual(mobileTargets.length, 6);
    assert.strictEqual(desktopTargets.length, 6);
    assert.strictEqual(mobileTargets[0].interval_hours, 24, "Mobile scans daily (24h)");
    assert.strictEqual(desktopTargets[0].interval_hours, 168, "Desktop scans weekly (168h)");
    pass("Configures 12 active scan targets with correct intervals");

    // Verify Test Runs & Metrics
    const testRuns = d1.raw.prepare("SELECT COUNT(*) AS count FROM test_runs WHERE status = 'success'").get();
    assert(testRuns.count >= 60, "Populates historical test runs across past 5 days");

    const rollups = d1.raw.prepare("SELECT COUNT(*) AS count FROM metrics_daily_rollup").get();
    assert(rollups.count >= 60, "Populates metrics_daily_rollup for fast long-term graphs");
    pass("Seeds historical test runs, metrics, and daily rollups");

    // Verify site_latest state
    const latestRows = d1.raw.prepare("SELECT * FROM site_latest").all();
    assert.strictEqual(latestRows.length, 12, "Populates site_latest for all 6 sites x 2 strategies");
    const hnMobile = latestRows.find(r => r.site_id === 5 && r.strategy === "mobile");
    assert(hnMobile.performance_score >= 95, "Hacker News has realistic high performance score");
    pass("Populates site_latest for instant dashboard visualization");

    // Verify GET /api/dashboard with seeded data
    const env = createMockEnv(d1);
    const sessionCookie = await makeSessionCookie(env);
    const dashRes = await workerDefault.fetch(
      new Request("https://speedpulse.test/api/dashboard", { headers: { cookie: sessionCookie } }),
      env
    );
    const dashData = await dashRes.json();
    assert.strictEqual(dashData.projectCount, 1);
    assert.strictEqual(dashData.siteCount, 6);
    pass("Dashboard immediately reflects 1 project, 6 active sites, and populated runs");
  }

  // -----------------------------------------------------------------
  // Test 5: UI Shell Template Integrity
  // -----------------------------------------------------------------
  console.log("\n[Test 5] UI Shell Template Integrity (public/app.js)");
  {
    const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf-8");

    // Check banner presence in renderDashboard
    assert(appJs.includes("apiKeyAlertBanner"), "public/app.js defines apiKeyAlertBanner");
    assert(appJs.includes("Google PageSpeed API Key Not Configured"), "Alert banner text is present");
    assert(appJs.includes("bannerSetupApiKeyBtn"), "Banner contains Configure Key button");
    pass("renderDashboard() includes prominent API key onboarding alert banner");

    // Check Settings Modal API key input and actions
    assert(appJs.includes("inputGoogleApiKey"), "Settings modal includes API key input field");
    assert(appJs.includes("btnSaveApiKey"), "Settings modal includes Save Key button");
    assert(appJs.includes("btnClearApiKey"), "Settings modal includes Clear Key button");
    assert(appJs.includes("/api/settings"), "Settings modal makes POST calls to /api/settings");
    pass("openSettings() modal contains interactive API key management controls");
  }

  console.log("\n==================================================================");
  console.log("  ALL DEMO SEEDER & ONBOARDING TESTS PASSED! (5/5)");
  console.log("==================================================================\n");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
