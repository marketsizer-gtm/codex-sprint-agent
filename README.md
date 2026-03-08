# Sprint Agent Webhook

Tracks the Express webhook that the `/api/admin/agents/trigger` route calls.

## Contents

- `server.js` — Express API handling `/status`, `/sprint`, `/cron`, `/sprint` delete.
- `launch-sprint.sh` — tmux/Claude sprint entrypoint. Respects `SELECTED_ISSUES_FILE`.
- `.env.example` — placeholder for `SPRINT_WEBHOOK_SECRET`.
- `.gitignore` — excludes logs, temp files, node_modules.

## Workflow

1. On the VM, clone `git@github.com:marketsizer-gtm/codex-sprint-agent.git` to `/home/niall/sprint-agent`.
2. Run `npm install` (the repo already vendors the same versions used on the VM).
3. Drop your `SPRINT_WEBHOOK_SECRET` in `.env` (see `.env.example`).
4. The existing systemd/pm2 service points at `/home/niall/sprint-agent/server.js`. Use `systemctl restart sprint-agent` or `pm2 restart sprint-agent` after pulling updates.

## Ops

- Keep `server.js` and `launch-sprint.sh` executable (`chmod +x`), they are executed by systemd/tmux.
- If you change `launch-sprint.sh`, rebuild `selected-issues` handling and ensure the new output still terminates with the same log message so the dashboard can parse.
