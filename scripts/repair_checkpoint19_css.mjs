import fs from "node:fs";
import path from "node:path";
import process from "node:process";


/*
 * ================================================================
 * Checkpoint-19 CSS repair
 * ================================================================
 *
 * The Checkpoint-19 installer stopped because ".project-grid {"
 * appears twice in public/styles.css:
 *
 *   1. the normal/base project-grid rule
 *   2. the responsive @media project-grid rule
 *
 * This repair inserts the Queue workspace styles immediately before
 * the NORMAL base project-grid rule.
 *
 * It does NOT deploy.
 * It does NOT run a migration.
 * It does NOT access Cloudflare.
 * ================================================================
 */


const ROOT =
  process.cwd();


const cssPath =
  path.join(
    ROOT,
    "public",
    "styles.css"
  );


const appPath =
  path.join(
    ROOT,
    "public",
    "app.js"
  );


const indexPath =
  path.join(
    ROOT,
    "src",
    "index.ts"
  );


const controlPath =
  path.join(
    ROOT,
    "src",
    "control-plane.ts"
  );


const htmlPath =
  path.join(
    ROOT,
    "public",
    "index.html"
  );


const required = [
  cssPath,
  appPath,
  indexPath,
  controlPath,
  htmlPath
];


function fail(
  message
) {
  console.error();
  console.error(
    `ERROR: ${message}`
  );

  console.error();
  console.error(
    "Repair stopped safely."
  );

  console.error(
    "Nothing was deployed."
  );

  process.exit(
    1
  );
}


for (
  const file
  of required
) {
  if (
    !fs.existsSync(
      file
    )
  ) {
    fail(
      `Missing file: ${path.relative(
        ROOT,
        file
      )}`
    );
  }
}


/*
 * ================================================================
 * Validate that the interrupted installer reached the expected
 * point before we touch CSS.
 * ================================================================
 */

const app =
  fs.readFileSync(
    appPath,
    "utf8"
  );


const index =
  fs.readFileSync(
    indexPath,
    "utf8"
  );


const control =
  fs.readFileSync(
    controlPath,
    "utf8"
  );


const html =
  fs.readFileSync(
    htmlPath,
    "utf8"
  );


if (
  !app.includes(
    "CHECKPOINT-19: Queue workspace"
  )
) {
  fail(
    "The Queue workspace frontend was not found in public/app.js."
  );
}


if (
  !app.includes(
    "async function renderQueue()"
  )
) {
  fail(
    "renderQueue() was not found in public/app.js."
  );
}


if (
  !index.includes(
    '"/api/next/queue-workspace"'
  )
) {
  fail(
    "The Queue workspace API route was not found."
  );
}


if (
  !control.includes(
    "export async function getQueueWorkspace"
  )
) {
  fail(
    "getQueueWorkspace() was not found."
  );
}


if (
  !html.includes(
    'data-route="#queue"'
  )
) {
  fail(
    "The Queue sidebar item was not found."
  );
}


console.log(
  "PASS: Queue frontend was already applied"
);


console.log(
  "PASS: Queue API route was already applied"
);


console.log(
  "PASS: Queue backend aggregator was already applied"
);


console.log(
  "PASS: Queue sidebar item was already applied"
);


/*
 * ================================================================
 * Backup CSS
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


const backupDir =
  path.join(
    ROOT,
    "backups",
    `checkpoint19_css_${stamp}`
  );


fs.mkdirSync(
  path.join(
    backupDir,
    "public"
  ),
  {
    recursive:
      true
  }
);


fs.copyFileSync(
  cssPath,
  path.join(
    backupDir,
    "public",
    "styles.css"
  )
);


console.log(
  `Backup created: ${backupDir}`
);


/*
 * ================================================================
 * Queue CSS
 * ================================================================
 */

