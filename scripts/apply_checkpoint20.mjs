import fs from "node:fs";
import path from "node:path";
import process from "node:process";


const ROOT =
  process.cwd();


const files = {
  package:
    "package.json",

  control:
    "src/control-plane.ts",

  index:
    "src/index.ts",

  app:
    "public/app.js",

  css:
    "public/styles.css",

  verify18:
    "scripts/verify-checkpoint-18.mjs",

  verify19:
    "scripts/verify-checkpoint-19.mjs",

  verify20:
    "scripts/verify-checkpoint-20.mjs"
};


function absolute(
  relative
) {
  return path.join(
    ROOT,
    relative
  );
}


function read(
  relative
) {
  return fs.readFileSync(
    absolute(
      relative
    ),
    "utf8"
  );
}


function write(
  relative,
  value
) {
  fs.writeFileSync(
    absolute(
      relative
    ),
    value,
    "utf8"
  );
}


function fail(
  message
) {
  console.error();
  console.error(
    `ERROR: ${message}`
  );
  console.error();
  console.error(
    "Checkpoint-20 installer stopped safely."
  );
  console.error(
    "No deployment or remote data mutation was performed."
  );

  process.exit(
    1
  );
}


for (
  const relative
  of Object.values(
    files
  )
) {
  if (
    !fs.existsSync(
      absolute(
        relative
      )
    )
  ) {
    fail(
      `Missing required file: ${relative}`
    );
  }
}


/*
 * ================================================================
 * Require locally-complete Checkpoints 18 + 19.
 * ================================================================
 */

const initialApp =
  read(
    files.app
  );


const initialControl =
  read(
    files.control
  );


if (
  !initialApp.includes(
    "CHECKPOINT-18: logical scan state + friendly provider errors"
  )
) {
  fail(
    "Checkpoint 18 frontend marker is missing."
  );
}


if (
  !initialApp.includes(
    "CHECKPOINT-19: Queue workspace"
  )
) {
  fail(
    "Checkpoint 19 Queue workspace marker is missing."
  );
}


if (
  !initialControl.includes(
    "export async function getQueueWorkspace"
  )
) {
  fail(
    "Checkpoint 19 backend Queue workspace is missing."
  );
}


console.log(
  "PASS: Checkpoint 18 prerequisite detected"
);


console.log(
  "PASS: Checkpoint 19 prerequisite detected"
);


/*
 * ================================================================
 * Backup
 * ================================================================
 */

const stamp =
  new Date()
    .toISOString()
    .replace(
      /[-:TZ.]/g,
      ""
    )
    .slice(
      0,
      14
    );


const backupRoot =
  path.join(
    ROOT,
    "backups",
    `checkpoint20_${stamp}`
  );


for (
  const relative
  of [
    files.package,
    files.control,
    files.index,
    files.app,
    files.css
  ]
) {
  const destination =
    path.join(
      backupRoot,
      relative
    );


  fs.mkdirSync(
    path.dirname(
      destination
    ),
    {
      recursive:
        true
    }
  );


  fs.copyFileSync(
    absolute(
      relative
    ),
    destination
  );
}


console.log(
  `Backup created: ${backupRoot}`
);


/*
 * ================================================================
 * Safe source helpers
 * ================================================================
 */

function insertBeforeUnique(
  relative,
  anchor,
  insertion,
  label,
  alreadyMarker
) {
  let source =
    read(
      relative
    );


  if (
    alreadyMarker &&
    source.includes(
      alreadyMarker
    )
  ) {
    console.log(
      `SKIP: ${label} already present`
    );

    return;
  }


  const first =
    source.indexOf(
      anchor
    );


  const second =
    first >= 0
      ? source.indexOf(
          anchor,
          first +
          anchor.length
        )
      : -1;


  if (
    first < 0
  ) {
    fail(
      `${label}: insertion anchor not found in ${relative}`
    );
  }


  if (
    second >= 0
  ) {
    fail(
      `${label}: insertion anchor is ambiguous in ${relative}`
    );
  }


  source =
    source.slice(
      0,
      first
    ) +
    insertion +
    source.slice(
      first
    );


  write(
    relative,
    source
  );


  console.log(
    `OK: ${label}`
  );
}


function replaceOne(
  relative,
  oldValue,
  newValue,
  label,
  alreadyMarker
) {
  let source =
    read(
      relative
    );


  if (
    alreadyMarker &&
    source.includes(
      alreadyMarker
    )
  ) {
    console.log(
      `SKIP: ${label} already present`
    );

    return;
  }


  const first =
    source.indexOf(
      oldValue
    );


  const second =
    first >= 0
      ? source.indexOf(
          oldValue,
          first +
          oldValue.length
        )
      : -1;


  if (
    first < 0
  ) {
    fail(
      `${label}: source anchor not found in ${relative}`
    );
  }


  if (
    second >= 0
  ) {
    fail(
      `${label}: source anchor appears more than once in ${relative}`
    );
  }


  source =
    source.slice(
      0,
      first
    ) +
    newValue +
    source.slice(
      first +
      oldValue.length
    );


  write(
    relative,
    source
  );


  console.log(
    `OK: ${label}`
  );
}


