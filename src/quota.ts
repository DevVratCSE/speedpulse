import { nowIso } from "./utils";

export type QuotaResource =
  | "pagespeed_api"
  | "crux_api"
  | "kv_writes"
  | "queue_writes"
  | "d1_writes";

export interface QuotaConfig {
  limit: number;
  timezone: "UTC" | "America/Los_Angeles";
}

export const DEFAULT_QUOTA_CONFIGS: Record<QuotaResource, QuotaConfig> = {
  pagespeed_api: { limit: 25000, timezone: "America/Los_Angeles" },
  crux_api: { limit: 25000, timezone: "America/Los_Angeles" },
  kv_writes: { limit: 1000, timezone: "UTC" },
  queue_writes: { limit: 10000, timezone: "UTC" },
  d1_writes: { limit: 100000, timezone: "UTC" }
};

export const QUOTA_THRESHOLDS = {
  SLOWDOWN: 0.70, // 70%: reduce batch size by 50%
  PAUSE_SCHEDULED: 0.90, // 90%: pause scheduled scans until reset
  BLOCK_MANUAL: 0.95 // 95%: block manual scans until reset
} as const;

export function getPacificDayKey(dateInput: Date | string | number = new Date()): string {
  const d = typeof dateInput === "string" || typeof dateInput === "number" ? new Date(dateInput) : dateInput;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(d);
  let year = "";
  let month = "";
  let day = "";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
  }
  return `${year}-${month}-${day}`;
}

export function getUtcDayKey(dateInput: Date | string | number = new Date()): string {
  const d = typeof dateInput === "string" || typeof dateInput === "number" ? new Date(dateInput) : dateInput;
  return d.toISOString().slice(0, 10);
}

export function getResourceDayKey(resource: QuotaResource, at: Date | string | number = new Date()): string {
  const config = DEFAULT_QUOTA_CONFIGS[resource];
  if (config?.timezone === "America/Los_Angeles") {
    return getPacificDayKey(at);
  }
  return getUtcDayKey(at);
}

export interface ResourceQuotaStatus {
  resource: QuotaResource;
  dayKey: string;
  count: number;
  limit: number;
  usageRatio: number;
  percentage: number;
  status: "normal" | "slowdown" | "paused" | "blocked";
  resetTimezone: "UTC" | "America/Los_Angeles";
}

export interface QuotaEvaluation {
  highestUsageRatio: number;
  mostConstrainedResource: QuotaResource | null;
  status: "normal" | "slowdown" | "paused" | "blocked";
  shouldSlowdown: boolean;
  shouldPauseScheduled: boolean;
  shouldBlockManual: boolean;
  warningMessage?: string;
  resources: Record<QuotaResource, ResourceQuotaStatus>;
}

export async function recordQuotaUsage(
  db: D1Database,
  resource: QuotaResource,
  amount = 1,
  atIso = nowIso()
): Promise<void> {
  const dayKey = getResourceDayKey(resource, atIso);
  try {
    await db
      .prepare(
        `INSERT INTO quota_ledger (resource, day_key, count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(resource, day_key)
         DO UPDATE SET
           count = quota_ledger.count + excluded.count,
           updated_at = excluded.updated_at`
      )
      .bind(resource, dayKey, amount, atIso)
      .run();
  } catch (error) {
    console.error("quota_ledger.record_failed", {
      resource,
      dayKey,
      amount,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function getQuotaUsage(
  db: D1Database,
  resource: QuotaResource,
  atIso = nowIso()
): Promise<number> {
  const dayKey = getResourceDayKey(resource, atIso);
  try {
    const row = await db
      .prepare("SELECT count FROM quota_ledger WHERE resource = ? AND day_key = ?")
      .bind(resource, dayKey)
      .first<{ count: number }>();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function evaluateQuotaStatus(
  db: D1Database,
  atIso = nowIso(),
  customLimits?: Partial<Record<QuotaResource, number>>
): Promise<QuotaEvaluation> {
  const resources: Partial<Record<QuotaResource, ResourceQuotaStatus>> = {};
  let highestRatio = 0;
  let mostConstrained: QuotaResource | null = null;

  const resourceKeys = Object.keys(DEFAULT_QUOTA_CONFIGS) as QuotaResource[];

  for (const resource of resourceKeys) {
    const config = DEFAULT_QUOTA_CONFIGS[resource];
    const limit = customLimits?.[resource] ?? config.limit;
    const dayKey = getResourceDayKey(resource, atIso);
    const count = await getQuotaUsage(db, resource, atIso);
    const usageRatio = limit > 0 ? count / limit : 0;
    const percentage = Math.round(usageRatio * 100);

    let status: "normal" | "slowdown" | "paused" | "blocked" = "normal";
    if (usageRatio >= QUOTA_THRESHOLDS.BLOCK_MANUAL) {
      status = "blocked";
    } else if (usageRatio >= QUOTA_THRESHOLDS.PAUSE_SCHEDULED) {
      status = "paused";
    } else if (usageRatio >= QUOTA_THRESHOLDS.SLOWDOWN) {
      status = "slowdown";
    }

    if (usageRatio > highestRatio) {
      highestRatio = usageRatio;
      mostConstrained = resource;
    }

    resources[resource] = {
      resource,
      dayKey,
      count,
      limit,
      usageRatio,
      percentage,
      status,
      resetTimezone: config.timezone
    };
  }

  const shouldSlowdown = highestRatio >= QUOTA_THRESHOLDS.SLOWDOWN;
  const shouldPauseScheduled = highestRatio >= QUOTA_THRESHOLDS.PAUSE_SCHEDULED;
  const shouldBlockManual = highestRatio >= QUOTA_THRESHOLDS.BLOCK_MANUAL;

  let overallStatus: "normal" | "slowdown" | "paused" | "blocked" = "normal";
  if (shouldBlockManual) {
    overallStatus = "blocked";
  } else if (shouldPauseScheduled) {
    overallStatus = "paused";
  } else if (shouldSlowdown) {
    overallStatus = "slowdown";
  }

  let warningMessage: string | undefined;
  if (mostConstrained && shouldSlowdown) {
    const stat = resources[mostConstrained]!;
    warningMessage = `Resource ${stat.resource} is at ${stat.percentage}% of daily quota (${stat.count}/${stat.limit}, resets 00:00 ${stat.resetTimezone})`;
  }

  return {
    highestUsageRatio: highestRatio,
    mostConstrainedResource: mostConstrained,
    status: overallStatus,
    shouldSlowdown,
    shouldPauseScheduled,
    shouldBlockManual,
    warningMessage,
    resources: resources as Record<QuotaResource, ResourceQuotaStatus>
  };
}

export function getEffectiveBatchSize(
  baseBatchSize: number,
  evaluation: QuotaEvaluation
): number {
  if (evaluation.shouldPauseScheduled) {
    return 0;
  }
  if (evaluation.shouldSlowdown) {
    return Math.max(1, Math.floor(baseBatchSize * 0.5));
  }
  return baseBatchSize;
}
