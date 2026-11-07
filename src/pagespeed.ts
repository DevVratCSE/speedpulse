import type {
  CruxFetchResult,
  CruxResult,
  DetailedReportDetailLevel,
  PageSpeedFetchResult,
  Strategy
} from "./types";

import {
  datePartsToIso,
  roundMetric
} from "./utils";


const PSI_ENDPOINT =
  "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";

const CRUX_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";


const COMPACT_REPORT_TARGET_BYTES =
  380 * 1024;


const PRIORITY_DETAIL_AUDITS =
  new Set([
    "diagnostics",
    "network-requests",
    "resource-summary",
    "mainthread-work-breakdown",
    "bootup-time",
    "third-party-summary",
    "long-tasks",
    "dom-size",
    "layout-shifts",
    "largest-contentful-paint-element",
    "lcp-lazy-loaded",
    "render-blocking-resources",
    "render-blocking-insight",
    "unused-css-rules",
    "unused-javascript",
    "uses-long-cache-ttl",
    "uses-text-compression",
    "offscreen-images",
    "modern-image-formats",
    "uses-optimized-images",
    "uses-responsive-images",
    "efficient-animated-content"
  ]);


async function fetchWithTimeout(
  input:
    | RequestInfo
    | URL,

  init: RequestInit,

  timeoutMs: number
): Promise<Response> {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      input,
      {
        ...init,

        signal:
          controller.signal
      }
    );
  } finally {
    clearTimeout(
      timer
    );
  }
}


function score(
  value: unknown
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n =
    typeof value ===
    "number"
      ? value
      : Number(
          value
        );

  return Number.isFinite(
    n
  )
    ? Math.round(
        n *
        100
      )
    : null;
}


function auditNumber(
  audits: any,
  id: string,
  digits = 0
): number | null {
  return roundMetric(
    audits?.[
      id
    ]?.numericValue,
    digits
  );
}


function truncateText(
  value: unknown,
  maximum = 600
): string {
  return String(
    value ??
    ""
  ).slice(
    0,
    maximum
  );
}


const LARGE_DETAIL_KEYS =
  new Set([
    "data",
    "dataUri",
    "imageData",
    "screenshot",
    "screenshots",
    "fullPageScreenshot",
    "trace"
  ]);


function compactValue(
  value: unknown,
  depth = 0
): unknown {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }


  if (
    typeof value ===
    "string"
  ) {
    return truncateText(
      value,
      500
    );
  }


  if (
    typeof value ===
      "number" ||
    typeof value ===
      "boolean"
  ) {
    return value;
  }


  if (
    depth >= 3
  ) {
    return null;
  }


  if (
    Array.isArray(
      value
    )
  ) {
    return value
      .slice(
        0,
        8
      )
      .map(
        (item) =>
          compactValue(
            item,
            depth + 1
          )
      );
  }


  if (
    typeof value ===
    "object"
  ) {
    const result:
      Record<
        string,
        unknown
      > = {};

    let included = 0;


    for (
      const [
        key,
        nested
      ] of Object.entries(
        value as
          Record<
            string,
            unknown
          >
      )
    ) {
      if (
        LARGE_DETAIL_KEYS.has(
          key
        )
      ) {
        continue;
      }


      if (
        included >=
        20
      ) {
        break;
      }


      result[
        key
      ] =
        compactValue(
          nested,
          depth + 1
        );

      included++;
    }


    return result;
  }


  return null;
}


function shouldKeepDetails(
  id: string,
  details: any
): boolean {
  if (!details) {
    return false;
  }


  if (
    details.type ===
    "opportunity"
  ) {
    return true;
  }


  if (
    PRIORITY_DETAIL_AUDITS.has(
      id
    )
  ) {
    return true;
  }


  return id.includes(
    "insight"
  );
}


function compactDetails(
  details: any
): Record<
  string,
  unknown
