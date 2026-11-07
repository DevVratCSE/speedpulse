-- ================================================================
-- SpeedPulse Next
-- Migration 0007
--
-- Real-time D1 Quota Ledger with Dual Timezone Tracking
--
-- Tracks daily consumption across:
--   - pagespeed_api (Google Cloud: 00:00 Pacific reset)
--   - crux_api (Google Cloud: 00:00 Pacific reset)
--   - kv_writes (Cloudflare: 00:00 UTC reset)
--   - queue_writes (Cloudflare: 00:00 UTC reset)
--   - d1_writes (Cloudflare: 00:00 UTC reset)
-- ================================================================

CREATE TABLE IF NOT EXISTS quota_ledger (
  resource TEXT NOT NULL,
  day_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (resource, day_key)
);

CREATE INDEX IF NOT EXISTS idx_quota_ledger_resource_day ON quota_ledger(resource, day_key);
