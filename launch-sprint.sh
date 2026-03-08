dev/null)
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "[$(date)] ERROR: ANTHROPIC_API_KEY not found"
  exit 1
fi

REPOS=(
  "marketsizer-gtm/ms-web-app-project"
  "marketsizer-gtm/marketsizer-enrich-api"
  "marketsizer-gtm/ms-sidebar-project"
  "marketsizer-gtm/ms-insights-platform"
  "marketsizer-gtm/ms-internal-docs"
)

ISSUES=""
ISSUE_COUNT=0

if [ -n "$SELECTED_ISSUES_FILE" ] && [ -f "$SELECTED_ISSUES_FILE" ]; then
  # Selective sprint: use the specific issues list passed from the dashboard
  echo "[$(date)] Selective sprint: loading issues from $SELECTED_ISSUES_FILE"
  while IFS= read -r item; do
    REPO=$(echo "$item" | jq -r '.repo')
    NUM=$(echo "$item" | jq -r '.number')
    TITLE=$(gh issue view "$NUM" --repo "$REPO" --json title --jq '.title' 2>/dev/null || echo "Issue #$NUM")
    ISSUES="$ISSUES\n  - $REPO #$NUM: $TITLE"
    ISSUE_COUNT=$((ISSUE_COUNT + 1))
  done < <(jq -c '.[]' "$SELECTED_ISSUES_FILE")
  rm -f "$SELECTED_ISSUES_FILE"
else
  # Full sprint: fetch all sprint-ready issues from all repos
  echo "[$(date)] Full sprint: fetching sprint-ready issues..."
  for REPO in "${REPOS[@]}"; do
    RESULT=$(gh issue list --repo "$REPO" --label sprint-ready --state open --json number,title,url --limit 20 2>/dev/null || echo "[]")
    while IFS= read -r line; do
      NUM=$(echo "$line" | jq -r ".number")
      TITLE=$(echo "$line" | jq -r ".title")
      if [ "$NUM" != "null" ] && [ -n "$NUM" ]; then
        ISSUES="$ISSUES\n  - $REPO #$NUM: $TITLE"
        ISSUE_COUNT=$((ISSUE_COUNT + 1))
      fi
    done < <(echo "$RESULT" | jq -c ".[]" 2>/dev/null)
  done
fi

if [ "$ISSUE_COUNT" -eq 0 ]; then
  echo "[$(date)] No issues to run. Nothing to do."
  exit 0
fi

echo "[$(date)] Found $ISSUE_COUNT issue(s). Launching sprint..."

# Kill any previous sprint session
tmux kill-session -t ms-sprint 2>/dev/null || true
sleep 1

SESSION="ms-sprint"
tmux new-session -d -s "$SESSION" -c ~/repos/ms-web-app-project

PROMPT="You are running on the MarketSizer Agent VM (ms-agent-vm, westeurope). Work through these sprint-ready GitHub issues autonomously.

For each issue:
1. Read it with: gh issue view <number> --repo <owner/repo>
2. Run /start <short-slug> to create your branch in the correct repo
3. Implement the task following all conventions in CLAUDE.md
4. Run /done when complete -- this creates the PR and merges it
5. Move immediately to the next issue

Every PR body MUST include this exact line: Created by: MarketSizer Agent VM

Issues to work through:
$(echo -e "$ISSUES")

Start immediately with the first issue. No confirmation needed."

# Use -p flag (non-interactive print mode) -- bypasses all setup prompts
# Run in tmux so it persists and the session is visible on the dashboard
tmux send-keys -t "$SESSION" "export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" Enter
sleep 1
tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions -p $(printf '%q' "$PROMPT") 2>&1 | tee ~/sprint-agent/claude-output.log; tmux kill-session -t ms-sprint" Enter

echo "[$(date)] Sprint launched via -p mode in session $SESSION"