> | null {
  if (
    !details ||
    typeof details !==
      "object"
  ) {
    return null;
  }


  const result:
    Record<
      string,
      unknown
    > = {
      type:
        details.type ||
        null
    };


  for (
    const key of [
      "overallSavingsMs",
      "overallSavingsBytes"
    ]
  ) {
    if (
      details[
        key
      ] !== undefined
    ) {
      result[
        key
      ] =
        compactValue(
          details[
            key
          ]
        );
    }
  }


  if (
    Array.isArray(
      details.headings
    )
  ) {
    result.headings =
      details.headings
        .slice(
          0,
          12
        )
        .map(
          (
            item: unknown
          ) =>
            compactValue(
              item
            )
        );
  }


  if (
    Array.isArray(
      details.items
    )
  ) {
    result.items =
      details.items
        .slice(
          0,
          8
        )
        .map(
          (
            item: unknown
          ) =>
            compactValue(
              item
            )
        );
  }


  return result;
}


function compactAudit(
  id: string,
  audit: any,
  includeDetails: boolean
): Record<
  string,
  unknown
> {
  const result:
    Record<
      string,
      unknown
    > = {
      id,

      title:
        truncateText(
          audit?.title,
          300
        ),

      description:
        truncateText(
          audit?.description,
          600
        ),

      score:
        audit?.score ??
        null,

      scoreDisplayMode:
        audit?.scoreDisplayMode ??
        null,

      displayValue:
        audit?.displayValue
          ? truncateText(
              audit.displayValue,
              300
            )
          : null,

      numericValue:
        audit?.numericValue ??
        null,

      numericUnit:
        audit?.numericUnit ??
        null
    };


  if (
    Array.isArray(
      audit?.warnings
    ) &&
    audit.warnings.length >
      0
  ) {
    result.warnings =
      audit.warnings
        .slice(
          0,
          8
        )
        .map(
          (
            warning: unknown
          ) =>
            truncateText(
              warning,
              500
            )
        );
  }


  if (
    includeDetails &&
    shouldKeepDetails(
      id,
      audit?.details
    )
  ) {
    result.details =
      compactDetails(
        audit.details
      );
  }


  return result;
}


function compactCategories(
  categories: any
) {
  const result:
    Record<
      string,
      unknown
    > = {};


  for (
    const [
      id,
      category
    ] of Object.entries(
      categories ||
      {}
    )
  ) {
    const value =
      category as any;


    result[
      id
    ] = {
      id:
        value?.id ||
        id,

      title:
        truncateText(
          value?.title,
          200
        ),

      description:
        truncateText(
          value?.description,
          500
        ),

      score:
        value?.score ??
        null,

      auditRefs:
        Array.isArray(
          value?.auditRefs
        )
          ? value.auditRefs
              .slice(
                0,
                250
              )
              .map(
                (
                  reference: any
                ) => ({
                  id:
                    reference?.id ||
                    null,

                  weight:
                    reference?.weight ??
                    null,

                  group:
                    reference?.group ||
                    null
                })
              )
          : []
    };
  }


  return result;
}


function opportunitySummaries(
  audits: any
) {
  const result:
    Array<
      Record<
        string,
        unknown
      >
    > = [];


  for (
    const [
      id,
      audit
    ] of Object.entries(
      audits ||
      {}
    )
  ) {
    const value =
      audit as any;

    const details =
      value?.details;

    const savingsMs =
      Number(
        details
          ?.overallSavingsMs ||
        0
      );

    const savingsBytes =
      Number(
        details
          ?.overallSavingsBytes ||
        0
      );


    if (
      details?.type !==
        "opportunity" &&
      savingsMs <= 0 &&
      savingsBytes <= 0
    ) {
      continue;
    }


    result.push({
      id,

      title:
        truncateText(
          value?.title,
          300
        ),

      displayValue:
        value?.displayValue
          ? truncateText(
              value.displayValue,
              300
            )
          : null,

      score:
        value?.score ??
        null,

      savingsMs:
        Number.isFinite(
          savingsMs
        )
          ? savingsMs
          : 0,

      savingsBytes:
        Number.isFinite(
          savingsBytes
        )
          ? savingsBytes
          : 0
    });


    if (
      result.length >=
      50
    ) {
      break;
    }
  }


  return result;
}


