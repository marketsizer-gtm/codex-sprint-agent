import express from "express";
import { execFileSync, spawn } from "child_process";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { AGENT_ID, validateDispatch } from "./lib.mjs";

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PORT = 3001;
const CLEANUP_INTERVAL_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const INVESTIGATE = join(HERE, "investigate.mjs");
const LOG_DIR = join(HERE, "logs");
const ACTIVITY_LOG = LOG_DIR + "/activity.jsonl";

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(line);
  try { appendFileSync(ACTIVITY_LOG, line + "\n"); } catch {}
}

function verifySecret(req, res, next) {
  if (!WEBHOOK_SECRET || req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// No shell anywhere: every child process takes an argument array.
function exec(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// gh needs the login environment (auth lives there), so run it via `bash -lc`
// with the arguments passed positionally — never interpolated into the script.
function gh(args) {
  return exec("bash", ["-lc", 'gh "$@"', "gh", ...args]);
}

function tmuxSessions() {
  try {
    const out = exec("tmux", ["list-sessions", "-F", "#{session_name}"]);
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function isSessionActive(sessionName) {
  try {
    const panePid = exec("tmux", ["list-panes", "-t", sessionName, "-F", "#{pane_pid}"]).trim().split("\n")[0];
    if (!panePid) return false;
    const children = exec("pgrep", ["-P", panePid]).trim();
    return children.length > 0;
  } catch {
    return false;
  }
}

function killSession(sessionName) {
  exec("tmux", ["kill-session", "-t", sessionName]);
}

function cleanupFinished() {
  const sessions = tmuxSessions().filter(s => s.startsWith("sprint"));
  for (const s of sessions) {
    if (!isSessionActive(s)) {
      try {
        killSession(s);
        log({ event: "session_cleaned", session: s });
      } catch {}
    }
  }
}

setInterval(cleanupFinished, CLEANUP_INTERVAL_MS);

function recentActivity(limit = 20) {
  try {
    if (!existsSync(ACTIVITY_LOG)) return [];
    const lines = readFileSync(ACTIVITY_LOG, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

function spawnInvestigation(repo, number) {
  const child = spawn("node", [INVESTIGATE, repo, String(number)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

app.get("/status", (_req, res) => {
  const sessions = tmuxSessions();
  const sprintSessions = sessions.filter(s => s.startsWith("sprint"));
  const activity = recentActivity(10);
  res.json({
    sprintRunning: sprintSessions.some(s => isSessionActive(s)),
    activeSessions: sprintSessions.map(s => ({ name: s, active: isSessionActive(s) })),
    recentActivity: activity,
    uptime: process.uptime(),
  });
});

app.post("/sprint", verifySecret, async (req, res) => {
  const issues = Array.isArray(req.body?.issues) ? req.body.issues : [];

  if (issues.length === 0) {
    return res.status(400).json({ error: "No issues provided. Pass { issues: [{repo, number}] }" });
  }

  const results = [];

  for (let i = 0; i < issues.length; i++) {
    const v = validateDispatch(issues[i]);
    if (!v.ok) {
      log({ event: "sprint_rejected", repo: String(issues[i]?.repo), number: String(issues[i]?.number), error: v.error });
      results.push({ repo: issues[i]?.repo, number: issues[i]?.number, error: v.error });
      continue;
    }
    const { repo, number } = v;
    if (i > 0) await new Promise(r => setTimeout(r, 5000));
    try {
      const issueJson = gh(["issue", "view", String(number), "--repo", repo, "--json", "number,title,body,labels"]);
      const issue = JSON.parse(issueJson);
      const body = issue.body || "";
      // Parse execution readiness from CoE metadata in issue body
      const matches = [...body.matchAll(/Execution Readiness:\s*(\S+)/g)];
      const execReadiness = matches.length > 0 ? matches[matches.length - 1][1] : "";

      let action;

      if (execReadiness === "sprint-ready-investigate") {
        spawnInvestigation(repo, number);
        action = "investigating";
        log({ event: "sprint_dispatch", repo, number, title: issue.title, action, agent: AGENT_ID });

      } else if (execReadiness === "sprint-ready-execute" || execReadiness === "sprint-ready") {
        // INVESTIGATE-ONLY MODE: sprint-ready-execute is routed to the investigate path until confidence is restored.
        spawnInvestigation(repo, number);
        action = "investigating (execute path disabled — INVESTIGATE-ONLY mode)";
        log({ event: "sprint_dispatch", repo, number, title: issue.title, action, agent: AGENT_ID, note: "execute path disabled" });

      } else {
        // No CoE metadata — default to investigate for new items
        spawnInvestigation(repo, number);
        action = "investigating-default";
        log({ event: "sprint_dispatch", repo, number, title: issue.title, action, agent: AGENT_ID, execReadiness, note: "no CoE metadata — defaulting to investigate" });
      }

      results.push({ repo, number, title: issue.title, action, execReadiness });
    } catch (err) {
      log({ event: "sprint_error", repo, number, error: err.message });
      results.push({ repo, number, error: err.message });
    }
  }

  res.json({ dispatched: results });
});

app.delete("/sprint", verifySecret, (_req, res) => {
  const sessions = tmuxSessions().filter(s => s.startsWith("sprint"));
  for (const s of sessions) {
    try { killSession(s); } catch {}
  }
  log({ event: "sprint_killed", sessions });
  res.json({ killed: sessions });
});

app.listen(PORT, () => {
  log({ event: "server_started", port: PORT });
  console.log("Webhook server listening on port " + PORT);
});
