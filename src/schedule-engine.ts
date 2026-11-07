import type { Strategy } from "./types";

export type ScheduleType =
  | "manual"
  | "interval"
  | "daily"
  | "weekly";

export type ScheduleConfig =
  | Record<string, never>
  | {
      minutes: number;
    }
  | {
      time: string;
    }
  | {
      days: number[];
      time: string;
    };

export interface NormalizedSchedule {
  type: ScheduleType;
  timezone: string;
  config: ScheduleConfig;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function assertTimezone(
  timezone: string
): string {
  const value =
    String(timezone || "UTC").trim() ||
    "UTC";

  try {
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: value
      }
    ).format(new Date());
  } catch {
    throw new Error(
      `Invalid timezone: ${value}`
    );
  }

  return value;
}

function parseTime(
  value: unknown
): {
  hour: number;
  minute: number;
} {
  if (
    typeof value !== "string" ||
    !/^\d{2}:\d{2}$/.test(value)
  ) {
    throw new Error(
      "time must use HH:MM format"
    );
  }

  const [hour, minute] =
    value.split(":").map(Number);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      "time must be a valid 24-hour HH:MM value"
    );
  }

  return {
    hour,
    minute
  };
}

function configObject(
  value: unknown
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as Record<
    string,
    unknown
  >;
}

function deterministicIntervalJitterMinutes(
  siteId: number,
  strategy: Strategy,
  intervalMinutes: number
): number {
  /*
   * Deterministic phase spreading:
   *
   * - max absolute spread: 30 minutes
   * - max spread: 10% of interval
   * - short intervals stay safe
   * - mobile and desktop for the same site are guaranteed different
   *   whenever spreading is enabled
   */
  const maximum =
    Math.min(
      30,
      Math.floor(
        intervalMinutes *
        0.10
      ),
      Math.floor(
        (
          intervalMinutes -
          1
        ) /
        2
      )
    );

  if (
    maximum < 1
  ) {
    return 0;
  }

  const text =
    String(
      siteId
    );

  let hash =
    2166136261;

  for (
    let index = 0;
    index < text.length;
    index++
  ) {
    hash ^=
      text.charCodeAt(
        index
      );

    hash =
      Math.imul(
        hash,
        16777619
      );
  }

  const width =
    maximum * 2 +
    1;

  const strategyOffset =
    strategy ===
    "desktop"
      ? maximum + 1
      : 0;

  return (
    (
      (
        hash >>> 0
      ) +
      strategyOffset
    ) %
    width
  ) - maximum;
}


export function normalizeSchedule(
  input: unknown
): NormalizedSchedule {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new Error(
      "Schedule must be an object"
    );
  }

  const value =
    input as Record<string, unknown>;

  const type =
    String(value.type || "") as
      ScheduleType;

  if (
    ![
      "manual",
      "interval",
      "daily",
      "weekly"
    ].includes(type)
  ) {
    throw new Error(
      "schedule type must be manual, interval, daily, or weekly"
    );
  }

  const timezone =
    assertTimezone(
      String(
        value.timezone || "UTC"
      )
    );

  const rawConfig =
    configObject(value.config);

  if (type === "manual") {
    return {
      type,
      timezone,
      config: {}
    };
  }

  if (type === "interval") {
    const minutes =
      Number(rawConfig.minutes);

    if (
      !Number.isInteger(minutes) ||
      minutes < 5 ||
      minutes > 525600
    ) {
      throw new Error(
        "interval minutes must be an integer between 5 and 525600"
      );
    }

    return {
      type,
      timezone,
      config: {
        minutes
      }
    };
  }

  if (type === "daily") {
    const parsed =
      parseTime(rawConfig.time);

    return {
      type,
      timezone,
      config: {
        time:
          `${String(parsed.hour).padStart(2, "0")}:` +
          `${String(parsed.minute).padStart(2, "0")}`
      }
    };
  }

  const rawDays =
    rawConfig.days;

  if (
    !Array.isArray(rawDays) ||
    rawDays.length === 0
  ) {
    throw new Error(
      "weekly schedule requires at least one day"
    );
  }

  const days = Array.from(
    new Set(
      rawDays.map(Number)
    )
  ).sort(
    (a, b) => a - b
  );

  if (
    days.some(
      (day) =>
        !Number.isInteger(day) ||
        day < 0 ||
        day > 6
    )
  ) {
    throw new Error(
      "weekly days must contain integers 0 through 6"
    );
  }

  const parsed =
    parseTime(rawConfig.time);

  return {
    type,
    timezone,
    config: {
      days,
      time:
        `${String(parsed.hour).padStart(2, "0")}:` +
        `${String(parsed.minute).padStart(2, "0")}`
    }
  };
}

