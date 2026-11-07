import type { Env, Frequency, Strategy } from "./types";
import { authConfigured, clearSessionCookie, isAuthenticated, makeSessionCookie, passwordMatches } from "./auth";
import {
  getActiveJob,
  getEffectiveGoogleApiKey,
  getQueueWorkspace,
  listRecentSiteScanJobs,
  getScanJobById,
  getSystemHealth,
  getScanTargetSchedule,
  listRecentScanJobs,
  listScanTargets,
  sweepStaleJobs,
  updateScanTargetSchedule,
  updateSystemState
} from "./control-plane";
import {
  previewNextScheduler,
  runNextSchedulerTick
} from "./scheduler";
import {
  enqueueScanJob,
  processScanQueueBatch,
  type ScanQueueMessage
} from "./queue";
import {
  applyBulkMonitoring,
  applyBulkSchedule,
  BulkScheduleInputError,
  listRecentBulkJobs,
  queueBulkScans
} from "./bulk";
import { evaluateQuotaStatus } from "./quota";
import { runRetentionPruneTick } from "./rollups";
import { getCapacityOverview, recordCronHeartbeat } from "./capacity";
import {
  listNextProjects,
  listNextSiteIds,
  listNextSites
} from "./site-list";

import {
  queueDetailedReportsForProjectDeletion,
  queueDetailedReportsForSiteDeletion,
  getDetailedReportComparison,
  getDetailedReportHealth,
  getDetailedReportJsonResponse,
  listDetailedReports,
  processDetailedReportCleanup
} from "./detailed-reports";

import { apiError, clampText, json, normalizeUrl, nowIso, parsePositiveInt, readJson } from "./utils";

const allowedFrequency = new Set<Frequency>(["daily", "weekly", "manual"]);
const allowedStrategy = new Set<Strategy>(["mobile", "desktop"]);

function intParam(value: string | undefined): number | null {
  const n = Number.parseInt(value || "", 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function frequency(value: unknown, fallback: Frequency): Frequency {
  const v = String(value || fallback) as Frequency;
  return allowedFrequency.has(v) ? v : fallback;
}

function strategy(value: unknown, fallback: Strategy = "mobile"): Strategy {
  const v = String(value || fallback) as Strategy;
  return allowedStrategy.has(v) ? v : fallback;
}

function initialDue(freq: Frequency): string | null {
  return freq === "manual" ? null : nowIso();
}

async function handleAuth(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/auth/me" && request.method === "GET") {
    return json({ authenticated: await isAuthenticated(request, env), configured: authConfigured(env) });
  }
  if (path === "/api/auth/login" && request.method === "POST") {
    if (!authConfigured(env)) return apiError("Authentication secrets are not configured. See SETUP.md.", 503);
    const body = await readJson<{ password?: string }>(request);
    if (!body.password || !(await passwordMatches(env, body.password))) return apiError("Invalid password", 401);
    return json({ ok: true }, 200, { "set-cookie": await makeSessionCookie(env) });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }
  return null;
}

async function dashboard(env: Env): Promise<Response> {
  const startOfDay = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const [[projectCount, siteCount, testsToday, attentionCount, attention], effectiveApiKey] =
    await Promise.all([
      env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS count FROM projects"),
        env.DB.prepare("SELECT COUNT(*) AS count FROM sites WHERE active=1"),
        env.DB.prepare("SELECT COUNT(*) AS count FROM test_runs WHERE status='success' AND completed_at >= ?").bind(startOfDay),
        env.DB.prepare(
          `SELECT COUNT(*) AS count
             FROM sites s
             LEFT JOIN site_latest l ON l.site_id=s.id AND l.strategy='mobile'
            WHERE s.active=1 AND l.lcp_ms > 4000`
        ),
        env.DB.prepare(
          `SELECT s.id, s.name, s.url, p.name AS project_name,
                  l.lcp_ms, l.performance_score, l.field_lcp_ms, l.field_inp_ms, l.field_cls, l.recorded_at,
                  s.mobile_last_status, s.mobile_last_error
             FROM sites s
             JOIN projects p ON p.id=s.project_id
             LEFT JOIN site_latest l ON l.site_id=s.id AND l.strategy='mobile'
            WHERE s.active=1 AND l.lcp_ms > 4000
            ORDER BY l.lcp_ms DESC
            LIMIT 10`
        )
      ]),
      getEffectiveGoogleApiKey(env)
    ]);

  return json({
    projectCount: Number((projectCount.results?.[0] as any)?.count || 0),
    siteCount: Number((siteCount.results?.[0] as any)?.count || 0),
    testsToday: Number((testsToday.results?.[0] as any)?.count || 0),
    attentionCount: Number((attentionCount.results?.[0] as any)?.count || 0),
    attention: attention.results || [],
    apiConfigured: Boolean(effectiveApiKey)
  });
}

