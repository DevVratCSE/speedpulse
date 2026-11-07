
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
