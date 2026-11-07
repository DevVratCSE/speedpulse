import fs from "node:fs";


const file =
  "public/app.js";


let app =
  fs.readFileSync(
    file,
    "utf8"
  );


/*
 * Fix malformed safeForEach calls introduced by the previous
 * automated replacement.
 */


app =
  app.replace(
    /safeForEach\(\$\$\('\[data-focus-report-panel\]'\),/g,
    "safeForEach($$('[data-focus-report-panel]'),"
  );


app =
  app.replace(
    /safeForEach\(\$\('\[data-focus-report-panel\]'\),/g,
    "safeForEach($$('[data-focus-report-panel]'),"
  );


app =
  app.replace(
    /safeForEach\(\$\$\('\[data-strategy\]'\),/g,
    "safeForEach($$('[data-strategy]'),"
  );


app =
  app.replace(
    /safeForEach\(\$\('\[data-strategy\]'\),/g,
    "safeForEach($$('[data-strategy]'),"
  );


fs.writeFileSync(
  file,
  app,
  "utf8"
);


console.log(
  "Applied safeForEach selector normalization"
);


const checks = [
  [
    app.includes(
      "function safeForEach"
    ),
    "safeForEach exists"
  ],

  [
    app.includes(
      "safeForEach($$('[data-focus-report-panel]'),"
    ),
    "report collection uses $$"
  ],

  [
    app.includes(
      "safeForEach($$('[data-strategy]'),"
    ),
    "strategy collection uses $$"
  ],

  [
    !app.includes(
      "safeForEach($('["
    ),
    "single element selector misuse removed"
  ]
];


let failed = 0;


for (
  const [
    ok,
    label
  ]
  of checks
) {
  console.log(
    `${ok ? "PASS" : "FAIL"}: ${label}`
  );

  if (!ok) {
    failed++;
  }
}


if (
  failed
) {
  process.exit(
    1
  );
}


console.log(
  "Checkpoint 20.1 foreach repair passed"
);