async function listProjects(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.created_at,
            COUNT(s.id) AS site_count
       FROM projects p
       LEFT JOIN sites s ON s.project_id=p.id
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE`
  ).all();
  return json({ projects: result.results || [] });
}

async function createProject(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ name?: string; description?: string }>(request);
  const name = clampText(body.name, 100);
  if (!name) return apiError("Project name is required");
  const description = clampText(body.description, 500);
  const result = await env.DB.prepare("INSERT INTO projects(name,description,updated_at) VALUES(?,?,?)")
    .bind(name, description, nowIso()).run();
  return json({ ok: true, id: Number(result.meta.last_row_id) }, 201);
}

async function projectSites(env: Env, projectId: number): Promise<Response> {
  const project = await env.DB.prepare("SELECT * FROM projects WHERE id=?").bind(projectId).first();
  if (!project) return apiError("Project not found", 404);
  const result = await env.DB.prepare(
    `SELECT s.*,
      m.performance_score AS mobile_performance, m.accessibility_score AS mobile_accessibility,
      m.seo_score AS mobile_seo, m.best_practices_score AS mobile_best_practices,
      m.lcp_ms AS mobile_lcp_ms, m.cls AS mobile_cls, m.tbt_ms AS mobile_tbt_ms,
      m.field_lcp_ms AS mobile_field_lcp_ms, m.field_inp_ms AS mobile_field_inp_ms, m.field_cls AS mobile_field_cls,
      m.recorded_at AS mobile_recorded_at,
      d.performance_score AS desktop_performance, d.lcp_ms AS desktop_lcp_ms, d.recorded_at AS desktop_recorded_at
     FROM sites s
     LEFT JOIN site_latest m ON m.site_id=s.id AND m.strategy='mobile'
     LEFT JOIN site_latest d ON d.site_id=s.id AND d.strategy='desktop'
     WHERE s.project_id=?
     ORDER BY s.name COLLATE NOCASE`
  ).bind(projectId).all();
  return json({ project, sites: result.results || [] });
}

async function createSite(request: Request, env: Env, projectId: number): Promise<Response> {
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first();
  if (!project) return apiError("Project not found", 404);
  const body = await readJson<{ name?: string; url?: string; mobile_frequency?: Frequency; desktop_frequency?: Frequency }>(request);
  let normalized;
  try { normalized = normalizeUrl(body.url || ""); } catch (e) { return apiError(e instanceof Error ? e.message : "Invalid URL"); }
  const name = clampText(body.name, 120) || new URL(normalized.url).hostname;
  const mobile = frequency(body.mobile_frequency, "daily");
  const desktop = frequency(body.desktop_frequency, "weekly");
  try {
    const result = await env.DB.prepare(
      `INSERT INTO sites(project_id,name,url,origin,mobile_frequency,desktop_frequency,mobile_next_check_at,desktop_next_check_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(projectId, name, normalized.url, normalized.origin, mobile, desktop, initialDue(mobile), initialDue(desktop), nowIso()).run();
    return json({ ok: true, id: Number(result.meta.last_row_id) }, 201);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.toLowerCase().includes("unique")) return apiError("This URL already exists in the project", 409);
    throw e;
  }
}

async function importSites(request: Request, env: Env, projectId: number): Promise<Response> {
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first();
  if (!project) return apiError("Project not found", 404);
  const body = await readJson<{ sites?: Array<{ name?: string; url?: string }>; mobile_frequency?: Frequency; desktop_frequency?: Frequency }>(request);
  if (!Array.isArray(body.sites) || body.sites.length === 0) return apiError("No sites supplied");
  if (body.sites.length > 50) return apiError("Import at most 50 sites per request", 413);
  const mobile = frequency(body.mobile_frequency, "daily");
  const desktop = frequency(body.desktop_frequency, "weekly");
  const statements: D1PreparedStatement[] = [];
  let rejected = 0;
  for (const item of body.sites) {
    try {
      const normalized = normalizeUrl(item.url || "");
      const name = clampText(item.name, 120) || new URL(normalized.url).hostname;
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO sites(project_id,name,url,origin,mobile_frequency,desktop_frequency,mobile_next_check_at,desktop_next_check_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      ).bind(projectId, name, normalized.url, normalized.origin, mobile, desktop, initialDue(mobile), initialDue(desktop), nowIso()));
    } catch { rejected++; }
  }
  if (!statements.length) return apiError("No valid sites supplied");
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((sum, r) => sum + Number(r.meta.changes || 0), 0);
  return json({ ok: true, inserted, duplicates: statements.length - inserted, rejected });
}

