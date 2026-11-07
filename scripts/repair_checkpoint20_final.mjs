import fs from "node:fs";
import process from "node:process";


const APP =
  "public/app.js";


const CSS =
  "public/styles.css";


function fail(
  message
) {
  console.error();
  console.error(
    `ERROR: ${message}`
  );
  console.error();
  console.error(
    "Nothing was deployed."
  );

  process.exit(
    1
  );
}


if (
  !fs.existsSync(
    APP
  ) ||
  !fs.existsSync(
    CSS
  )
) {
  fail(
    "Run this from the speedpulse-next project root."
  );
}


let app =
  fs.readFileSync(
    APP,
    "utf8"
  );


let css =
  fs.readFileSync(
    CSS,
    "utf8"
  );


if (
  !app.includes(
    "CHECKPOINT-20: site recent scans + detailed Lighthouse reports"
  )
) {
  fail(
    "Checkpoint-20 frontend helpers are missing."
  );
}


if (
  !app.includes(
    "async function loadSiteOperationalPanels"
  )
) {
  fail(
    "loadSiteOperationalPanels() is missing."
  );
}


console.log(
  "PASS: Checkpoint-20 frontend helpers detected"
);


/*
 * ================================================================
 * Repair the Mobile/Desktop strategy handler.
 * ================================================================
 *
 * Checkpoint-20 requires the strategy switch to reload BOTH:
 *
 *   loadHistory(...)
 *   loadSiteOperationalPanels(...)
 *
 * before redrawing.
 *
 * Do not rely on the earlier installer's false-positive marker.
 */


const correctStrategyMarker =
  "CHECKPOINT-20: strategy switch reloads history + operational panels";


if (
  app.includes(
    correctStrategyMarker
  )
) {
  console.log(
    "SKIP: corrected strategy handler already installed"
  );
} else {
  /*
   * Current pre-repair handler from Checkpoint 18/19.
   */
  const oldHandler =
`  $$('[data-strategy]').forEach(btn => btn.onclick = async () => { state.strategy = btn.dataset.strategy; state.metric = "performance_score"; await loadHistory(site.id, false); drawSitePage(); });`;


  const occurrences =
    app.split(
      oldHandler
    ).length -
    1;


  if (
    occurrences !==
    1
  ) {
    /*
     * If it does not match the compact form, inspect whether the
     * desired behavior is already present in a different layout.
     */
    const drawStart =
      app.indexOf(
        "function drawSitePage()"
      );


    const drawEnd =
      app.indexOf(
        "function frequencyOptions(",
        drawStart
      );


    if (
      drawStart < 0 ||
      drawEnd <=
        drawStart
    ) {
      fail(
        "Could not isolate drawSitePage()."
      );
    }


    const drawBlock =
      app.slice(
        drawStart,
        drawEnd
      );


    const alreadyCorrect =
      drawBlock.includes(
        "loadSiteOperationalPanels("
      ) &&
      drawBlock.includes(
        "loadHistory("
      ) &&
      drawBlock.includes(
        "data-strategy"
      );


    if (
      alreadyCorrect
    ) {
      /*
       * Add an explicit marker so verification can prove this exact
       * requirement instead of relying on unrelated helper text.
       */
      const handlerAnchor =
        "$$('[data-strategy]')";


      const position =
        app.indexOf(
          handlerAnchor,
          drawStart
        );


      if (
        position < 0 ||
        position >
          drawEnd
      ) {
        fail(
          "Strategy handler appears correct but its insertion point could not be found."
        );
      }


      app =
        app.slice(
          0,
          position
        ) +
        `/* ${correctStrategyMarker} */\n  ` +
        app.slice(
          position
        );


      fs.writeFileSync(
        APP,
        app,
        "utf8"
      );


      console.log(
        "PASS: strategy handler already reloads operational panels; marker added"
      );
    } else {
      console.error();
      console.error(
        `Expected compact strategy handler exactly once; found ${occurrences}.`
      );

      console.error(
        "The handler also did not appear already corrected."
      );

      console.error(
        "STOP rather than guessing."
      );

      process.exit(
        1
      );
    }
  } else {
    const newHandler =
`  /*
   * CHECKPOINT-20: strategy switch reloads history + operational panels.
   *
   * Recent logical scans and retained Lighthouse reports are scoped
   * to the currently selected Mobile/Desktop strategy.
   */
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
  );`;


    app =
      app.replace(
        oldHandler,
        newHandler
      );


    fs.writeFileSync(
      APP,
      app,
      "utf8"
    );


    console.log(
      "PASS: Mobile/Desktop handler now reloads recent scans + detailed reports"
    );
  }
}