/*
 * ================================================================
 * 1. control-plane.ts
 * ================================================================
 */

const controlSnippet =
  fs.readFileSync(
    absolute(
      ".checkpoint20/control-plane-snippet.ts"
    ),
    "utf8"
  );


insertBeforeUnique(
  files.control,

  "export async function listScanTargets(",

  controlSnippet,

  "add last-two logical site scan query",

  "export async function listRecentSiteScanJobs"
);


/*
 * ================================================================
 * 2. index.ts import
 * ================================================================
 */

replaceOne(
  files.index,

  "  getQueueWorkspace,\n",

  "  getQueueWorkspace,\n  listRecentSiteScanJobs,\n",

  "import listRecentSiteScanJobs",

  "  listRecentSiteScanJobs,\n"
);


/*
 * ================================================================
 * 3. index.ts route
 * ================================================================
 */

const indexRouteSnippet =
  fs.readFileSync(
    absolute(
      ".checkpoint20/index-route-snippet.ts"
    ),
    "utf8"
  );


insertBeforeUnique(
  files.index,

  "  match = path.match(/^\\/api\\/sites\\/(\\d+)\\/history$/);",

  indexRouteSnippet,

  "add recent logical scan API route",

  "const recentSiteScansMatch"
);


/*
 * ================================================================
 * 4. public/app.js state
 * ================================================================
 */

insertBeforeUnique(
  files.app,

  "  /*\n   * CHECKPOINT-19 Queue workspace state.",

  `  /*
   * CHECKPOINT-20 site-level logical scan/report state.
   */
  siteRecentScans: [],
  siteDetailedReports: [],
  siteReportComparison: null,
  sitePanelError: null,
  sitePanelGeneration: 0,

`,

  "add site recent scan/report state",

  "sitePanelGeneration:"
);


/*
 * ================================================================
 * 5. Replace renderSite() so initial site load fetches history,
 *    logical scans, retained reports, and comparison.
 * ================================================================
 */

const oldRenderSite =
`async function renderSite(siteId) {
  loading();
  state.currentSiteId = siteId;
  const data = await api(\`/api/sites/\${siteId}\`);
  state.siteData = data;
  await loadHistory(siteId, false);
  drawSitePage();
}
`;


const newRenderSite =
`async function renderSite(siteId) {
  loading();


  state.currentSiteId =
    siteId;


  /*
   * Do not let data from the previously-open site remain visible if
   * this site has no scan/report history.
   */
  state.siteRecentScans =
    [];


  state.siteDetailedReports =
    [];


  state.siteReportComparison =
    null;


  state.sitePanelError =
    null;


  const data =
    await api(
      \`/api/sites/\${siteId}\`
    );


  state.siteData =
    data;


  await Promise.all([
    loadHistory(
      siteId,
      false
    ),

    loadSiteOperationalPanels(
      siteId,
      false
    )
  ]);


  drawSitePage();
}
`;


replaceOne(
  files.app,
  oldRenderSite,
  newRenderSite,
  "load logical scans/reports during site render",
  "Do not let data from the previously-open site remain visible"
);


/*
 * ================================================================
 * 6. Main site helper functions
 * ================================================================
 */

const appSnippet =
  fs.readFileSync(
    absolute(
      ".checkpoint20/app-snippet.js"
    ),
    "utf8"
  );


insertBeforeUnique(
  files.app,

  "function latestFor(strategyName) {",

  appSnippet,

  "add recent scans + detailed reports rendering helpers",

  "CHECKPOINT-20: site recent scans + detailed Lighthouse reports"
);


/*
 * ================================================================
 * 7. Insert the two new site sections directly before History.
 * ================================================================
 */

replaceOne(
  files.app,

  '    <section class="section"><div class="section-head"><h2>History</h2></div><div class="card chart-card">',

  `    \${renderRecentLogicalScansSection(site)}
    \${renderSiteDetailedReportsSection(site)}
    <section class="section"><div class="section-head"><h2>History</h2></div><div class="card chart-card">`,

  "render recent scans and detailed reports before History",

  '${renderRecentLogicalScansSection(site)}'
);


/*
 * ================================================================
 * 8. Mobile/Desktop tab switches reload all strategy-dependent data.
 * ================================================================
 */

const oldStrategyHandler =
`  $$('[data-strategy]').forEach(btn => btn.onclick = async () => { state.strategy = btn.dataset.strategy; state.metric = "performance_score"; await loadHistory(site.id, false); drawSitePage(); });
`;


