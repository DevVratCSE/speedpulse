-- ================================================================
-- SpeedPulse Next
-- Migration 0005
--
-- Converge legacy site management with the canonical Next
-- scan_targets control plane.
-- ================================================================


-- ----------------------------------------------------------------
-- New site creation
--
-- Migration 0003 intentionally created disabled targets while the
-- Next scheduler was being introduced. The Next scheduler is now
-- canonical, so future active sites need usable targets immediately.
-- ----------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sites_create_scan_targets;

CREATE TRIGGER trg_sites_create_scan_targets
AFTER INSERT ON sites
BEGIN

  INSERT OR IGNORE INTO scan_targets (
    site_id,
    strategy,
    enabled,
    interval_hours,
    next_due_at,
    created_at,
    updated_at,
    schedule_type,
    schedule_config_json,
    timezone
  )
  VALUES (
    NEW.id,
    'mobile',

    CASE
      WHEN NEW.active != 0
       AND NEW.mobile_frequency != 'manual'
        THEN 1
      ELSE 0
    END,

    CASE NEW.mobile_frequency
      WHEN 'daily' THEN 24
      WHEN 'weekly' THEN 168
      ELSE 72
    END,

    CASE
      WHEN NEW.active != 0
       AND NEW.mobile_frequency != 'manual'
        THEN strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          'now'
        )
      ELSE NULL
    END,

    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now'
    ),

    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now'
    ),

    CASE
      WHEN NEW.mobile_frequency = 'manual'
        THEN 'manual'
      ELSE 'interval'
    END,

    CASE NEW.mobile_frequency
      WHEN 'daily'
        THEN '{"minutes":1440}'
      WHEN 'weekly'
        THEN '{"minutes":10080}'
      ELSE '{}'
    END,

    'UTC'
  );


  INSERT OR IGNORE INTO scan_targets (
    site_id,
    strategy,
    enabled,
    interval_hours,
    next_due_at,
    created_at,
    updated_at,
    schedule_type,
    schedule_config_json,
    timezone
  )
  VALUES (
    NEW.id,
    'desktop',

    CASE
      WHEN NEW.active != 0
       AND NEW.desktop_frequency != 'manual'
        THEN 1
      ELSE 0
    END,

    CASE NEW.desktop_frequency
      WHEN 'daily' THEN 24
      WHEN 'weekly' THEN 168
      ELSE 72
    END,

    CASE
      WHEN NEW.active != 0
       AND NEW.desktop_frequency != 'manual'
        THEN strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          'now'
        )
      ELSE NULL
    END,

    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now'
    ),

    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      'now'
    ),

    CASE
      WHEN NEW.desktop_frequency = 'manual'
        THEN 'manual'
      ELSE 'interval'
    END,

    CASE NEW.desktop_frequency
      WHEN 'daily'
        THEN '{"minutes":1440}'
      WHEN 'weekly'
        THEN '{"minutes":10080}'
      ELSE '{}'
    END,

    'UTC'
  );

END;


-- ----------------------------------------------------------------
-- Site deactivation
--
-- Preserve next_due_at. An inactive/disabled target cannot dispatch,
-- and retaining the timestamp means custom schedules are not lost.
-- ----------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sites_disable_scan_targets;

CREATE TRIGGER trg_sites_disable_scan_targets
AFTER UPDATE OF active ON sites
WHEN OLD.active <> 0
 AND NEW.active = 0
BEGIN

  UPDATE scan_targets
     SET enabled = 0,
         updated_at =
           strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             'now'
           )
   WHERE site_id = NEW.id;

END;


-- ----------------------------------------------------------------
-- Site reactivation
--
-- Restore every automatic target without rewriting its custom
-- schedule type/config/timezone.
-- ----------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sites_reactivate_scan_targets;

CREATE TRIGGER trg_sites_reactivate_scan_targets
AFTER UPDATE OF active ON sites
WHEN OLD.active = 0
 AND NEW.active <> 0
BEGIN

  UPDATE scan_targets

     SET enabled =
           CASE
             WHEN schedule_type = 'manual'
               THEN 0
             ELSE 1
           END,

         next_due_at =
           CASE
             WHEN schedule_type = 'manual'
               THEN NULL
             ELSE COALESCE(
               next_due_at,
               strftime(
                 '%Y-%m-%dT%H:%M:%fZ',
                 'now'
               )
             )
           END,

         updated_at =
           strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             'now'
           )

   WHERE site_id = NEW.id;

END;


-- ----------------------------------------------------------------
-- Legacy mobile frequency compatibility
--
-- The old UI still exposes daily/weekly/manual. An explicit change
-- there intentionally converts the corresponding Next target into
-- the equivalent interval/manual schedule.
-- ----------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sites_sync_mobile_frequency;

CREATE TRIGGER trg_sites_sync_mobile_frequency
AFTER UPDATE OF mobile_frequency ON sites
WHEN OLD.mobile_frequency <> NEW.mobile_frequency
BEGIN

  UPDATE scan_targets

     SET schedule_type =
           CASE
             WHEN NEW.mobile_frequency = 'manual'
               THEN 'manual'
             ELSE 'interval'
           END,

         schedule_config_json =
           CASE NEW.mobile_frequency
             WHEN 'daily'
               THEN '{"minutes":1440}'
             WHEN 'weekly'
               THEN '{"minutes":10080}'
             ELSE '{}'
           END,

         timezone = 'UTC',

         interval_hours =
           CASE NEW.mobile_frequency
             WHEN 'daily' THEN 24
             WHEN 'weekly' THEN 168
             ELSE 72
           END,

         enabled =
           CASE
             WHEN NEW.active != 0
              AND NEW.mobile_frequency != 'manual'
               THEN 1
             ELSE 0
           END,

         next_due_at =
           CASE
             WHEN NEW.active != 0
              AND NEW.mobile_frequency != 'manual'
               THEN strftime(
                 '%Y-%m-%dT%H:%M:%fZ',
                 'now'
               )
             ELSE NULL
           END,

         updated_at =
           strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             'now'
           )

   WHERE site_id = NEW.id
     AND strategy = 'mobile';

END;


-- ----------------------------------------------------------------
-- Legacy desktop frequency compatibility
-- ----------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sites_sync_desktop_frequency;

CREATE TRIGGER trg_sites_sync_desktop_frequency
AFTER UPDATE OF desktop_frequency ON sites
WHEN OLD.desktop_frequency <> NEW.desktop_frequency
BEGIN

  UPDATE scan_targets

     SET schedule_type =
           CASE
             WHEN NEW.desktop_frequency = 'manual'
               THEN 'manual'
             ELSE 'interval'
           END,

         schedule_config_json =
           CASE NEW.desktop_frequency
             WHEN 'daily'
               THEN '{"minutes":1440}'
             WHEN 'weekly'
               THEN '{"minutes":10080}'
             ELSE '{}'
           END,

         timezone = 'UTC',

         interval_hours =
           CASE NEW.desktop_frequency
             WHEN 'daily' THEN 24
             WHEN 'weekly' THEN 168
             ELSE 72
           END,

         enabled =
           CASE
             WHEN NEW.active != 0
              AND NEW.desktop_frequency != 'manual'
               THEN 1
             ELSE 0
           END,

         next_due_at =
           CASE
             WHEN NEW.active != 0
              AND NEW.desktop_frequency != 'manual'
               THEN strftime(
                 '%Y-%m-%dT%H:%M:%fZ',
                 'now'
               )
             ELSE NULL
           END,

         updated_at =
           strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             'now'
           )

   WHERE site_id = NEW.id
     AND strategy = 'desktop';

END;