async function siteDetail(
  env: Env,
  siteId: number
): Promise<Response> {
  /*
   * CHECKPOINT-18:
   *
   * Expose the active logical Queue job for both strategies.
   *
   * This makes a page refresh authoritative: the browser can tell
   * whether the current site is queued, running or retrying instead
   * of interpreting sites.*_last_status in isolation.
   */
  const [
    site,
    latest,
    annotations,
    mobileActiveJob,
    desktopActiveJob
  ] =
    await Promise.all([
      env.DB.prepare(
        `SELECT
           s.*,
           p.name AS project_name
         FROM sites s
         JOIN projects p
           ON p.id=s.project_id
         WHERE s.id=?`
      )
        .bind(
          siteId
        )
        .first(),

      env.DB.prepare(
        `SELECT *
           FROM site_latest
          WHERE site_id=?
          ORDER BY strategy`
      )
        .bind(
          siteId
        )
        .all(),

      env.DB.prepare(
        `SELECT *
           FROM annotations
          WHERE site_id=?
          ORDER BY created_at DESC
          LIMIT 50`
      )
        .bind(
          siteId
        )
        .all(),

      getActiveJob(
        env.DB,
        siteId,
        "mobile"
      ),

      getActiveJob(
        env.DB,
        siteId,
        "desktop"
      )
    ]);


  if (!site) {
    return apiError(
      "Site not found",
      404
    );
  }


  return json({
    site,

    latest:
      latest.results ||
      [],

    annotations:
      annotations.results ||
      [],

    activeJobs: {
      mobile:
        mobileActiveJob,

      desktop:
        desktopActiveJob
    }
  });
}

async function updateSite(request: Request, env: Env, siteId: number): Promise<Response> {
  const current: any = await env.DB.prepare("SELECT * FROM sites WHERE id=?").bind(siteId).first();
  if (!current) return apiError("Site not found", 404);
  const body = await readJson<any>(request);
  const name = clampText(body.name ?? current.name, 120) || current.name;
  const active = body.active === undefined ? Number(current.active) : body.active ? 1 : 0;
  const mobile = frequency(body.mobile_frequency, current.mobile_frequency);
  const desktop = frequency(body.desktop_frequency, current.desktop_frequency);
  const mobileNext = mobile === "manual" ? null : (current.mobile_next_check_at || nowIso());
  const desktopNext = desktop === "manual" ? null : (current.desktop_next_check_at || nowIso());
  await env.DB.prepare(
    `UPDATE sites SET name=?,active=?,mobile_frequency=?,desktop_frequency=?,mobile_next_check_at=?,desktop_next_check_at=?,updated_at=? WHERE id=?`
  ).bind(name, active, mobile, desktop, mobileNext, desktopNext, nowIso(), siteId).run();
  return json({ ok: true });
}

