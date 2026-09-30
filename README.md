# VM Webhook Server (sprint investigator)

Source of truth for the `webhook-server` systemd service on `ms-agent-vm`
(`/home/niall/webhook-server`, `node server.mjs` on port 3001). The web app's
`/api/admin/agents/trigger` route calls it to dispatch sprint issues.
Every dispatch runs `investigate.mjs`, which reads the issue, searches the local
repo clone, asks a model whether the issue still exists, and posts the verdict
as an issue comment.

This repo replaces the old `sprint-agent` predecessor (`server.js` +
`launch-sprint.sh`, a tmux/Claude sprint runner). The VM service had been running
untracked since March 2026.

## Files

- `server.mjs` is the Express webhook.
- `investigate.mjs` is the per-issue investigator, spawned detached by `server.mjs`.
- `lib.mjs` holds the pure helpers: repo allow-list, input validation, verdict rule and gateway request body.
- `webhook-server.service` is the systemd unit. It uses placeholders for secrets; the real values live only on the VM.
- `test/lib.test.mjs` holds the `node:test` unit tests.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/status` | none | tmux sprint sessions, last 10 activity-log entries, uptime |
| POST | `/sprint` | `x-webhook-secret` | Body `{ issues: [{ repo, number }] }`. Each item is validated (repo must be in `REPO_PATHS`, number must be a positive integer), then dispatched to `investigate.mjs`. Only investigation runs; the execute path is disabled. |
| DELETE | `/sprint` | `x-webhook-secret` | Kill all `sprint*` tmux sessions |

Activity log: `logs/activity.jsonl`.

## Model routing

`investigate.mjs` picks one of two paths and logs which one it used (`Model path: ...`).

1. **Gateway**, used when `INTERNAL_AI_SECRET` and `IGGY_GATEWAY_API_KEY` are both set:
   - It reads the model config from `GET {MS_APP_BASE_URL}/api/internal/ai/agent-config/sprint-investigator` and caches it for 60s in `$TMPDIR/sprint-investigator-config.json`.
   - If the config returns `enabled: false`, it logs and exits 0 without commenting.
   - It calls `{IGGY_GATEWAY_BASE_URL}/v1/chat/completions` with tag `sprint-investigator`. `gpt-6*` models get `reasoning_effort: "none"`, and `gpt-5*`/`gpt-6*` models are sent no temperature.
2. **Direct Azure**, the fallback. It is used when either secret is missing or the config endpoint cannot be reached. It is the same `gpt-5.4-mini` Sweden Central call as before.

After every model call, whether it succeeds or fails, the script POSTs usage to `{MS_APP_BASE_URL}/api/internal/ai/usage`. This is skipped when there is no secret, and it never throws.

## Verdict rule

This mirrors `ms-web-app-project/app-code/lib/admin/investigation-verdict.ts`.

| Model output | Headline | Label |
|---|---|---|
| `still_exists: true` | 🔴 Still Present | `investigation-complete` |
| `still_exists: false` and `confidence: HIGH` | ✅ Likely Resolved | `investigation-complete` |
| anything else (MEDIUM, LOW, missing) | ⚪ Inconclusive | `investigation-inconclusive` |

If a repo does not have the `investigation-inconclusive` label yet, the script creates it on first use.

## Environment variables (names only; values live on the VM)

| Name | Required | Purpose |
|---|---|---|
| `WEBHOOK_SECRET` | yes | Shared secret for `POST`/`DELETE /sprint`. If it is unset, those requests are rejected. |
| `AZURE_FOUNDRY_KEY` | yes (fallback path) | Key for the direct Azure call |
| `GITHUB_TOKEN` | yes | `gh` auth |
| `PATH` | yes | Must include `gh` and `node` |
| `INTERNAL_AI_SECRET` | optional | Bearer token for the web app's agent-config and usage endpoints |
| `IGGY_GATEWAY_API_KEY` | optional | Gateway key. The gateway is used only when this and `INTERNAL_AI_SECRET` are both set. |
| `MS_APP_BASE_URL` | optional | Default `https://app.marketsizer.io` |
| `IGGY_GATEWAY_BASE_URL` | optional | Default: the UK South gateway container app |

## Security

- No child process goes through a shell with interpolated input. Every call is `execFileSync(file, [args])`.
- `gh` needs the login environment, so it runs as `bash -lc 'gh "$@"' gh <args...>`. The arguments are passed positionally, never spliced into the script.
- Issue-body search terms go to `grep -F -e <term> --` as data.

## Development

```bash
npm install
npm test        # node --check on every file + node:test unit tests
```

## Deploy on the VM (manual)

The first deploy turns the untracked directory into a clone. It keeps `logs/`, `node_modules/` and the unit's secrets:

```bash
ssh ms-agent-vm
cd /home/niall/webhook-server
cp server.mjs server.mjs.bak.$(date +%Y%m%d-%H%M%S)
cp investigate.mjs investigate.mjs.bak.$(date +%Y%m%d-%H%M%S)
git init -q && git remote add origin git@github.com:marketsizer-gtm/codex-sprint-agent.git
git fetch -q origin master && git reset --hard origin/master   # untracked logs/, node_modules/ and batch-review-fc.mjs are untouched
npm install --omit=dev && npm test
sudo systemctl restart webhook-server
curl -s localhost:3001/status | head -c 400
```

Later deploys:

```bash
cd /home/niall/webhook-server && git pull --ff-only && npm install --omit=dev && npm test && sudo systemctl restart webhook-server
```

To turn on the gateway path, add `INTERNAL_AI_SECRET` and `IGGY_GATEWAY_API_KEY` to the unit. Use `sudo systemctl edit webhook-server` so the values stay out of git. Then run `sudo systemctl daemon-reload && sudo systemctl restart webhook-server` and check the next investigation's log line `Model path: gateway (...)`.

The unit file in this repo is a reference copy. Do **not** copy it over `/etc/systemd/system/webhook-server.service`, because its placeholders would replace the real secret values.
