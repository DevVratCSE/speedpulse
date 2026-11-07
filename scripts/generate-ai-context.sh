#!/usr/bin/env bash

set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

STAMP="$(date '+%Y%m%d_%H%M%S')"
FINAL="$ROOT/SPEEDPULSE_AI_CONTEXT_${STAMP}.md"
TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/speedpulse-ai-context.XXXXXX")"

MAX_FILE_BYTES=300000

cleanup() {
  rm -f "$TMP_FILE" 2>/dev/null || true
}
trap cleanup EXIT

write() {
  printf '%s\n' "$*" >> "$TMP_FILE"
}

section() {
  write ""
  write "============================================================"
  write "$1"
  write "============================================================"
  write ""
}

command_block() {
  title="$1"
  shift

  write "## $title"
  write ""
  write '`````text'

  set +e
  "$@" >> "$TMP_FILE" 2>&1
  rc=$?
  set -e 2>/dev/null || true

  write ""
  write "[exit_code=$rc]"
  write '`````'
  write ""

  return 0
}

language_for() {
  case "$1" in
    *.ts|*.tsx) echo "typescript" ;;
    *.js|*.mjs|*.cjs) echo "javascript" ;;
    *.json) echo "json" ;;
    *.jsonc) echo "jsonc" ;;
    *.sql) echo "sql" ;;
    *.md) echo "markdown" ;;
    *.html) echo "html" ;;
    *.css) echo "css" ;;
    *.sh|*.bash) echo "bash" ;;
    *.yml|*.yaml) echo "yaml" ;;
    *.csv) echo "csv" ;;
    *) echo "text" ;;
  esac
}

append_file() {
  file="$1"

  [ -f "$file" ] || return 0

  case "$file" in
    package-lock.json) return 0 ;;
    .dev.vars|.dev.vars.*) return 0 ;;
    .env|.env.*) return 0 ;;
    *SPEEDPULSE_AI_CONTEXT*.md) return 0 ;;
    *SPEEDPULSE_FULL_CONTEXT*.md) return 0 ;;
  esac

  bytes="$(wc -c < "$file" | tr -d ' ')"

  write "## FILE: $file"
  write ""

  if [ "$bytes" -gt "$MAX_FILE_BYTES" ]; then
    write "[Skipped full contents: ${bytes} bytes, limit=${MAX_FILE_BYTES}]"
    write ""
    return 0
  fi

  lang="$(language_for "$file")"

  write "\`\`\`\`\`${lang}"
  cat "$file" >> "$TMP_FILE"
  write ""
  write '`````'
  write ""
}

section "SPEEDPULSE AI PROJECT HANDOFF"

write "Generated: $(date)"
write "Repository: $ROOT"
write ""
write "PURPOSE:"
write "Fresh engineering handoff for continuing SpeedPulse development in ChatGPT."
write ""
write "SECURITY:"
write "- Secret files are intentionally excluded."
write "- .dev.vars and .env files are NOT included."
write "- .wrangler local state is NOT included."
write "- database backups are NOT included."
write "- node_modules is NOT included."
write "- package-lock.json contents are NOT included."
write "- Inspect this file before uploading anyway."
write ""

section "1. MACHINE AND TOOLCHAIN"

command_block "Current directory" pwd
command_block "Operating system" uname -a
command_block "Node version" node --version
command_block "npm version" npm --version

if command -v npx >/dev/null 2>&1; then
  command_block "Wrangler version" npx --no-install wrangler --version
fi

section "2. GIT STATE"

command_block "Current branch" git branch --show-current
command_block "Working tree status" git status --short
command_block "Recent commit graph" git --no-pager log --graph --decorate --oneline --all -30
command_block "Tags" git tag --sort=-creatordate
command_block "HEAD details" git --no-pager show --stat --summary HEAD
command_block "Uncommitted change summary" git diff --stat
command_block "Staged change summary" git diff --cached --stat
command_block "Git whitespace check" git diff --check

section "3. UNCOMMITTED SOURCE DIFF"

write "## Unstaged diff"
write ""
write '`````diff'
git --no-pager diff -- \
  . \
  ':!package-lock.json' \
  ':!.dev.vars' \
  ':!.dev.vars.*' \
  ':!.env' \
  ':!.env.*' \
  >> "$TMP_FILE" 2>&1 || true
write '`````'
write ""

write "## Staged diff"
write ""
write '`````diff'
git --no-pager diff --cached -- \
  . \
  ':!package-lock.json' \
  ':!.dev.vars' \
  ':!.dev.vars.*' \
  ':!.env' \
  ':!.env.*' \
  >> "$TMP_FILE" 2>&1 || true
write '`````'
write ""

section "4. PROJECT FILE TREE"

write '`````text'

find . \
  \( -path './.git' \
     -o -path './node_modules' \
     -o -path './.wrangler' \
     -o -path './backups' \
     -o -path './dist' \
     -o -path './build' \
     -o -path './coverage' \
  \) -prune \
  -o -type f -print \
  2>/dev/null \
  | sed 's#^\./##' \
  | grep -v '^SPEEDPULSE_AI_CONTEXT_' \
  | grep -v '^SPEEDPULSE_FULL_CONTEXT_' \
  | sort \
  >> "$TMP_FILE"

write '`````'
write ""

section "5. PACKAGE AND BUILD CONFIGURATION"