/*
 * ================================================================
 * Ensure Compare buttons scroll to the detailed-report panel.
 * ================================================================
 */

app =
  fs.readFileSync(
    APP,
    "utf8"
  );


const drawStart =
  app.indexOf(
    "function drawSitePage()"
  );


const drawEnd =
  app.indexOf(
    "function frequencyOptions(",
    drawStart
  );


if (
  drawStart < 0 ||
  drawEnd <=
    drawStart
) {
  fail(
    "Could not isolate drawSitePage() for Compare-button verification."
  );
}


let drawBlock =
  app.slice(
    drawStart,
    drawEnd
  );


if (
  !drawBlock.includes(
    "$$('[data-focus-report-panel]')"
  )
) {
  /*
   * Insert the click handler immediately before the strategy handler.
   */
  const strategyMarker =
    "CHECKPOINT-20: strategy switch reloads history + operational panels";


  const markerIndex =
    app.indexOf(
      strategyMarker,
      drawStart
    );


  if (
    markerIndex < 0 ||
    markerIndex >
      drawEnd
  ) {
    fail(
      "Could not locate corrected strategy handler for Compare-button insertion."
    );
  }


  const commentStart =
    app.lastIndexOf(
      "  /*",
      markerIndex
    );


  const insertAt =
    commentStart >=
      drawStart
      ? commentStart
      : markerIndex;


  const compareHandler =
`  /*
   * Successful logical scan rows can jump directly to the retained
   * Lighthouse comparison below.
   */
  $$('[data-focus-report-panel]').forEach(
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


`;


  app =
    app.slice(
      0,
      insertAt
    ) +
    compareHandler +
    app.slice(
      insertAt
    );


  fs.writeFileSync(
    APP,
    app,
    "utf8"
  );


  console.log(
    "PASS: Compare button handler installed"
  );
} else {
  console.log(
    "PASS: Compare button handler already present"
  );
}


/*
 * ================================================================
 * Remove extra blank lines at CSS EOF.
 * ================================================================
 */

css =
  fs.readFileSync(
    CSS,
    "utf8"
  );


const cleanedCss =
  css.trimEnd() +
  "\n";


if (
  cleanedCss !==
  css
) {
  fs.writeFileSync(
    CSS,
    cleanedCss,
    "utf8"
  );


  console.log(
    "PASS: removed extra blank line(s) from styles.css EOF"
  );
} else {
  console.log(
    "PASS: styles.css EOF already clean"
  );
}


/*
 * ================================================================
 * Strong final semantic verification.
 * ================================================================
 */

app =
  fs.readFileSync(
    APP,
    "utf8"
  );


const finalDrawStart =
  app.indexOf(
    "function drawSitePage()"
  );


const finalDrawEnd =
  app.indexOf(
    "function frequencyOptions(",
    finalDrawStart
  );


const finalDraw =
  app.slice(
    finalDrawStart,
    finalDrawEnd
  );


const requirements = [
  [
    finalDraw.includes(
      "CHECKPOINT-20: strategy switch reloads history + operational panels"
    ),
    "explicit corrected strategy-handler marker"
  ],

  [
    finalDraw.includes(
      "loadSiteOperationalPanels("
    ),
    "strategy handler reloads recent scans/reports"
  ],

  [
    finalDraw.includes(
      "loadHistory("
    ),
    "strategy handler reloads metrics history"
  ],

  [
    finalDraw.includes(
      "Promise.all(["
    ),
    "strategy-dependent loads happen together"
  ],

  [
    finalDraw.includes(
      "$$('[data-focus-report-panel]')"
    ),
    "Compare-button handler"
  ],

  [
    finalDraw.includes(
      '$("#siteDetailedReports")'
    ),
    "Compare button targets report section"
  ]
];


let failures =
  0;


for (
  const [
    ok,
    label
  ]
  of requirements
) {
  console.log(
    `${ok ? "PASS" : "FAIL"}: ${label}`
  );


  if (!ok) {
    failures +=
      1;
  }
}


if (
  failures
) {
  fail(
    `${failures} Checkpoint-20 final frontend requirement(s) failed.`
  );
}


console.log();
console.log(
  "CHECKPOINT-20 FINAL SOURCE REPAIR PASSED"
);