function buildPayloadObject(
  data: any,
  includeDetails: boolean,
  detailLevel:
    DetailedReportDetailLevel
) {
  const lighthouse =
    data?.lighthouseResult ||
    {};

  const audits =
    lighthouse.audits ||
    {};

  const compactAudits:
    Record<
      string,
      unknown
    > = {};


  for (
    const [
      id,
      audit
    ] of Object.entries(
      audits
    )
  ) {
    compactAudits[
      id
    ] =
      compactAudit(
        id,
        audit,
        includeDetails
      );
  }


  return {
    schemaVersion:
      1,

    kind:
      "speedpulse-lighthouse-compact",

    detailLevel,

    analysisUTCTimestamp:
      data
        ?.analysisUTCTimestamp ||
      lighthouse
        ?.fetchTime ||
      null,

    requestedUrl:
      lighthouse
        ?.requestedUrl ||
      null,

    finalUrl:
      lighthouse
        ?.finalUrl ||
      null,

    fetchTime:
      lighthouse
        ?.fetchTime ||
      null,

    lighthouseVersion:
      lighthouse
        ?.lighthouseVersion ||
      null,

    userAgent:
      lighthouse
        ?.userAgent
        ? truncateText(
            lighthouse.userAgent,
            500
          )
        : null,

    categories:
      compactCategories(
        lighthouse
          ?.categories
      ),

    audits:
      compactAudits,

    opportunities:
      opportunitySummaries(
        audits
      ),

    environment: {
      benchmarkIndex:
        lighthouse
          ?.environment
          ?.benchmarkIndex ??
        null,

      hostUserAgent:
        lighthouse
          ?.environment
          ?.hostUserAgent
          ? truncateText(
              lighthouse.environment.hostUserAgent,
              500
            )
          : null,

      networkUserAgent:
        lighthouse
          ?.environment
          ?.networkUserAgent
          ? truncateText(
              lighthouse.environment.networkUserAgent,
              500
            )
          : null
    },

    configSettings: {
      emulatedFormFactor:
        lighthouse
          ?.configSettings
          ?.emulatedFormFactor ||
        null,

      formFactor:
        lighthouse
          ?.configSettings
          ?.formFactor ||
        null,

      throttlingMethod:
        lighthouse
          ?.configSettings
          ?.throttlingMethod ||
        null,

      locale:
        lighthouse
          ?.configSettings
          ?.locale ||
        null
    },

    runWarnings:
      Array.isArray(
        lighthouse
          ?.runWarnings
      )
        ? lighthouse.runWarnings
            .slice(
              0,
              20
            )
            .map(
              (
                warning: unknown
              ) =>
                truncateText(
                  warning,
                  600
                )
            )
        : []
  };
}


function encodedBytes(
  value: string
): number {
  return new TextEncoder()
    .encode(
      value
    )
    .byteLength;
}


function buildDetailedReportPayload(
  data: any
): {
  json: string;
  bytes: number;
  detailLevel:
    DetailedReportDetailLevel;
} {
  let detailLevel:
    DetailedReportDetailLevel =
      "compact";


  let json =
    JSON.stringify(
      buildPayloadObject(
        data,
        true,
        detailLevel
      )
    );


  let bytes =
    encodedBytes(
      json
    );


  /*
   * If the diagnostic tables are unusually large, fall back to
   * audit summaries instead of risking KV/storage growth.
   */
  if (
    bytes >
    COMPACT_REPORT_TARGET_BYTES
  ) {
    detailLevel =
      "summary";


    json =
      JSON.stringify(
        buildPayloadObject(
          data,
          false,
          detailLevel
        )
      );


    bytes =
      encodedBytes(
        json
      );
  }


  return {
    json,
    bytes,
    detailLevel
  };
}


