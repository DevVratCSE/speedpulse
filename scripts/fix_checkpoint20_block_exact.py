from pathlib import Path

p = Path("public/app.js")

lines = p.read_text().splitlines()

target = None

for i, line in enumerate(lines):
    if "safeForEach" in line and "data-focus-report-panel" in line:
        target = i
        break

if target is None:
    print("Could not find broken safeForEach line")
    raise SystemExit(1)


print("Found broken block at line:", target + 1)


# Find where the next strategy binding starts
end = None

for i in range(target + 1, len(lines)):
    if "data-strategy" in lines[i]:
        end = i
        break

if end is None:
    print("Could not find strategy handler boundary")
    raise SystemExit(1)


print("Replacing lines", target + 1, "to", end)


replacement = r'''
  /*
   * CHECKPOINT-20:
   * Successful scan rows jump to the retained report comparison.
   */
  safeForEach(
    $$('[data-focus-report-panel]'),
    (button) => {
      button.onclick =
        () => {
          document
            .querySelector(
              "#siteDetailedReports"
            )
            ?.scrollIntoView({
              behavior: "smooth",
              block: "start"
            });
        };
    }
  );

'''.splitlines()


new_lines = (
    lines[:target]
    +
    replacement
    +
    lines[end:]
)


p.write_text(
    "\n".join(new_lines) + "\n"
)

print("PASS: replaced malformed Checkpoint-20 Compare block")