function localParts(
  timestamp: number,
  timezone: string
): LocalParts {
  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }
    );

  const parts =
    formatter.formatToParts(
      new Date(timestamp)
    );

  const result:
    Record<string, number> = {};

  for (const part of parts) {
    if (
      [
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "second"
      ].includes(part.type)
    ) {
      result[part.type] =
        Number(part.value);
    }
  }

  return {
    year: result.year,
    month: result.month,
    day: result.day,
    hour: result.hour,
    minute: result.minute,
    second: result.second
  };
}

function addLocalDays(
  year: number,
  month: number,
  day: number,
  amount: number
): {
  year: number;
  month: number;
  day: number;
} {
  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day + amount
      )
    );

  return {
    year:
      date.getUTCFullYear(),
    month:
      date.getUTCMonth() + 1,
    day:
      date.getUTCDate()
  };
}

function localDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): number {
  const desired =
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      0,
      0
    );

  let guess = desired;

  /*
   * Iteratively solve:
   * local wall-clock time in timezone -> UTC.
   *
   * This also allows DST offsets to change
   * without storing fixed UTC offsets.
   */
  for (
    let i = 0;
    i < 4;
    i++
  ) {
    const observed =
      localParts(
        guess,
        timezone
      );

    const observedAsUtc =
      Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
        0
      );

    const difference =
      desired -
      observedAsUtc;

    if (
      Math.abs(difference) <
      1000
    ) {
      break;
    }

    guess += difference;
  }

  return guess;
}

export function computeNextScheduleAt(
  schedule: NormalizedSchedule,
  afterIso: string,
  siteId?: number,
  strategy?: Strategy
): string | null {
  const after =
    Date.parse(afterIso);

  if (!Number.isFinite(after)) {
    throw new Error(
      "Invalid schedule reference timestamp"
    );
  }

  if (
    schedule.type === "manual"
  ) {
    return null;
  }

  if (
    schedule.type === "interval"
  ) {
    const config =
      schedule.config as {
        minutes: number;
      };

    const jitterMinutes =
      (
        Number.isInteger(
          siteId
        ) &&
        siteId! > 0 &&
        (
          strategy ===
            "mobile" ||
          strategy ===
            "desktop"
        )
      )
        ? deterministicIntervalJitterMinutes(
            siteId!,
            strategy!,
            config.minutes
          )
        : 0;

    return new Date(
      after +
      (
        config.minutes +
        jitterMinutes
      ) *
        60 *
        1000
    ).toISOString();
  }

  const current =
    localParts(
      after,
      schedule.timezone
    );

  const timeConfig =
    schedule.config as {
      time: string;
    };

  const {
    hour,
    minute
  } = parseTime(
    timeConfig.time
  );

  if (
    schedule.type === "daily"
  ) {
    for (
      let offset = 0;
      offset <= 2;
      offset++
    ) {
      const date =
        addLocalDays(
          current.year,
          current.month,
          current.day,
          offset
        );

      const candidate =
        localDateToUtc(
          date.year,
          date.month,
          date.day,
          hour,
          minute,
          schedule.timezone
        );

      if (candidate > after) {
        return new Date(
          candidate
        ).toISOString();
      }
    }

    throw new Error(
      "Unable to calculate next daily schedule"
    );
  }

  const weekly =
    schedule.config as {
      days: number[];
      time: string;
    };

  for (
    let offset = 0;
    offset <= 7;
    offset++
  ) {
    const date =
      addLocalDays(
        current.year,
        current.month,
        current.day,
        offset
      );

    const weekday =
      new Date(
        Date.UTC(
          date.year,
          date.month - 1,
          date.day
        )
      ).getUTCDay();

    if (
      !weekly.days.includes(
        weekday
      )
    ) {
      continue;
    }

    const candidate =
      localDateToUtc(
        date.year,
        date.month,
        date.day,
        hour,
        minute,
        schedule.timezone
      );

    if (candidate > after) {
      return new Date(
        candidate
      ).toISOString();
    }
  }

  throw new Error(
    "Unable to calculate next weekly schedule"
  );
}

export function scheduleIntervalHours(
  schedule: NormalizedSchedule
): number {
  if (
    schedule.type === "interval"
  ) {
    const config =
      schedule.config as {
        minutes: number;
      };

    return Math.max(
      1,
      Math.round(
        config.minutes / 60
      )
    );
  }

  if (
    schedule.type === "daily"
  ) {
    return 24;
  }

  if (
    schedule.type === "weekly"
  ) {
    return 168;
  }

  return 72;
}