const QUEUE_CSS = String.raw`

/*
 * ================================================================
 * CHECKPOINT-19: Queue workspace
 * ================================================================
 */

.queue-summary-cards {
  margin-bottom: 24px;
}

.queue-section-head {
  align-items: flex-end;
}

.queue-head-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.queue-table-wrap {
  width: 100%;
}

.queue-table {
  min-width: 1080px;
}

.queue-table th:nth-child(1) {
  min-width: 245px;
}

.queue-table th:nth-child(6) {
  min-width: 170px;
}

.queue-table th:nth-child(7) {
  min-width: 255px;
}

.queue-row td {
  transition:
    background .12s ease;
}

.queue-row-running td {
  background:
    rgba(255, 250, 235, .24);
}

.queue-row-retrying td {
  background:
    rgba(255, 250, 235, .36);
}

.queue-row-failed td {
  background:
    rgba(254, 243, 242, .22);
}

.queue-site-cell {
  min-width: 0;
}

.queue-site-link,
.queue-project-link {
  text-decoration: none;
}

.queue-site-link {
  color: #1d2939;
}

.queue-site-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.queue-project-link {
  color: #667085;
}

.queue-project-link:hover {
  color: var(--accent);
}

.queue-device {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 760;
  white-space: nowrap;
}

.queue-device.mobile {
  color: #3448a9;
  background: #eef2ff;
  box-shadow:
    inset 0 0 0 1px
    rgba(63,91,217,.08);
}

.queue-device.desktop {
  color: #475467;
  background: #f2f4f7;
  box-shadow:
    inset 0 0 0 1px
    rgba(71,84,103,.06);
}

.queue-trigger {
  color: #344054;
  font-size: 12px;
  font-weight: 720;
}

.queue-attempt {
  display: inline-block;
  min-width: 32px;
  color: #344054;
  font-size: 12px;
  font-weight: 760;
  font-variant-numeric:
    tabular-nums;
}

.queue-time-cell {
  min-width: 170px;
}

.queue-time-main {
  color: #344054;
  font-size: 12px;
  font-weight: 720;
  white-space: nowrap;
}

.queue-time-sub {
  margin-top: 4px;
  color: #98a2b3;
  font-size: 10px;
  line-height: 1.4;
  white-space: nowrap;
}

.queue-error-cell {
  max-width: 360px;
}

.queue-error {
  min-width: 210px;
  max-width: 340px;
}

.queue-error-title {
  color: #475467;
  font-size: 11px;
  font-weight: 680;
  line-height: 1.4;
}

.queue-row-failed .queue-error-title {
  color: var(--bad);
}

.queue-row-retrying .queue-error-title {
  color: var(--warn);
}

.queue-error-class {
  margin-top: 4px;
  color: #98a2b3;
  font-size: 9px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.queue-error-details {
  margin-top: 6px;
}

.queue-error-details summary {
  width: fit-content;
  color: #667085;
  cursor: pointer;
  font-size: 10px;
  font-weight: 680;
  user-select: none;
}

.queue-error-details summary:hover {
  color: #344054;
}

.queue-error-details pre {
  max-width: 330px;
  max-height: 190px;
  margin: 7px 0 0;
  overflow: auto;
  padding: 8px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fafc;
  color: #475467;
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  font-size: 9px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.queue-empty {
  padding-top: 38px;
  padding-bottom: 38px;
}

@media (max-width: 760px) {
  .queue-section-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .queue-head-meta {
    justify-content: flex-start;
  }

  .queue-table {
    min-width: 1020px;
  }
}

`;


/*
 * ================================================================
 * Insert CSS exactly once
 * ================================================================
 */

let css =
  fs.readFileSync(
    cssPath,
    "utf8"
  );


const marker =
  "CHECKPOINT-19: Queue workspace";


if (
  css.includes(
    marker
  )
) {
  console.log(
    "SKIP: Queue workspace CSS already exists"
  );
} else {
  /*
   * Use the COMPLETE base rule instead of the generic
   * ".project-grid {" selector.
   *
   * This exact base rule is unique and does not match the responsive
   * @media rule.
   */
  const baseProjectGrid =
    ".project-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 16px; }";


  const occurrences =
    css.split(
      baseProjectGrid
    ).length -
    1;


  console.log(
    `Base project-grid anchor matches: ${occurrences}`
  );


  if (
    occurrences !==
    1
  ) {
    fail(
      `Expected exactly one base project-grid rule; found ${occurrences}.`
    );
  }


  css =
    css.replace(
      baseProjectGrid,
      QUEUE_CSS +
      baseProjectGrid
    );


  fs.writeFileSync(
    cssPath,
    css,
    "utf8"
  );


  console.log(
    "PASS: Queue workspace CSS inserted before base project grid"
  );
}


/*
 * ================================================================
 * Final CSS validation
 * ================================================================
 */

css =
  fs.readFileSync(
    cssPath,
    "utf8"
  );


const requiredCss = [
  ".queue-summary-cards",
  ".queue-table",
  ".queue-row-running",
  ".queue-row-retrying",
  ".queue-device.mobile",
  ".queue-device.desktop",
  ".queue-time-main",
  ".queue-error-details",
  ".queue-site-link",
  ".queue-project-link"
];


for (
  const selector
  of requiredCss
) {
  if (
    !css.includes(
      selector
    )
  ) {
    fail(
      `Required Queue style missing: ${selector}`
    );
  }
}


console.log(
  "PASS: Queue workspace CSS validation complete"
);


console.log();
console.log(
  "============================================================"
);


console.log(
  "CHECKPOINT-19 CSS REPAIR PASSED"
);


console.log(
  "============================================================"
);


console.log();
console.log(
  "The original installer can now resume."
);


console.log(
  `Backup: ${backupDir}`
);

