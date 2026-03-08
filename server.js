oadConfig();
  res.json({ ...status, cron: config });
});

// POST /sprint — launch sprint now
app.post("/sprint", (req, res) => {
  if (!requireAuth(req, res)) return;
  const { sprintRunning } = getSprintStatus();
  if (sprintRunning) {
    return res.json({ ok: false, message: "Sprint already running" });
  }

  // Optional: selective issue list forwarded from the dashboard
  const selectedIssues =
    req.body && Array.isArray(req.body.issues) && req.body.issues.length > 0
      ? req.body.issues
      : null;

  const env = { ...process.env };
  if (selectedIssues) {
    const tmpFile = path.join(__dirname, "selected-issues.json");
    fs.writeFileSync(tmpFile, JSON.stringify(selectedIssues));
    env.SELECTED_ISSUES_FILE = tmpFile;
  }

  exec("bash " + LAUNCH_SCRIPT + " >> " + LOG_FILE + " 2>&1", { env }, (err) => {
    if (err) {
      fs.appendFileSync(LOG_FILE, "\nLaunch error: " + err.message + "\n");
    }
  });

  const msg = selectedIssues
    ? "Sprint launching with " + selectedIssues.length + " selected issue(s) — check dashboard in ~30s"
    : "Sprint launching — check dashboard in ~30s";
  res.json({ ok: true, message: msg, selectedCount: selectedIssues ? selectedIssues.length : null, issueCount: selectedIssues ? selectedIssues.length : null, selectedIssues: selectedIssues || null });
});

// GET /cron — get current schedule
app.get("/cron", (req, res) => {
  if (!requireAuth(req, res)) return;
  res.json(loadConfig());
});

// POST /cron — enable or disable
app.post("/cron", (req, res) => {
  if (!requireAuth(req, res)) return;
  const { action, schedule } = req.body;
  const config = loadConfig();

  if (action === "enable") {
    const sched = schedule || config.schedule || "0 23 * * *";
    if (!cron.validate(sched)) {
      return res.status(400).json({ error: "Invalid cron expression" });
    }
    config.enabled = true;
    config.schedule = sched;
    saveConfig(config);
    startCronJob(sched);
    res.json({ ok: true, enabled: true, schedule: sched });
  } else if (action === "disable") {
    config.enabled = false;
    saveConfig(config);
    if (cronJob) { cronJob.stop(); cronJob = null; }
    res.json({ ok: true, enabled: false, schedule: config.schedule });
  } else {
    res.status(400).json({ error: "action must be enable or disable" });
  }
});
// DELETE /sprint -- stop the running sprint
app.delete("/sprint", (req, res) => {
  if (!requireAuth(req, res)) return;
  const { sprintRunning } = getSprintStatus();
  if (!sprintRunning) {
    return res.json({ ok: false, message: "No sprint currently running" });
  }
  exec("tmux kill-session -t ms-sprint", (err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to stop sprint: " + err.message });
    }
    const line = "[" + new Date().toISOString() + "] Sprint stopped via dashboard";
    fs.appendFileSync(LOG_FILE, ["", line, ""].join("\n"));
    res.json({ ok: true, message: "Sprint stopped" });
  });
});

app.listen(3001, "0.0.0.0", () => {
  console.log("Sprint agent webhook listening on :3001");
});