const newStrategyHandler =
`  $$('[data-focus-report-panel]').forEach(
    (button) =>
      button.onclick =
        () => {
          $("#siteDetailedReports")
            ?.scrollIntoView({
              behavior:
                "smooth",

              block:
                "start"
            });
        }
  );


  $$('[data-strategy]').forEach(
    (btn) =>
      btn.onclick =
        async () => {
          state.strategy =
            btn.dataset.strategy;


          state.metric =
            "performance_score";


          await Promise.all([
            loadHistory(
              site.id,
              false
            ),

            loadSiteOperationalPanels(
              site.id,
              false
            )
          ]);


          drawSitePage();
        }
  );
`;


replaceOne(
  files.app,
  oldStrategyHandler,
  newStrategyHandler,
  "reload recent scans/reports on Mobile/Desktop switch",
  "data-focus-report-panel"
);


/*
 * ================================================================
 * 9. public/styles.css — append using a marker rather than a fragile
 *    selector anchor.
 * ================================================================
 */

let css =
  read(
    files.css
  );


const cssMarker =
  "CHECKPOINT-20: recent logical scans + detailed reports";


if (
  css.includes(
    cssMarker
  )
) {
  console.log(
    "SKIP: Checkpoint-20 CSS already present"
  );
} else {
  const cssSnippet =
    fs.readFileSync(
      absolute(
        ".checkpoint20/styles-snippet.css"
      ),
      "utf8"
    );


  css =
    css.trimEnd() +
    "\n" +
    cssSnippet +
    "\n";


  write(
    files.css,
    css
  );


  console.log(
    "OK: appended Checkpoint-20 site scan/report CSS"
  );
}


/*
 * ================================================================
 * 10. package.json
 * ================================================================
 */

const packagePath =
  absolute(
    files.package
  );


const packageJson =
  JSON.parse(
    fs.readFileSync(
      packagePath,
      "utf8"
    )
  );


const verifyCommand =
  "node scripts/verify-checkpoint-20.mjs";


const currentCheck =
  String(
    packageJson
      .scripts
      ?.check ||
    ""
  ).trim();


if (
  currentCheck.includes(
    verifyCommand
  )
) {
  console.log(
    "SKIP: Checkpoint-20 verifier already in npm run check"
  );
} else {
  packageJson.scripts =
    packageJson.scripts ||
    {};


  packageJson
    .scripts
    .check =
      currentCheck
        ? `${currentCheck} && ${verifyCommand}`
        : verifyCommand;


  fs.writeFileSync(
    packagePath,
    JSON.stringify(
      packageJson,
      null,
      2
    ) +
    "\n"
  );


  console.log(
    "OK: added Checkpoint-20 verifier to npm run check"
  );
}


/*
 * ================================================================
 * Final static source sanity checks before returning success.
 * ================================================================
 */

const finalControl =
  read(
    files.control
  );


const finalIndex =
  read(
    files.index
  );


const finalApp =
  read(
    files.app
  );


const finalCss =
  read(
    files.css
  );


const requiredMarkers = [
  [
    finalControl.includes(
      "export async function listRecentSiteScanJobs"
    ),
    "logical scan backend"
  ],

  [
    finalControl.includes(
      "FROM scan_jobs j"
    ),
    "scan_jobs source"
  ],

  [
    finalIndex.includes(
      "const recentSiteScansMatch"
    ),
    "recent scan API"
  ],

  [
    finalApp.includes(
      "renderRecentLogicalScansSection"
    ),
    "recent scan UI"
  ],

  [
    finalApp.includes(
      "renderSiteDetailedReportsSection"
    ),
    "detailed report UI"
  ],

  [
    finalApp.includes(
      "loadSiteOperationalPanels"
    ),
    "strategy-aware loader"
  ],

  [
    finalCss.includes(
      cssMarker
    ),
    "Checkpoint-20 CSS"
  ]
];


for (
  const [
    ok,
    label
  ]
  of requiredMarkers
) {
  if (!ok) {
    fail(
      `Final source sanity check failed: ${label}`
    );
  }
}


console.log();
console.log(
  "============================================================"
);

console.log(
  "CHECKPOINT-20 SOURCE PATCH COMPLETE"
);

console.log(
  "============================================================"
);

console.log();

console.log(
  "Implemented:"
);

console.log(
  "  - last two logical scan_jobs per selected strategy"
);

console.log(
  "  - provider retries collapsed into logical scan attempt count"
);

console.log(
  "  - direct retained Detailed JSON linkage"
);

console.log(
  "  - inline newest-two detailed report history"
);

console.log(
  "  - latest-vs-previous Lighthouse comparison"
);

console.log(
  "  - Mobile/Desktop strategy reloading"
);

console.log(
  "  - stale async strategy-response protection"
);

console.log(
  "  - partial API failure tolerance via Promise.allSettled"
);

console.log();

console.log(
  "No migration was created."
);

console.log(
  "No deployment was performed."
);

console.log(
  "No remote database data was modified."
);

console.log();

console.log(
  `Backup: ${backupRoot}`
);

