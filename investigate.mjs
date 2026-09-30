#!/usr/bin/env node
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AGENT_ID,
  REPO_PATHS,
  DEFAULT_APP_BASE_URL,
  DEFAULT_GATEWAY_BASE_URL,
  buildGatewayBody,
  decideVerdict,
  parseIssueNumber,
  shouldUseGateway,
} from "./lib.mjs";

const [,, repo, issueArg] = process.argv;
const issueNumber = parseIssueNumber(issueArg);

if (!repo || issueNumber === null) {
  console.error("Usage: node investigate.mjs <org/repo> <issueNumber>");
  process.exit(1);
}
if (!Object.hasOwn(REPO_PATHS, repo)) {
  console.error("Repo not in allow-list: " + repo);
  process.exit(1);
}

const AZURE_FOUNDRY_KEY = process.env.AZURE_FOUNDRY_KEY;
const AZURE_MODEL = "gpt-5.4-mini";
const AZURE_URL = "https://swedencentral.api.cognitive.microsoft.com/openai/deployments/" + AZURE_MODEL + "/chat/completions?api-version=2025-01-01-preview";

const APP_BASE_URL = (process.env.MS_APP_BASE_URL || DEFAULT_APP_BASE_URL).replace(/\/+$/, "");
const GATEWAY_BASE_URL = (process.env.IGGY_GATEWAY_BASE_URL || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
const INTERNAL_AI_SECRET = process.env.INTERNAL_AI_SECRET;
const IGGY_GATEWAY_API_KEY = process.env.IGGY_GATEWAY_API_KEY;
const CONFIG_CACHE_FILE = join(tmpdir(), AGENT_ID + "-config.json");
const CONFIG_TTL_MS = 60_000;

// No shell anywhere: every child process takes an argument array, so text
// from the issue body can never be interpreted as shell syntax.
function run(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// gh needs the login environment (auth lives there), so run it via `bash -lc`
// with the arguments passed positionally — never interpolated into the script.
function gh(args) {
  return run("bash", ["-lc", 'gh "$@"', "gh", ...args]);
}

function firstLines(text, n) {
  return text.split("\n").filter(Boolean).slice(0, n);
}

const SOURCE_INCLUDES = ["--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.css"];

function grepFiles(repoPath, term, { ignoreCase = false, includes = SOURCE_INCLUDES } = {}) {
  const flags = ignoreCase ? "-rliF" : "-rlF";
  return firstLines(run("grep", [flags, ...includes, "--exclude-dir=node_modules", "-e", term, "--", repoPath]), 5);
}

function grepLines(file, term, { ignoreCase = false } = {}) {
  const flags = ignoreCase ? "-niF" : "-nF";
  return firstLines(run("grep", [flags, "-e", term, "--", file]), 5).join("\n");
}

function gatherCodeContext(repoPath, issue) {
  // Pull latest
  run("git", ["-C", repoPath, "fetch", "origin"]);
  run("git", ["-C", repoPath, "reset", "--hard", "origin/HEAD"]);

  const body = issue.body || "";
  const title = issue.title || "";
  const combined = title + " " + body;

  // Extract keywords from issue: file paths, component names, function names
  const fileRefs = [...combined.matchAll(/[\w/.-]+\.(tsx?|jsx?|sql|css|html|mjs)/g)].map(m => m[0]);
  const componentRefs = [...combined.matchAll(/[A-Z][a-zA-Z]+(?:Page|Card|Modal|Button|Tab|Section|Row|Panel)/g)].map(m => m[0]);
  const functionRefs = [...combined.matchAll(/(?:function|const|def)\s+(\w+)/g)].map(m => m[1]);

  // Also extract quoted strings and backtick code refs
  const codeRefs = [...combined.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(s => s.length > 3 && s.length < 80);

  const searchTerms = [...new Set([...fileRefs, ...componentRefs, ...functionRefs, ...codeRefs])].slice(0, 10);

  let codeSnippets = [];

  // Search for referenced files
  for (const term of searchTerms) {
    // Try as file path first
    if (term.includes(".")) {
      const name = term.split("/").pop();
      const found = firstLines(run("find", [repoPath, "-path", "*/node_modules", "-prune", "-o", "-name", name, "-print"]), 3);
      for (const file of found.slice(0, 2)) {
        const content = run("head", ["-50", "--", file]);
        if (content) {
          const relPath = file.replace(repoPath + "/", "");
          codeSnippets.push(`### ${relPath} (first 50 lines)\n\`\`\`\n${content}\n\`\`\``);
        }
      }
    }

    // Grep for the term in source files
    for (const file of grepFiles(repoPath, term).slice(0, 2)) {
      const matches = grepLines(file, term);
      if (matches) {
        const relPath = file.replace(repoPath + "/", "");
        codeSnippets.push(`### Grep: "${term}" in ${relPath}\n\`\`\`\n${matches}\n\`\`\``);
      }
    }
  }

  // If no specific refs found, check for keywords from issue title
  if (codeSnippets.length === 0) {
    const titleWords = title.replace(/[^a-zA-Z ]/g, "").split(" ").filter(w => w.length > 4).slice(0, 3);
    for (const word of titleWords) {
      const files = grepFiles(repoPath, word, { ignoreCase: true, includes: ["--include=*.ts", "--include=*.tsx"] });
      for (const file of files.slice(0, 1)) {
        const matches = grepLines(file, word, { ignoreCase: true });
        const relPath = file.replace(repoPath + "/", "");
        codeSnippets.push(`### Grep: "${word}" in ${relPath}\n\`\`\`\n${matches}\n\`\`\``);
      }
    }
  }

  return codeSnippets.slice(0, 8).join("\n\n");
}

// Post a comment via a private temp file (gh --body-file), never via argv/shell.
function postComment(body) {
  const dir = mkdtempSync(join(tmpdir(), "investigation-"));
  const file = join(dir, "comment.md");
  try {
    writeFileSync(file, body);
    gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Agent config (web app is the source of truth for model + enabled) -----

async function loadAgentConfig() {
  try {
    if (existsSync(CONFIG_CACHE_FILE) && Date.now() - statSync(CONFIG_CACHE_FILE).mtimeMs < CONFIG_TTL_MS) {
      return JSON.parse(readFileSync(CONFIG_CACHE_FILE, "utf8"));
    }
  } catch {}
  const res = await fetch(APP_BASE_URL + "/api/admin/ai-ops/vm/agent-config/" + AGENT_ID, {
    headers: { Authorization: "Bearer " + INTERNAL_AI_SECRET },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error("agent-config " + res.status);
  const config = await res.json();
  if (!config || typeof config !== "object") throw new Error("agent-config returned no object");
  try { writeFileSync(CONFIG_CACHE_FILE, JSON.stringify(config)); } catch {}
  return config;
}

// Fire-and-forget usage record. Never throws; skipped without the secret.
async function reportUsage(entry) {
  if (!INTERNAL_AI_SECRET) return;
  try {
    await fetch(APP_BASE_URL + "/api/admin/ai-ops/vm/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + INTERNAL_AI_SECRET },
      body: JSON.stringify({ agentId: AGENT_ID, ...entry, metadata: { repo, issue: issueNumber } }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error("usage report failed: " + err.message);
  }
}

// --- Model call --------------------------------------------------------------

async function callGateway(config, messages) {
  const response = await fetch(GATEWAY_BASE_URL + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + IGGY_GATEWAY_API_KEY },
    body: JSON.stringify(buildGatewayBody(config, messages)),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error("Iggy gateway " + response.status + ": " + errText.slice(0, 500));
  }
  return response.json();
}

async function callAzureDirect(messages) {
  const response = await fetch(AZURE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": AZURE_FOUNDRY_KEY,
    },
    body: JSON.stringify({
      messages,
      temperature: 0.2,
      max_completion_tokens: 2000,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error("Azure OpenAI " + response.status + ": " + errText);
  }
  return response.json();
}

async function main() {
  console.log("Investigating issue #" + issueNumber + " in " + repo + "...");

  // 0. Resolve model route. Gateway needs both new secrets and a reachable
  //    config; anything missing falls back to the direct Azure call as before.
  let route = { path: "azure-direct", model: AZURE_MODEL };
  if (shouldUseGateway(process.env)) {
    try {
      const config = await loadAgentConfig();
      if (config.enabled === false) {
        console.log("Agent " + AGENT_ID + " is disabled in agent config — skipping investigation.");
        process.exit(0);
      }
      if (!config.model) throw new Error("agent-config has no model");
      route = { path: "gateway", model: config.model, config };
    } catch (err) {
      console.error("Agent config unavailable (" + err.message + ") — falling back to direct Azure.");
    }
  } else {
    console.log("INTERNAL_AI_SECRET or IGGY_GATEWAY_API_KEY not set — using direct Azure.");
  }
  console.log("Model path: " + route.path + " (" + route.model + ")");

  // 1. Fetch issue details
  let issue;
  try {
    const raw = gh(["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,labels"]);
    issue = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to fetch issue: " + err.message);
    process.exit(1);
  }

  console.log("Issue: " + issue.title);

  // 2. Gather code context from actual repo
  const repoPath = REPO_PATHS[repo];
  console.log("Searching codebase at " + repoPath + "...");
  const codeContext = gatherCodeContext(repoPath, issue);
  console.log("Found " + (codeContext.split("###").length - 1) + " code snippets.");

  // 3. Call the model with issue + code context
  const systemPrompt = `You are a senior engineer investigating a backlog item for MarketSizer (Next.js, Supabase, Chrome extension).

You will receive:
1. A GitHub issue (title, body, labels)
2. Actual code snippets from the current codebase (searched by keywords from the issue)

Your job:
- Determine if the bug/feature described in the issue STILL EXISTS in the current code
- If the code snippets show the issue has been fixed, say so clearly
- If the issue is still present, propose a specific fix with file paths and line numbers
- Return ONLY valid JSON with these fields:
  - still_exists: boolean (true if the issue is still present in the code)
  - confidence: "HIGH" | "MEDIUM" | "LOW" (how confident you are in your assessment)
  - evidence: string (what in the code confirms or denies the issue)
  - summary: string (2-3 sentence summary)
  - affected_files: string[] (actual file paths from the code search)
  - proposed_approach: string[] (step-by-step fix, only if still_exists is true)
  - complexity: "LOW" | "MEDIUM" | "HIGH"
  - risks: string[]`;

  const labelStr = (issue.labels || []).map(l => l.name).join(", ");
  const userPrompt = `Issue #${issue.number}: ${issue.title}
Labels: ${labelStr}

Body:
${(issue.body || "(no body)").slice(0, 2000)}

---

## Code from current codebase (searched by keywords from the issue):

${codeContext || "(no matching code found — the referenced files/components may have been removed or renamed)"}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let analysis;
  const started = Date.now();
  try {
    const data = route.path === "gateway"
      ? await callGateway(route.config, messages)
      : await callAzureDirect(messages);
    analysis = JSON.parse(data.choices[0].message.content);
    await reportUsage({
      model: route.model,
      success: true,
      durationMs: Date.now() - started,
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
    });
  } catch (err) {
    console.error("AI analysis failed: " + err.message);
    await reportUsage({
      model: route.model,
      success: false,
      durationMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      error: String(err.message).slice(0, 500),
    });
    try {
      postComment("## Investigation Failed\n\nCould not complete AI analysis: " + err.message);
    } catch {}
    process.exit(1);
  }

  const { verdict, headline, label } = decideVerdict(analysis);
  console.log("Analysis: still_exists=" + analysis.still_exists + " confidence=" + analysis.confidence + " verdict=" + verdict);

  // 4. Post findings
  const affectedFiles = (analysis.affected_files || []).map(f => "- `" + f + "`").join("\n") || "- None identified";
  const steps = verdict === "present"
    ? (analysis.proposed_approach || []).map((s, i) => (i + 1) + ". " + s).join("\n") || "- No steps identified"
    : verdict === "resolved"
      ? "_No fix needed — issue appears resolved._"
      : "_Not confident enough to call this resolved — needs human review._";
  const risks = (analysis.risks || []).map(r => "- " + r).join("\n") || "- None identified";

  const comment = `## Investigation Complete

**Status:** ${headline}
**Confidence:** ${analysis.confidence || "UNSTATED"}
**Complexity:** ${analysis.complexity}

### Summary
${analysis.summary}

### Evidence
${analysis.evidence}

### Affected Files
${affectedFiles}

### Proposed Approach
${steps}

### Risks
${risks}

---
_Automated investigation by VM Iggy (code-aware, ${route.model}) — searched ${(codeContext.split("###").length - 1)} code locations_`;

  try {
    postComment(comment);
    console.log("Comment posted.");
  } catch (err) {
    console.error("Failed to post comment: " + err.message);
  }

  // 5. Add label (inconclusive verdicts never get investigation-complete)
  //    gh refuses unknown labels, so create it on first use and retry once.
  const addLabel = () => run("bash", ["-lc", 'gh "$@" >/dev/null && echo ok', "gh", "issue", "edit", String(issueNumber), "--repo", repo, "--add-label", label]);
  if (!addLabel()) {
    gh(["label", "create", label, "--repo", repo, "--color", label === "investigation-inconclusive" ? "BFBFBF" : "0E8A16", "--description", "Set by the sprint investigator"]);
    if (!addLabel()) console.error("Failed to add label " + label);
  }

  console.log("Done.");
}

main().catch(err => { console.error(err); process.exit(1); });