async function siteHistory(request: Request, env: Env, siteId: number): Promise<Response> {
  const url = new URL(request.url);
  const strat = strategy(url.searchParams.get("strategy"), "mobile");
  const daysRaw = url.searchParams.get("days") || "90";
  const days = daysRaw === "all"
    ? 0
    : Math.min(Math.max(Number.parseInt(daysRaw, 10) || 90, 1), 3650);

  // 1Y (365) and All ranges read from daily rollups for fast rendering & >90d retention
  const useRollups = daysRaw === "all" || days > 90;

  if (useRollups) {
    const cutoff = days > 0
      ? new Date(Date.now() - days * 86_400_000).toISOString()
      : null;

    const sql = cutoff
      ? `SELECT * FROM metrics_daily_rollup
          WHERE site_id=? AND strategy=? AND recorded_at >= ?
          ORDER BY recorded_at ASC
          LIMIT 1500`
      : `SELECT * FROM metrics_daily_rollup
          WHERE site_id=? AND strategy=?
          ORDER BY recorded_at ASC
          LIMIT 3000`;

    const stmt = cutoff
      ? env.DB.prepare(sql).bind(siteId, strat, cutoff)
      : env.DB.prepare(sql).bind(siteId, strat);

    const result = await stmt.all();
    return json({
      strategy: strat,
      days: days || "all",
      from_rollup: true,
      history: result.results || []
    });
  }

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const sql = `SELECT * FROM (
       SELECT * FROM metrics
        WHERE site_id=? AND strategy=? AND recorded_at >= ?
        ORDER BY recorded_at DESC
        LIMIT 1500
     ) ORDER BY recorded_at ASC`;

  const stmt = env.DB.prepare(sql).bind(siteId, strat, cutoff);
  const result = await stmt.all();
  return json({
    strategy: strat,
    days: days || "all",
    from_rollup: false,
    history: result.results || []
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportHistory(request: Request, env: Env, siteId: number): Promise<Response> {
  const url = new URL(request.url);
  const strat = strategy(url.searchParams.get("strategy"), "mobile");
  const rows = await env.DB.prepare("SELECT * FROM metrics WHERE site_id=? AND strategy=? ORDER BY recorded_at ASC").bind(siteId, strat).all<any>();
  const headers = ["recorded_at","strategy","performance_score","accessibility_score","seo_score","best_practices_score","fcp_ms","lcp_ms","tbt_ms","cls","speed_index_ms","field_lcp_ms","field_inp_ms","field_cls","field_data_source","field_period_start","field_period_end"];
  const lines = [headers.join(","), ...(rows.results || []).map((row: any) => headers.map((h) => csvCell(row[h])).join(","))];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="speedpulse-${siteId}-${strat}.csv"`, "cache-control": "no-store" } });
}

async function addAnnotation(request: Request, env: Env, siteId: number): Promise<Response> {
  const body = await readJson<{ note?: string }>(request);
  const note = clampText(body.note, 1000);
  if (!note) return apiError("Note is required");
  await env.DB.prepare("INSERT INTO annotations(site_id,note) VALUES(?,?)").bind(siteId, note).run();
  return json({ ok: true }, 201);
}

async function queueManualScan(
  env: Env,
  siteId: number,
  scanStrategy: Strategy
): Promise<Response> {
  const quotaEval = await evaluateQuotaStatus(env.DB);
  if (quotaEval.shouldBlockManual) {
    return apiError(
      `Daily quota exhausted: ${quotaEval.warningMessage || "operations blocked until reset"}.`,
      429
    );
  }

  const result =
    await enqueueScanJob(
      env,
      {
        siteId,
        strategy:
          scanStrategy,
        trigger: "manual"
      }
    );

  if (!result.created) {
    if (
      result.reason ===
      "site_not_found"
    ) {
      return apiError(
        "Site not found",
        404
      );
    }

    if (
      result.reason ===
      "site_inactive"
    ) {
      return apiError(
        "Site is inactive",
        409
      );
    }

    return json(
      {
        ok: true,
        duplicate: true,
        job: result.job,
        warning: quotaEval.warningMessage
      },
      202
    );
  }

  return json(
    {
      ok: true,
      duplicate: false,
      job: result.job,
      warning: quotaEval.warningMessage
    },
    202
  );
}


async function queueProject(
  request: Request,
  env: Env,
  projectId: number
): Promise<Response> {
  const project =
    await env.DB.prepare(
      "SELECT id FROM projects WHERE id=?"
    )
      .bind(projectId)
      .first();

  if (!project) {
    return apiError(
      "Project not found",
      404
    );
  }

  const body =
    await readJson<{
      strategy?: Strategy;
    }>(request)
      .catch(
        () => ({
          strategy:
            "mobile" as Strategy
        })
      );

  const strat =
    strategy(
      body.strategy,
      "mobile"
    );

  /*
   * Preserve the old project's "queue automatic sites"
   * semantics while routing execution through scan_jobs + Queue.
   *
   * Monitoring-paused and manual-only targets are intentionally
   * excluded.
   */
  const result =
    await env.DB.prepare(
      `SELECT s.id
         FROM sites s

         JOIN scan_targets st
           ON st.site_id=s.id
          AND st.strategy=?

        WHERE s.project_id=?
          AND s.active=1
          AND st.enabled=1
          AND st.schedule_type != 'manual'

        ORDER BY s.id
        LIMIT 501`
    )
      .bind(
        strat,
        projectId
      )
      .all<{
        id: number;
      }>();

  const siteIds =
    (result.results || [])
      .map(
        (row) =>
          Number(row.id)
      );

  if (
    siteIds.length > 500
  ) {
    return apiError(
      "This project contains more than 500 eligible sites. Use the Next management interface to queue scans in smaller batches.",
      413
    );
  }

  if (
    siteIds.length === 0
  ) {
    return json({
      ok: true,
      queued: 0,
      skipped: 0,
      strategy: strat,
      bulkJobId: null
    });
  }

  const bulk =
    await queueBulkScans(
      env,
      {
        siteIds,
        strategies: strat
      }
    );

  return json(
    {
      ok: true,
      queued:
        bulk.queued,
      skipped:
        bulk.skipped,
      strategy:
        strat,
      bulkJobId:
        bulk.bulkJobId
    },
    202
  );
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") return json({ ok: true, service: "speedpulse" });
  const authResponse = await handleAuth(request, env, path);
  if (authResponse) return authResponse;
  if (!(await isAuthenticated(request, env))) return apiError("Unauthorized", 401);

  if (path === "/api/settings" && request.method === "GET") {
    const apiKey = await getEffectiveGoogleApiKey(env);
    const apiKeySource = env.GOOGLE_API_KEY ? "env" : apiKey ? "database" : "none";
    const maskedApiKey = apiKey
      ? (apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "••••••••")
      : null;
    return json({
      apiConfigured: Boolean(apiKey),
      apiKeySource,
      maskedApiKey,
      authConfigured: authConfigured(env),
      scheduleBatchSize: parsePositiveInt(
        env.NEXT_SCHEDULER_BATCH_SIZE || env.SCHEDULE_BATCH_SIZE,
        1,
        50
      ),
      cron: env.CRON_SCHEDULE || "unknown"
    });
  }

  if (path === "/api/settings" && request.method === "POST") {
    const body = await readJson<{ googleApiKey?: string }>(request);
    if (typeof body.googleApiKey === "string") {
      const trimmed = body.googleApiKey.trim();
      if (trimmed.length > 0) {
        if (trimmed.length > 128) {
          return apiError("API key is too long (maximum 128 characters)", 400);
        }
        await updateSystemState(env.DB, "google_api_key", trimmed, nowIso());
      } else {
        await env.DB.prepare("DELETE FROM system_state WHERE key = 'google_api_key'").run();
      }
    }
    const apiKey = await getEffectiveGoogleApiKey(env);
    const apiKeySource = env.GOOGLE_API_KEY ? "env" : apiKey ? "database" : "none";
    const maskedApiKey = apiKey
      ? (apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "••••••••")
      : null;
    return json({
      ok: true,
      apiConfigured: Boolean(apiKey),
      apiKeySource,
      maskedApiKey
    });
  }
  let nextMatch =
    path.match(
      /^\/api\/next\/sites\/(\d+)\/run$/
    );

  if (
    nextMatch &&
    request.method === "POST"
  ) {
    const body =
      await readJson<{
        strategy?: Strategy;
      }>(request);

    if (
      body.strategy !== "mobile" &&
      body.strategy !== "desktop"
    ) {
      return apiError(
        "strategy must be mobile or desktop"
      );
    }

    return queueManualScan(
      env,
      Number(nextMatch[1]),
      body.strategy
    );
  }

  if (
    path === "/api/next/projects" &&
    request.method === "GET"
  ) {
    return json({
      projects:
        await listNextProjects(
          env.DB
        )
    });
  }

  if (
    path === "/api/next/sites/ids" &&
    request.method === "GET"
  ) {
    const projectRaw =
      url.searchParams.get(
        "projectId"
      );

    const activeRaw =
      url.searchParams.get(
        "active"
      );

    const result =
      await listNextSiteIds(
        env.DB,
        {
          q:
            url.searchParams.get(
              "q"
            ) || "",
          projectId:
            projectRaw
              ? Number(
                  projectRaw
                )
              : undefined,
          active:
            activeRaw === "1"
              ? true
              : activeRaw === "0"
                ? false
                : undefined
        }
      );

    return json(result);
  }

  if (
    path === "/api/next/sites" &&
    request.method === "GET"
  ) {
    const projectRaw =
      url.searchParams.get(
        "projectId"
      );

    const activeRaw =
      url.searchParams.get(
        "active"
      );

    const result =
      await listNextSites(
        env.DB,
        {
          page:
            Number(
              url.searchParams.get(
                "page"
              ) || "1"
            ),
          pageSize:
            Number(
              url.searchParams.get(
                "pageSize"
              ) || "50"
            ),
          q:
            url.searchParams.get(
              "q"
            ) || "",
          projectId:
            projectRaw
              ? Number(
                  projectRaw
                )
              : undefined,
          active:
            activeRaw === "1"
              ? true
              : activeRaw === "0"
                ? false
                : undefined
        }
      );

    return json(result);
  }

  if (
    path === "/api/next/bulk/run" &&
    request.method === "POST"
  ) {
    const body =
      await readJson<{
        siteIds?: unknown;
        strategies?: unknown;
      }>(request);

    try {
      const result =
        await queueBulkScans(
          env,
          body
        );

      return json(
        {
          ok: true,
          bulk: result
        },
        202
      );
    } catch (error) {
      if (
        error instanceof
        BulkScheduleInputError
      ) {
        return apiError(
          error.message,
          400
        );
      }

      console.error(
        "bulk.scan.run_failed",
        error
      );

      return apiError(
        "Bulk scan request failed",
        500
      );
    }
  }

  if (
    path === "/api/next/bulk/monitoring" &&
    request.method === "POST"
  ) {
    const body =
      await readJson<{
        siteIds?: unknown;
        strategies?: unknown;
        enabled?: unknown;
      }>(request);

    try {
      const result =
        await applyBulkMonitoring(
          env.DB,
          body
        );

      return json({
        ok: true,
        bulk: result
      });
    } catch (error) {
      if (
        error instanceof
        BulkScheduleInputError
      ) {
        return apiError(
          error.message,
          400
        );
      }

      console.error(
        "bulk.monitoring.failed",
        error
      );

      return apiError(
        "Bulk monitoring update failed",
        500
      );
    }
  }

  if (
    path === "/api/next/bulk/schedule" &&
    request.method === "POST"
  ) {
    const body =
      await readJson<{
        siteIds?: unknown;
        strategies?: unknown;
        schedule?: unknown;
      }>(request);

    try {
      const result =
        await applyBulkSchedule(
          env.DB,
          body
        );

      return json({
        ok: true,
        bulk: result
      });
    } catch (error) {
      if (
        error instanceof
        BulkScheduleInputError
      ) {
        return apiError(
          error.message,
          400
        );
      }

      console.error(
        "bulk.schedule.failed",
        error
      );

      return apiError(
        "Bulk schedule update failed",
        500
      );
    }
  }

  if (
    path === "/api/next/bulk/jobs" &&
    request.method === "GET"
  ) {
    const requested =
      Number(
        url.searchParams.get(
          "limit"
        ) || "20"
      );

    return json({
      jobs:
        await listRecentBulkJobs(
          env.DB,
          requested
        )
    });
  }

  const scheduleMatch = path.match(
    /^\/api\/next\/targets\/(\d+)\/(mobile|desktop)\/schedule$/
  );

  if (
    scheduleMatch &&
    request.method === "GET"
  ) {
    const siteId =
      Number(scheduleMatch[1]);

    const strategy =
      scheduleMatch[2] as
        | "mobile"
        | "desktop";

    const target =
      await getScanTargetSchedule(
        env.DB,
        siteId,
        strategy
      );

    if (!target) {
      return apiError(
        "Scan target not found",
        404
      );
    }

    return json({
      schedule: {
        siteId:
          target.site_id,
        strategy:
          target.strategy,
        active:
          target.active !== 0,
        enabled:
          target.enabled !== 0,
        type:
          target.schedule_type,
        timezone:
          target.timezone,
        config:
          JSON.parse(
            target.schedule_config_json
          ),
        nextDueAt:
          target.next_due_at,
        lastSuccessAt:
          target.last_success_at,
        lastFailureAt:
          target.last_failure_at
      }
    });
  }

  if (
    scheduleMatch &&
    request.method === "PUT"
  ) {
    const siteId =
      Number(scheduleMatch[1]);

    const strategy =
      scheduleMatch[2] as
        | "mobile"
        | "desktop";

    const body =
      await readJson<{
        type?: string;
        timezone?: string;
        config?: unknown;
      }>(request);

    try {
      const target =
        await updateScanTargetSchedule(
          env.DB,
          siteId,
          strategy,
          body
        );

      return json({
        ok: true,
        schedule: {
          siteId:
            target.site_id,
          strategy:
            target.strategy,
          active:
            target.active !== 0,
          enabled:
            target.enabled !== 0,
          type:
            target.schedule_type,
          timezone:
            target.timezone,
          config:
            JSON.parse(
              target.schedule_config_json
            ),
          nextDueAt:
            target.next_due_at,
          lastSuccessAt:
            target.last_success_at,
          lastFailureAt:
            target.last_failure_at
        }
      });
    } catch (error) {
      return apiError(
        error instanceof Error
          ? error.message
          : String(error),
        400
      );
    }
  }

  const siteReportsMatch =
    path.match(
      /^\/api\/next\/sites\/(\d+)\/reports$/
    );

  if (
    siteReportsMatch &&
    request.method === "GET"
  ) {
    const siteId =
      Number(
        siteReportsMatch[1]
      );

    const reportStrategy =
      strategy(
        url.searchParams.get(
          "strategy"
        ),
        "mobile"
      );

    return json({
      siteId,
      strategy:
        reportStrategy,

      reports:
        await listDetailedReports(
          env.DB,
          siteId,
          reportStrategy
        )
    });
  }


  const siteReportComparisonMatch =
    path.match(
      /^\/api\/next\/sites\/(\d+)\/report-comparison$/
    );

  if (
    siteReportComparisonMatch &&
    request.method === "GET"
  ) {
    const siteId =
      Number(
        siteReportComparisonMatch[1]
      );

    const reportStrategy =
      strategy(
        url.searchParams.get(
          "strategy"
        ),
        "mobile"
      );

    return json({
      siteId,

      strategy:
        reportStrategy,

      comparison:
        await getDetailedReportComparison(
          env.DB,
          siteId,
          reportStrategy
        )
    });
  }


  const jsonReportMatch =
    path.match(
      /^\/api\/next\/reports\/(\d+)\/json$/
    );

  if (
    jsonReportMatch &&
    request.method === "GET"
  ) {
    return await getDetailedReportJsonResponse(
      env,
      Number(
        jsonReportMatch[1]
      )
    );
  }


  if (
    path === "/api/next/reports/cleanup" &&
    request.method === "POST"
  ) {
    return json({
      ok: true,

      cleanup:
        await processDetailedReportCleanup(
          env,
          3
        )
    });
  }


  if (path === "/api/next/scheduler/preview" && request.method === "GET") {
    return json({
      scheduler: await previewNextScheduler(env)
    });
  }

  if (path === "/api/next/status" && request.method === "GET") {
    const [
      health,
      reports
    ] =
      await Promise.all([
        getSystemHealth(
          env.DB
        ),

        getDetailedReportHealth(
          env
        )
      ]);

    return json({
      ok: true,

      appEnv:
        env.APP_ENV ||
        "unknown",

      features: {
        legacyScheduler: false,

        nextScheduler:
          env.NEXT_SCHEDULER_ENABLED ===
          "1",

        queueScans:
          env.QUEUE_SCANS_ENABLED ===
          "1",

        detailedReports:
          env.DETAILED_REPORTS_ENABLED ===
          "1"
      },

      health,

      reports
    });
  }

  /*
   * CHECKPOINT-19:
   *
   * Thin authenticated operational endpoint for the main dashboard.
   * No mutations are performed here.
   */
  if (
    path ===
      "/api/next/queue-workspace" &&
    request.method ===
      "GET"
  ) {
    const limit =
      intParam(
        url.searchParams.get(
          "limit"
        ) ||
        undefined
      ) ||
      60;


    return json({
      queue:
        await getQueueWorkspace(
          env.DB,
          limit
        )
    });
  }


  if (path === "/api/next/targets" && request.method === "GET") {
    const limit = intParam(url.searchParams.get("limit") || undefined) || 100;
    return json({
      targets: await listScanTargets(env.DB, limit)
    });
  }

  const jobMatch =
    path.match(
      /^\/api\/next\/jobs\/(\d+)$/
    );

  if (
    jobMatch &&
    request.method === "GET"
  ) {
    const job =
      await getScanJobById(
        env.DB,
        Number(jobMatch[1])
      );

    if (!job) {
      return apiError(
        "Scan job not found",
        404
      );
    }

    return json({
      job
    });
  }

  if (path === "/api/next/jobs" && request.method === "GET") {
    const limit = intParam(url.searchParams.get("limit") || undefined) || 50;
    return json({
      jobs: await listRecentScanJobs(env.DB, limit)
    });
  }

  if (path === "/api/capacity" && request.method === "GET") return json(await getCapacityOverview(env));
  if (path === "/api/dashboard" && request.method === "GET") return dashboard(env);
  if (path === "/api/projects" && request.method === "GET") return listProjects(env);
  if (path === "/api/projects" && request.method === "POST") return createProject(request, env);

  let match = path.match(/^\/api\/projects\/(\d+)\/sites$/);
  if (match && request.method === "GET") return projectSites(env, Number(match[1]));
  if (match && request.method === "POST") return createSite(request, env, Number(match[1]));

  match = path.match(/^\/api\/projects\/(\d+)\/import$/);
  if (match && request.method === "POST") return importSites(request, env, Number(match[1]));
  match = path.match(/^\/api\/projects\/(\d+)\/queue$/);
  if (match && request.method === "POST") return queueProject(request, env, Number(match[1]));
  match = path.match(/^\/api\/projects\/(\d+)$/);
  if (match && request.method === "DELETE") {
    const projectId =
      Number(
        match[1]
      );

    await queueDetailedReportsForProjectDeletion(
      env.DB,
      projectId
    );

    const result =
      await env.DB.prepare(
        "DELETE FROM projects WHERE id=?"
      )
        .bind(
          projectId
        )
        .run();

    return json({
      ok: true,
      deleted:
        Number(
          result.meta.changes ||
          0
        )
    });
  }

  match = path.match(/^\/api\/sites\/(\d+)$/);
  if (match && request.method === "GET") return siteDetail(env, Number(match[1]));
  if (match && request.method === "PATCH") return updateSite(request, env, Number(match[1]));
  if (match && request.method === "DELETE") {
    const siteId =
      Number(
        match[1]
      );

    await queueDetailedReportsForSiteDeletion(
      env.DB,
      siteId
    );

    const result =
      await env.DB.prepare(
        "DELETE FROM sites WHERE id=?"
      )
        .bind(
          siteId
        )
        .run();

    return json({
      ok: true,
      deleted:
        Number(
          result.meta.changes ||
          0
        )
    });
  }


  /*
   * ==============================================================
   * CHECKPOINT-20: last two logical site scans
   * ==============================================================
   *
   * This endpoint deliberately reads scan_jobs rather than
   * test_runs. Provider retries remain represented by job.attempt.
   */
  const recentSiteScansMatch =
    path.match(
      /^\/api\/sites\/(\d+)\/recent-scans$/
    );


  if (
    recentSiteScansMatch &&
    request.method ===
      "GET"
  ) {
    const siteId =
      Number(
        recentSiteScansMatch[
          1
        ]
      );


    const scanStrategy =
      strategy(
        url.searchParams.get(
          "strategy"
        ),
        "mobile"
      );


    return json({
      siteId,

      strategy:
        scanStrategy,

      scans:
        await listRecentSiteScanJobs(
          env.DB,
          siteId,
          scanStrategy,
          2
        )
    });
  }


  match = path.match(/^\/api\/sites\/(\d+)\/history$/);
  if (match && request.method === "GET") return siteHistory(request, env, Number(match[1]));
  match = path.match(/^\/api\/sites\/(\d+)\/export$/);
  if (match && request.method === "GET") return exportHistory(request, env, Number(match[1]));
  match =
    path.match(
      /^\/api\/sites\/(\d+)\/run$/
    );

  if (
    match &&
    request.method === "POST"
  ) {
    const body =
      await readJson<{
        strategy?: Strategy;
      }>(request)
        .catch(
          () => ({
            strategy:
              "mobile" as Strategy
          })
        );

    return queueManualScan(
      env,
      Number(match[1]),
      strategy(
        body.strategy,
        "mobile"
      )
    );
  }

  match = path.match(/^\/api\/sites\/(\d+)\/annotations$/);
  if (match && request.method === "POST") return addAnnotation(request, env, Number(match[1]));

  return apiError("Not found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await routeApi(request, env);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return apiError(error instanceof Error ? error.message : "Unexpected error", 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await recordCronHeartbeat(env.DB);
    } catch (heartbeatError) {
      console.error("scheduler.heartbeat_failed", heartbeatError);
    }

    try {
      await sweepStaleJobs(env.DB);
    } catch (sweepError) {
      console.error("scheduler.stale_sweep_failed", sweepError);
    }

    ctx.waitUntil(
      processDetailedReportCleanup(
        env
      )
        .then(
          (summary) => {
            if (
              summary.deleted > 0 ||
              summary.failed > 0 ||
              summary.budgetExhausted
            ) {
              console.log(
                "detailed_report.cleanup_tick",
                JSON.stringify(
                  summary
                )
              );
            }
          }
        )
        .catch(
          (error) => {
            console.error(
              "detailed_report.cleanup_tick_failed",
              error
            );
          }
        )
    );

    ctx.waitUntil(
      runRetentionPruneTick(env.DB)
        .then((summary) => {
          if (
            summary.metricsPruned > 0 ||
            summary.runsPruned > 0 ||
            summary.jobsPruned > 0
          ) {
            console.log("retention.prune_tick", JSON.stringify(summary));
          }
        })
        .catch((error) => console.error("retention.prune_tick_failed", error))
    );

    const nextEnabled =
      env.NEXT_SCHEDULER_ENABLED === "1";

    if (nextEnabled) {
      ctx.waitUntil(
        runNextSchedulerTick(env)
          .then((result) =>
            console.log(
              "scheduler.next.completed",
              JSON.stringify(result)
            )
          )
          .catch((error) =>
            console.error(
              "scheduler.next.failed",
              error
            )
          )
      );
      return;
    }

    console.log(
      "scheduler.skipped",
      JSON.stringify({
        appEnv: env.APP_ENV || "unknown",
        nextEnabled: false
      })
    );
  },

  async queue(
    batch: MessageBatch<ScanQueueMessage>,
    env: Env
  ): Promise<void> {
    await processScanQueueBatch(
      batch,
      env
    );
  }
};
