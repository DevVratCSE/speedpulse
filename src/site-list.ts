export interface NextSiteListInput {
  page?: number;
  pageSize?: number;
  q?: string;
  projectId?: number;
  active?: boolean;
}

export interface NextSiteRow {
  id: number;
  project_id: number;
  project_name: string;
  name: string;
  url: string;
  origin: string;
  active: number;

  mobile_enabled: number | null;
  mobile_schedule_type: string | null;
  mobile_schedule_config_json: string | null;
  mobile_timezone: string | null;
  mobile_next_due_at: string | null;
  mobile_last_success_at: string | null;
  mobile_last_failure_at: string | null;

  desktop_enabled: number | null;
  desktop_schedule_type: string | null;
  desktop_schedule_config_json: string | null;
  desktop_timezone: string | null;
  desktop_next_due_at: string | null;
  desktop_last_success_at: string | null;
  desktop_last_failure_at: string | null;
}

export interface NextProjectRow {
  id: number;
  name: string;
  site_count: number;
  active_site_count: number;
}

interface FilterParts {
  where: string;
  bindings: Array<
    string | number
  >;
}

function positiveInt(
  value: unknown,
  fallback: number,
  max: number
): number {
  const parsed =
    Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    return fallback;
  }

  return Math.min(
    parsed,
    max
  );
}

function buildFilters(
  input: NextSiteListInput
): FilterParts {
  const conditions: string[] = [
    "1=1"
  ];

  const bindings: Array<
    string | number
  > = [];

  const q =
    String(
      input.q || ""
    )
      .trim()
      .toLowerCase();

  if (q) {
    const pattern =
      `%${q}%`;

    conditions.push(
      `(
        LOWER(s.name) LIKE ?
        OR LOWER(s.url) LIKE ?
        OR LOWER(p.name) LIKE ?
      )`
    );

    bindings.push(
      pattern,
      pattern,
      pattern
    );
  }

  if (
    Number.isInteger(
      input.projectId
    ) &&
    Number(input.projectId) > 0
  ) {
    conditions.push(
      "s.project_id=?"
    );

    bindings.push(
      Number(
        input.projectId
      )
    );
  }

  if (
    typeof input.active ===
    "boolean"
  ) {
    conditions.push(
      "s.active=?"
    );

    bindings.push(
      input.active
        ? 1
        : 0
    );
  }

  return {
    where:
      conditions.join(
        " AND "
      ),
    bindings
  };
}

export async function listNextSites(
  db: D1Database,
  input: NextSiteListInput
): Promise<{
  sites: NextSiteRow[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}> {
  const page =
    positiveInt(
      input.page,
      1,
      100000
    );

  const pageSize =
    positiveInt(
      input.pageSize,
      50,
      100
    );

  const {
    where,
    bindings
  } = buildFilters(
    input
  );

  const count =
    await db.prepare(
      `SELECT
         COUNT(*) AS count
       FROM sites s
       JOIN projects p
         ON p.id=s.project_id
       WHERE ${where}`
    )
      .bind(
        ...bindings
      )
      .first<{
        count: number;
      }>();

  const total =
    Number(
      count?.count || 0
    );

  const pages =
    Math.max(
      1,
      Math.ceil(
        total / pageSize
      )
    );

  const safePage =
    Math.min(
      page,
      pages
    );

  const offset =
    (
      safePage - 1
    ) *
    pageSize;

  const result =
    await db.prepare(
      `SELECT
         s.id,
         s.project_id,
         p.name AS project_name,
         s.name,
         s.url,
         s.origin,
         s.active,

         mobile.enabled
           AS mobile_enabled,
         mobile.schedule_type
           AS mobile_schedule_type,
         mobile.schedule_config_json
           AS mobile_schedule_config_json,
         mobile.timezone
           AS mobile_timezone,
         mobile.next_due_at
           AS mobile_next_due_at,
         mobile.last_success_at
           AS mobile_last_success_at,
         mobile.last_failure_at
           AS mobile_last_failure_at,

         desktop.enabled
           AS desktop_enabled,
         desktop.schedule_type
           AS desktop_schedule_type,
         desktop.schedule_config_json
           AS desktop_schedule_config_json,
         desktop.timezone
           AS desktop_timezone,
         desktop.next_due_at
           AS desktop_next_due_at,
         desktop.last_success_at
           AS desktop_last_success_at,
         desktop.last_failure_at
           AS desktop_last_failure_at

       FROM sites s

       JOIN projects p
         ON p.id=s.project_id

       LEFT JOIN scan_targets mobile
         ON mobile.site_id=s.id
         AND mobile.strategy='mobile'

       LEFT JOIN scan_targets desktop
         ON desktop.site_id=s.id
         AND desktop.strategy='desktop'

       WHERE ${where}

       ORDER BY
         s.active DESC,
         LOWER(p.name),
         LOWER(s.name),
         s.id

       LIMIT ?
       OFFSET ?`
    )
      .bind(
        ...bindings,
        pageSize,
        offset
      )
      .all<NextSiteRow>();

  return {
    sites:
      result.results || [],
    pagination: {
      page: safePage,
      pageSize,
      total,
      pages,
      hasPrevious:
        safePage > 1,
      hasNext:
        safePage < pages
    }
  };
}

export async function listNextSiteIds(
  db: D1Database,
  input: NextSiteListInput
): Promise<{
  ids: number[];
  total: number;
  truncated: boolean;
}> {
  const {
    where,
    bindings
  } = buildFilters(
    input
  );

  const count =
    await db.prepare(
      `SELECT
         COUNT(*) AS count
       FROM sites s
       JOIN projects p
         ON p.id=s.project_id
       WHERE ${where}`
    )
      .bind(
        ...bindings
      )
      .first<{
        count: number;
      }>();

  const total =
    Number(
      count?.count || 0
    );

  /*
   * Bulk operations currently accept
   * at most 500 sites per request.
   */
  const result =
    await db.prepare(
      `SELECT
         s.id
       FROM sites s
       JOIN projects p
         ON p.id=s.project_id
       WHERE ${where}
       ORDER BY
         LOWER(p.name),
         LOWER(s.name),
         s.id
       LIMIT 500`
    )
      .bind(
        ...bindings
      )
      .all<{
        id: number;
      }>();

  return {
    ids:
      (
        result.results || []
      ).map(
        (row) =>
          Number(row.id)
      ),
    total,
    truncated:
      total > 500
  };
}

export async function listNextProjects(
  db: D1Database
): Promise<NextProjectRow[]> {
  const result =
    await db.prepare(
      `SELECT
         p.id,
         p.name,
         COUNT(s.id)
           AS site_count,
         SUM(
           CASE
             WHEN s.active != 0
               THEN 1
             ELSE 0
           END
         ) AS active_site_count

       FROM projects p

       LEFT JOIN sites s
         ON s.project_id=p.id

       GROUP BY
         p.id,
         p.name

       ORDER BY
         LOWER(p.name),
         p.id`
    )
      .all<NextProjectRow>();

  return result.results || [];
}
