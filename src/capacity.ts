import type { Env } from "./types";
import { nowIso } from "./utils";
import {
  DEFAULT_QUOTA_CONFIGS,
  QUOTA_THRESHOLDS,
  getResourceDayKey,
  getQuotaUsage,
  evaluateQuotaStatus,
  type QuotaResource
} from "./quota";
import { updateSystemState } from "./control-plane";
import { getReportStorageBackend } from "./detailed-reports";

export const CRON_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export interface CronHeartbeat {
  lastCronRunAt: string | null;
  ageMs: number | null;
  ageMinutes: number | null;
  isStale: boolean;
  staleThresholdMs: number;
}

export interface ResourceCapacity {
  resource: QuotaResource;
  name: string;
  limit: number;
  used: number;
  remaining: number;
  percentage: number;
  dayKey: string;
  timezone: string;
  resetsDescription: string;
  status: "normal" | "slowdown" | "paused" | "blocked";
}

export interface CapacityOverview {
  at: string;
  heartbeat: CronHeartbeat;
  overallStatus: "normal" | "slowdown" | "paused" | "blocked";
  warningMessage: string | null;
  resources: ResourceCapacity[];
  storage: {
    backend: string;
    reportsCount: number;
    reportsBytes: number;
    d1LimitBytes: number;
    percentage: number;
  };
  fleet: {
    activeSites: number;
    estimatedDailyScans: number;
    safeCapacitySites: number;
  };
}

const RESOURCE_DISPLAY_NAMES: Record<QuotaResource, string> = {
  pagespeed_api: "Google PageSpeed Insights API",
  crux_api: "Google Chrome UX Report (CrUX) API",
  d1_writes: "Cloudflare D1 Rows Written",
  kv_writes: "Cloudflare Workers KV Writes",
  queue_writes: "Cloudflare Queue Messages"
};

/**
 * Stores the last cron run timestamp in system_state.
 */
export async function recordCronHeartbeat(
  db: D1Database,
  at = nowIso()
): Promise<void> {
  await updateSystemState(db, "last_cron_run", { at }, at);
}

/**
 * Retrieves the last cron run heartbeat and evaluates whether it is stale (> 15 minutes).
 */
export async function getCronHeartbeat(
  db: D1Database,
  at = nowIso()
): Promise<CronHeartbeat> {
  const row = await db
    .prepare(
      "SELECT value_json, updated_at FROM system_state WHERE key = 'last_cron_run' LIMIT 1"
    )
    .first<{ value_json: string; updated_at: string }>();

  if (!row) {
    return {
      lastCronRunAt: null,
      ageMs: null,
      ageMinutes: null,
      isStale: true,
      staleThresholdMs: CRON_STALE_THRESHOLD_MS
    };
  }

  let lastRunAt = row.updated_at;
  try {
    const parsed = JSON.parse(row.value_json);
    if (parsed && typeof parsed.at === "string") {
      lastRunAt = parsed.at;
    }
  } catch {}

  const currentTime = new Date(at).getTime();
  const lastTime = new Date(lastRunAt).getTime();
  const ageMs = Math.max(0, currentTime - lastTime);
  const isStale = ageMs > CRON_STALE_THRESHOLD_MS;

  return {
    lastCronRunAt: lastRunAt,
    ageMs,
    ageMinutes: Math.round((ageMs / 60000) * 10) / 10,
    isStale,
    staleThresholdMs: CRON_STALE_THRESHOLD_MS
  };
}

/**
 * Builds the comprehensive capacity overview including usage vs limit from the ledger,
 * cron heartbeat, and storage headroom.
 */
export async function getCapacityOverview(
  env: Env,
  at = nowIso()
): Promise<CapacityOverview> {
  const heartbeat = await getCronHeartbeat(env.DB, at);
  const quotaEval = await evaluateQuotaStatus(env.DB, at);

  const resourceKeys: QuotaResource[] = [
    "pagespeed_api",
    "crux_api",
    "d1_writes",
    "kv_writes",
    "queue_writes"
  ];

  const resources: ResourceCapacity[] = [];

  for (const resource of resourceKeys) {
    const cfg = DEFAULT_QUOTA_CONFIGS[resource];
    const dayKey = getResourceDayKey(resource, at);
    const used = await getQuotaUsage(env.DB, resource, at);
    const limit = cfg.limit;
    const remaining = Math.max(0, limit - used);
    const percentage = Math.min(100, Math.round((used / limit) * 1000) / 10);

    let status: "normal" | "slowdown" | "paused" | "blocked" = "normal";
    if (percentage >= QUOTA_THRESHOLDS.BLOCK_MANUAL * 100) {
      status = "blocked";
    } else if (percentage >= QUOTA_THRESHOLDS.PAUSE_SCHEDULED * 100) {
      status = "paused";
    } else if (percentage >= QUOTA_THRESHOLDS.SLOWDOWN * 100) {
      status = "slowdown";
    }

    const tzDesc =
      cfg.timezone === "UTC"
        ? "Resets 00:00 UTC"
        : "Resets 00:00 Pacific (Google API quota)";

    resources.push({
      resource,
      name: RESOURCE_DISPLAY_NAMES[resource] || resource,
      limit,
      used,
      remaining,
      percentage,
      dayKey,
      timezone: cfg.timezone,
      resetsDescription: tzDesc,
      status
    });
  }

  // Storage metrics
  const backend = getReportStorageBackend(env);
  let reportsCount = 0;
  let reportsBytes = 0;

  try {
    const reportStats = await env.DB.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_bytes
       FROM detailed_reports
       WHERE state = 'ready'`
    ).first<{ count: number; total_bytes: number }>();

    reportsCount = Number(reportStats?.count || 0);
    reportsBytes = Number(reportStats?.total_bytes || 0);
  } catch {}

  const d1LimitBytes = 500 * 1024 * 1024; // 500 MB free tier limit
  const storagePercentage = Math.min(
    100,
    Math.round((reportsBytes / d1LimitBytes) * 1000) / 10
  );

  // Fleet stats
  let activeSites = 0;
  try {
    const siteStats = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM sites WHERE active = 1"
    ).first<{ count: number }>();
    activeSites = Number(siteStats?.count || 0);
  } catch {}

  const estimatedDailyScans = activeSites * 2; // mobile + desktop daily
  // Safe capacity on Free plan with D1 storage: 500 sites (~1,000 scans/day)
  const safeCapacitySites = backend === "d1" ? 500 : 250;

  return {
    at,
    heartbeat,
    overallStatus: quotaEval.status,
    warningMessage: quotaEval.warningMessage || null,
    resources,
    storage: {
      backend,
      reportsCount,
      reportsBytes,
      d1LimitBytes,
      percentage: storagePercentage
    },
    fleet: {
      activeSites,
      estimatedDailyScans,
      safeCapacitySites
    }
  };
}
