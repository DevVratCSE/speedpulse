import fs from "node:fs";

const file =
  "public/app.js";


let app =
  fs.readFileSync(
    file,
    "utf8"
  );


const broken =
`safeForEach($('[data-focus-report-panel']),`;


const correct =
`safeForEach($$('[data-focus-report-panel']),`;


if (
  app.includes(
    broken
  )
) {

  app =
    app.replace(
      broken,
      correct
    );


  fs.writeFileSync(
    file,
    app,
    "utf8"
  );


  console.log(
    "PASS: fixed broken safeForEach selector"
  );

} else {

  console.log(
    "INFO: broken pattern not found"
  );

}



const checks = [
  [
    !app.includes(
      "safeForEach($('[data-focus-report-panel'])"
    ),
    "broken single-selector replacement removed"
  ],

  [
    app.includes(
      "safeForEach($$('[data-focus-report-panel'])"
    ),
    "report foreach uses $$ collection"
  ],

  [
    app.includes(
      "function safeForEach"
    ),
    "safeForEach exists"
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


  if (
    !ok
  ) {
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
  "Checkpoint-20 syntax repair complete"
);