function emptyCrux():
  CruxResult {
  return {
    available: false,
    source: null,
    lcpMs: null,
    inpMs: null,
    cls: null,
    periodStart: null,
    periodEnd: null
  };
}


export const PSI_REQUESTED_AUDITS = [
  // Core metrics
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
  "interactive",
  "server-response-time",
  "max-potential-fid",
  // Priority diagnostics & tables
  "diagnostics",
  "network-requests",
  "resource-summary",
  "mainthread-work-breakdown",
  "bootup-time",
  "third-party-summary",
  "long-tasks",
  "dom-size",
  "layout-shifts",
  "largest-contentful-paint-element",
  "lcp-lazy-loaded",
  "render-blocking-resources",
  "render-blocking-insight",
  "unused-css-rules",
  "unused-javascript",
  "uses-long-cache-ttl",
  "uses-text-compression",
  "offscreen-images",
  "modern-image-formats",
  "uses-optimized-images",
  "uses-responsive-images",
  "efficient-animated-content",
  // Common opportunities
  "unminified-css",
  "unminified-javascript",
  "redirects",
  "uses-rel-preload",
  "uses-rel-preconnect",
  "critical-request-chains",
  "duplicated-javascript",
  "font-display"
];

export function buildPageSpeedFieldsParam(): string {
  const auditsList = PSI_REQUESTED_AUDITS.join(",");
  return [
    "analysisUTCTimestamp",
    "loadingExperience",
    "originLoadingExperience",
    `lighthouseResult(fetchTime,finalUrl,requestedUrl,lighthouseVersion,userAgent,environment,configSettings,runtimeError,categories,audits(${auditsList}))`
  ].join(",");
}

export function parsePageSpeedResponse(
  data: any,
  url: string
): PageSpeedFetchResult {
  const lighthouse =
    data?.lighthouseResult;


  if (!lighthouse) {
    throw new Error(
      "PageSpeed response did not include Lighthouse data"
    );
  }


  const runtimeCode =
    String(
      lighthouse
        .runtimeError
        ?.code ||
      ""
    );


  const runtimeMessage =
    String(
      lighthouse
        .runtimeError
        ?.message ||
      ""
    );


  if (
    (
      runtimeCode &&
      runtimeCode !==
        "NO_ERROR"
    ) ||
    runtimeMessage
  ) {
    throw new Error(
      `Lighthouse runtime error ${runtimeCode || "UNKNOWN_ERROR"}: ${runtimeMessage || "No details provided"}`
    );
  }


  const categories =
    lighthouse.categories ||
    {};


  const audits =
    lighthouse.audits ||
    {};


  const detailed =
    buildDetailedReportPayload(
      data
    );


  return {
    summary: {
      analysisTime:
        data.analysisUTCTimestamp ||
        lighthouse.fetchTime ||
        new Date()
          .toISOString(),

      finalUrl:
        lighthouse.finalUrl ||
        url,

      lighthouseVersion:
        lighthouse
          .lighthouseVersion ||
        null,

      fetchTime:
        lighthouse.fetchTime ||
        null,

      performance:
        score(
          categories
            .performance
            ?.score
        ),

      accessibility:
        score(
          categories
            .accessibility
            ?.score
        ),

      seo:
        score(
          categories
            .seo
            ?.score
        ),

      bestPractices:
        score(
          categories[
            "best-practices"
          ]?.score
        ),

      fcpMs:
        auditNumber(
          audits,
          "first-contentful-paint"
        ),

      lcpMs:
        auditNumber(
          audits,
          "largest-contentful-paint"
        ),

      tbtMs:
        auditNumber(
          audits,
          "total-blocking-time"
        ),

      cls:
        auditNumber(
          audits,
          "cumulative-layout-shift",
          3
        ),

      speedIndexMs:
        auditNumber(
          audits,
          "speed-index"
        )
    },

    detailedReportJson:
      detailed.json,

    detailedReportBytes:
      detailed.bytes,

    detailedReportLevel:
      detailed.detailLevel
  };
}