for file in \
  package.json \
  tsconfig.json \
  wrangler.jsonc \
  .gitignore \
  .dev.vars.example
do
  append_file "$file"
done

if [ -f package-lock.json ]; then
  write "## package-lock.json"
  write ""
  write "Full package-lock.json intentionally omitted."
  write ""
  if command -v shasum >/dev/null 2>&1; then
    command_block "package-lock SHA-256" shasum -a 256 package-lock.json
  fi
fi

if [ -d node_modules ]; then
  command_block "Installed top-level npm dependencies" npm ls --depth=0
fi

section "6. PROJECT DOCUMENTATION"

for file in \
  README.md \
  ARCHITECTURE.md \
  CHANGES.md \
  SETUP.md \
  RECOVERY_DEPLOY.md \
  ROADMAP.md \
  TODO.md
do
  append_file "$file"
done

section "7. DATABASE MIGRATIONS"

if [ -d migrations ]; then
  find migrations -type f \
    \( -name '*.sql' -o -name '*.md' \) \
    | sort \
    | while IFS= read -r file
      do
        append_file "$file"
      done
fi

section "8. WORKER SOURCE"

if [ -d src ]; then
  find src -type f \
    \( -name '*.ts' \
       -o -name '*.tsx' \
       -o -name '*.js' \
       -o -name '*.mjs' \
       -o -name '*.json' \
    \) \
    | sort \
    | while IFS= read -r file
      do
        append_file "$file"
      done
fi

section "9. FRONTEND SOURCE"

if [ -d public ]; then
  find public -type f \
    \( -name '*.html' \
       -o -name '*.css' \
       -o -name '*.js' \
       -o -name '*.mjs' \
       -o -name '*.json' \
       -o -name '*.svg' \
    \) \
    | sort \
    | while IFS= read -r file
      do
        append_file "$file"
      done
fi

section "10. DEVELOPMENT AND VERIFICATION SCRIPTS"

if [ -d scripts ]; then
  find scripts -type f \
    \( -name '*.js' \
       -o -name '*.mjs' \
       -o -name '*.ts' \
       -o -name '*.sql' \
       -o -name '*.sh' \
    \) \
    ! -name 'generate-ai-context.sh' \
    | sort \
    | while IFS= read -r file
      do
        append_file "$file"
      done
fi

section "11. TEST FILES"

for dir in test tests __tests__; do
  if [ -d "$dir" ]; then
    find "$dir" -type f \
      \( -name '*.js' \
         -o -name '*.mjs' \
         -o -name '*.ts' \
         -o -name '*.json' \
         -o -name '*.sql' \
      \) \
      | sort \
      | while IFS= read -r file
        do
          append_file "$file"
        done
  fi
done

section "12. SAMPLE FILES"

if [ -d samples ]; then
  find samples -type f \
    \( -name '*.csv' \
       -o -name '*.json' \
       -o -name '*.md' \
    \) \
    | sort \
    | while IFS= read -r file
      do
        append_file "$file"
      done
fi

section "13. LOCAL QUALITY GATES"

if [ -f package.json ]; then
  command_block "npm run check" npm run check
fi

if [ -x ./node_modules/.bin/wrangler ]; then
  command_block \
    "Cloudflare Worker dry-run build" \
    ./node_modules/.bin/wrangler deploy --dry-run
fi

section "14. IMPORTANT SOURCE REFERENCES"

command_block \
  "Tracked files" \
  git ls-files

command_block \
  "Untracked files" \
  git ls-files --others --exclude-standard

section "15. AI HANDOFF QUESTIONS"

write "When uploading this file to ChatGPT, provide the following separately:"
write ""
write "END GOAL:"
write "<what the finished SpeedPulse product must do>"
write ""
write "CURRENT BLOCKER:"
write "<the exact problem stopping completion>"
write ""
write "REMAINING FEATURES:"
write "<anything still knowingly unfinished>"
write ""
write "CONSTRAINTS:"
write "<free-tier limits, deployment restrictions, compatibility requirements>"
write ""
write "DO NOT CHANGE:"
write "<parts of the system that are already proven and should remain stable>"
write ""
write "DESIRED NEXT ACTION:"
write "<debug / audit / production deploy / cleanup / security review / release>"
write ""

section "16. END OF CONTEXT"

write "Generated from repository state at:"
write "$(date)"
write ""
write "End of SpeedPulse AI project handoff."

mv "$TMP_FILE" "$FINAL"
trap - EXIT

LINES="$(wc -l < "$FINAL" | tr -d ' ')"
BYTES="$(wc -c < "$FINAL" | tr -d ' ')"

echo
echo "============================================================"
echo "SPEEDPULSE AI CONTEXT GENERATED"
echo "============================================================"
echo
echo "File:"
echo "$FINAL"
echo
echo "Lines: $LINES"
echo "Bytes: $BYTES"
echo

if grep -Eq \
  'AIza[0-9A-Za-z_-]{25,}|sk-[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|Bearer[[:space:]]+[0-9A-Za-z._-]{25,}' \
  "$FINAL"
then
  echo "WARNING: A possible credential/token pattern was detected."
  echo "Review the generated file before uploading it."
else
  echo "Basic credential-pattern scan: clean"
fi

echo
echo "Upload this .md file to ChatGPT with your end goals."
echo
