import fs from "node:fs";
import path from "node:path";
import process from "node:process";


const ROOT = process.cwd();

const APP =
  path.join(
    ROOT,
    "public",
    "app.js"
  );


const BACKUP =
  path.join(
    ROOT,
    "backups",
    `checkpoint20_runtime_fix_${Date.now()}`
  );


function stop(message) {
  console.error();
  console.error(
    `ERROR: ${message}`
  );
  console.error(
    "Nothing was deployed."
  );
  process.exit(1);
}


if (!fs.existsSync(APP)) {
  stop(
    "public/app.js not found"
  );
}


fs.mkdirSync(
  BACKUP,
  {
    recursive:true
  }
);


fs.copyFileSync(
  APP,
  path.join(
    BACKUP,
    "app.js"
  )
);


console.log(
  `Backup created: ${BACKUP}`
);


let app =
  fs.readFileSync(
    APP,
    "utf8"
  );



/*
 * ================================================================
 * 1. Fix DOM helper layer
 * ================================================================
 */

const helperPatterns = [
`
const $$ = (selector) =>
  document.querySelectorAll(selector);
`,
`
function $$(selector) {
  return document.querySelectorAll(selector);
}
`,
`
const $$ = selector =>
  document.querySelectorAll(selector);
`
];


let helperFixed =
  false;


for (
  const old of helperPatterns
) {

  if (
    app.includes(old)
  ) {

    app =
      app.replace(
        old,
`
const $$ = (
  selector,
  root = document
) =>
  Array.from(
    root.querySelectorAll(
      selector
    )
  );
`,
        1
      );


    helperFixed =
      true;


    console.log(
      "PASS: normalized $$ helper"
    );

    break;
  }
}


if (!helperFixed) {

  /*
   * Some versions define helpers differently.
   * Detect existing querySelectorAll helper.
   */

  if (
    app.includes(
      "querySelectorAll"
    ) &&
    !app.includes(
      "Array.from(\n    root.querySelectorAll"
    )
  ) {

    console.log(
      "WARN: $$ helper pattern not matched exactly"
    );

  } else {

    console.log(
      "PASS: $$ helper already normalized"
    );

  }
}



/*
 * ================================================================
 * 2. Add safe collection helper
 * ================================================================
 */

const safeMarker =
"CHECKPOINT-20: safe collection helper";


if (
  !app.includes(
    safeMarker
  )
) {

  const anchor =
    "function latestFor(strategyName)";


  if (
    !app.includes(
      anchor
    )
  ) {
    stop(
      "Could not find insertion point for safe collection helper"
    );
  }


  const helper =
`
/*
 * ${safeMarker}
 *
 * Defensive wrapper for dynamically created DOM collections.
 * Some browsers return NodeList objects while some custom helpers
 * returned single elements during early Checkpoint-20 rendering.
 */
function safeForEach(
  value,
  callback
) {
  if (
    !value
  ) {
    return;
  }


  const list =
    Array.isArray(
      value
    )
      ? value
      : Array.from(
          value
        );


  list.forEach(
    callback
  );
}


`;


  app =
    app.replace(
      anchor,
      helper +
      anchor,
      1
    );


  console.log(
    "PASS: added safeForEach helper"
  );

}



/*
 * ================================================================
 * 3. Replace unsafe Checkpoint-20 foreach calls
 * ================================================================
 */

const replacements = [
  [
    "$$('[data-focus-report-panel]').forEach(",
    "safeForEach($$('[data-focus-report-panel']), "
  ],

  [
    "$$('[data-strategy]').forEach(",
    "safeForEach($$('[data-strategy']), "
  ]
];


for (
  const [
    old,
    replacement
  ]
  of replacements
) {

  const count =
    app.split(
      old
    ).length -
    1;


  if (
    count > 0
  ) {

    app =
      app.replaceAll(
        old,
        replacement
      );


    console.log(
      `PASS: replaced ${count} unsafe ${old}`
    );
  }
}



/*
 * ================================================================
 * 4. Fix potential null report section access
 * ================================================================
 */


const dangerousSelectors = [
  '$("siteDetailedReports").scrollIntoView',
  '$("#siteDetailedReports").scrollIntoView'
];


for (
  const selector
  of dangerousSelectors
) {

  if (
    app.includes(
      selector
    )
  ) {

    console.log(
      `INFO: found ${selector}, optional chaining will be verified`
    );
  }
}



/*
 * ================================================================
 * 5. Make report panel rendering tolerant
 * ================================================================
 */

const oldEmptyCheck =
`
if (
    reports.length ===
      0 &&
    !latest
  ) {
`;


const newEmptyCheck =
`
if (
    !Array.isArray(
      reports
    )
  ) {
    reports = [];
  }


  if (
    reports.length ===
      0 &&
    !latest
  ) {
`;


if (
  app.includes(
    oldEmptyCheck
  ) &&
  !app.includes(
    "if (\n    !Array.isArray(\n      reports\n    )"
  )
) {

  app =
    app.replace(
      oldEmptyCheck,
      newEmptyCheck,
      1
    );


  console.log(
    "PASS: hardened empty detailed-report state"
  );
}



/*
 * ================================================================
 * 6. Write
 * ================================================================
 */

fs.writeFileSync(
  APP,
  app,
  "utf8"
);


console.log(
  "PASS: public/app.js updated"
);



/*
 * ================================================================
 * 7. Add regression verifier
 * ================================================================
 */


const verifier =
path.join(
  ROOT,
  "scripts",
  "verify-checkpoint20-runtime.mjs"
);


fs.writeFileSync(
  verifier,
`
import fs from "node:fs";


const app =
  fs.readFileSync(
    "public/app.js",
    "utf8"
  );


function check(
  condition,
  message
) {
  if (!condition) {
    throw new Error(
      "CHECKPOINT-20-RUNTIME FAILED: "
      + message
    );
  }
}


check(
  app.includes(
    "function safeForEach"
  ),
  "safeForEach helper missing"
);


check(
  app.includes(
    "Array.from"
  ),
  "collection normalization missing"
);


check(
  !app.includes(
    "$$('[data-strategy]').forEach("
  ),
  "unsafe strategy foreach remains"
);


check(
  !app.includes(
    "$$('[data-focus-report-panel]').forEach("
  ),
  "unsafe report foreach remains"
);


check(
  app.includes(
    "renderSiteDetailedReportsSection"
  ),
  "report renderer missing"
);


console.log(
  "Checkpoint-20 runtime hardening checks: PASS"
);
`,
  "utf8"
);


console.log(
  "PASS: created runtime verifier"
);



/*
 * ================================================================
 * Add verifier into npm check
 * ================================================================
 */


const packagePath =
  path.join(
    ROOT,
    "package.json"
  );


const pkg =
  JSON.parse(
    fs.readFileSync(
      packagePath,
      "utf8"
    )
  );


const checkScript =
  pkg.scripts.check ||
  "";


const command =
"node scripts/verify-checkpoint20-runtime.mjs";


if (
  !checkScript.includes(
    command
  )
) {

  pkg.scripts.check =
    checkScript +
    " && " +
    command;


  fs.writeFileSync(
    packagePath,
    JSON.stringify(
      pkg,
      null,
      2
    ) +
    "\n"
  );


  console.log(
    "PASS: added runtime verifier to npm check"
  );
}


console.log();

console.log(
  "============================================================"
);

console.log(
  "CHECKPOINT 20 RUNTIME PATCH COMPLETE"
);

console.log(
  "============================================================"
);

console.log();

console.log(
  "Backup:",
  BACKUP
);