export async function fetchPageSpeed(
  url: string,
  strategy: Strategy,
  apiKey: string
): Promise<PageSpeedFetchResult> {
  const endpoint =
    new URL(
      PSI_ENDPOINT
    );


  endpoint.searchParams.set(
    "url",
    url
  );

  endpoint.searchParams.set(
    "strategy",
    strategy
  );

  endpoint.searchParams.set(
    "key",
    apiKey
  );


  for (
    const category of [
      "performance",
      "accessibility",
      "seo",
      "best-practices"
    ]
  ) {
    endpoint.searchParams.append(
      "category",
      category
    );
  }


  endpoint.searchParams.set(
    "prettyPrint",
    "false"
  );

  endpoint.searchParams.set(
    "fields",
    buildPageSpeedFieldsParam()
  );


  const response =
    await fetchWithTimeout(
      endpoint.toString(),
      {
        headers: {
          accept:
            "application/json"
        }
      },
      60000
    );


  if (!response.ok) {
    const body =
      (
        await response.text()
      ).slice(
        0,
        700
      );


    throw new Error(
      `PageSpeed API ${response.status}: ${body || response.statusText}`
    );
  }


  let data: any;


  try {
    data =
      await response.json();
  } catch {
    throw new Error(
      "PageSpeed API returned invalid JSON"
    );
  }


  return parsePageSpeedResponse(
    data,
    url
  );
}


export async function fetchCrux(
  origin: string,
  strategy: Strategy,
  apiKey: string
): Promise<CruxFetchResult> {
  const endpoint =
    `${CRUX_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;


  const response =
    await fetchWithTimeout(
      endpoint,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json",

          accept:
            "application/json"
        },

        body:
          JSON.stringify({
            origin,

            formFactor:
              strategy ===
              "mobile"
                ? "PHONE"
                : "DESKTOP",

            metrics: [
              "largest_contentful_paint",
              "interaction_to_next_paint",
              "cumulative_layout_shift"
            ]
          })
      },
      15000
    );


  if (
    response.status ===
    404
  ) {
    response.body
      ?.cancel();


    return {
      summary:
        emptyCrux(),

      providerStatus:
        "no_record",

      httpStatus:
        404,

      error:
        null
    };
  }


  if (!response.ok) {
    const errorText =
      (
        (
          await response.text()
        ) ||
        response.statusText
      ).slice(
        0,
        700
      );


    console.warn(
      `CrUX API ${response.status}: ${errorText}`
    );


    return {
      summary:
        emptyCrux(),

      providerStatus:
        "provider_error",

      httpStatus:
        response.status,

      error:
        `CrUX API ${response.status}: ${errorText}`
    };
  }


  let data: any;


  try {
    data =
      await response.json();
  } catch {
    return {
      summary:
        emptyCrux(),

      providerStatus:
        "provider_error",

      httpStatus:
        response.status,

      error:
        "CrUX API returned invalid JSON"
    };
  }


  const record =
    data?.record;


  const metrics =
    record?.metrics ||
    {};


  const period =
    record?.collectionPeriod;


  const lcp =
    roundMetric(
      metrics
        .largest_contentful_paint
        ?.percentiles
        ?.p75
    );


  const inp =
    roundMetric(
      metrics
        .interaction_to_next_paint
        ?.percentiles
        ?.p75
    );


  const cls =
    roundMetric(
      metrics
        .cumulative_layout_shift
        ?.percentiles
        ?.p75,
      3
    );


  const available =
    lcp !== null ||
    inp !== null ||
    cls !== null;


  return {
    providerStatus:
      available
        ? "available"
        : "no_record",

    httpStatus:
      response.status,

    error:
      null,

    summary: {
      available,

      source:
        available
          ? "crux-origin"
          : null,

      lcpMs:
        lcp,

      inpMs:
        inp,

      cls,

      periodStart:
        datePartsToIso(
          period?.firstDate
        ),

      periodEnd:
        datePartsToIso(
          period?.lastDate
        )
    }
  };
}
