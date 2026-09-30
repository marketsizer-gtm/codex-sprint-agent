// Pure helpers shared by server.mjs and investigate.mjs. No I/O here, so
// everything in this file is unit-tested by test/lib.test.mjs.

export const AGENT_ID = "sprint-investigator";

// Map repo to local clone path on VM. Doubles as the dispatch allow-list:
// server.mjs refuses any repo not listed here.
export const REPO_PATHS = {
  "marketsizer-gtm/ms-web-app-project": "/home/niall/repos/ms-web-app-project",
  "marketsizer-gtm/marketsizer-enrich-api": "/home/niall/repos/marketsizer-enrich-api",
  "marketsizer-gtm/ms-sidebar-project": "/home/niall/repos/ms-sidebar-project",
  "marketsizer-gtm/ms-insights-platform": "/home/niall/repos/ms-insights-platform",
  "marketsizer-gtm/ms-internal-docs": "/home/niall/repos/ms-internal-docs",
};

export const DEFAULT_APP_BASE_URL = "https://app.marketsizer.io";
export const DEFAULT_GATEWAY_BASE_URL =
  "https://ms-llm-gateway-app.bluecliff-a2028f6c.uksouth.azurecontainerapps.io";

/** Positive integer (number or all-digit string) → number, otherwise null. */
export function parseIssueNumber(value) {
  const s = String(value ?? "");
  if (!/^[1-9]\d{0,8}$/.test(s)) return null;
  return Number(s);
}

/** Validate a dispatch request item. Returns { ok, repo, number } or { ok:false, error }. */
export function validateDispatch(item) {
  const repo = item?.repo;
  if (typeof repo !== "string" || !Object.hasOwn(REPO_PATHS, repo)) {
    return { ok: false, error: "repo not in allow-list: " + String(repo) };
  }
  const number = parseIssueNumber(item?.number);
  if (number === null) {
    return { ok: false, error: "number must be a positive integer: " + String(item?.number) };
  }
  return { ok: true, repo, number };
}

/**
 * Verdict for an investigation. Mirrors ms-web-app-project
 * app-code/lib/admin/investigation-verdict.ts: "Likely Resolved" requires
 * still_exists === false AND HIGH confidence. Anything weaker (MEDIUM, LOW,
 * missing confidence, non-boolean still_exists) is inconclusive and must not
 * be labelled investigation-complete — absence of evidence is not evidence of
 * absence (ms-web-app-project#2863 / #2864).
 */
export function decideVerdict(analysis) {
  const confidence = String(analysis?.confidence ?? "").toUpperCase();
  if (analysis?.still_exists === true) {
    return { verdict: "present", headline: "🔴 Still Present", label: "investigation-complete" };
  }
  if (analysis?.still_exists === false && confidence === "HIGH") {
    return { verdict: "resolved", headline: "✅ Likely Resolved", label: "investigation-complete" };
  }
  return { verdict: "inconclusive", headline: "⚪ Inconclusive", label: "investigation-inconclusive" };
}

/** Gateway path needs both the app secret (config + usage) and a gateway key. */
export function shouldUseGateway(env) {
  return Boolean(env.INTERNAL_AI_SECRET && env.IGGY_GATEWAY_API_KEY);
}

/** Reasoning-family models reject temperature. */
export function isReasoningModel(model) {
  return /^gpt-(5|6)/i.test(String(model || ""));
}

/** OpenAI-compatible request body for the Iggy gateway. */
export function buildGatewayBody(config, messages) {
  const model = config.model;
  const body = {
    model,
    messages,
    response_format: { type: "json_object" },
    max_completion_tokens: config.maxTokens || 2000,
    user: AGENT_ID,
    metadata: { tags: [AGENT_ID] },
  };
  if (/^gpt-6/i.test(model)) body.reasoning_effort = "none";
  if (!isReasoningModel(model) && typeof config.temperature === "number") {
    body.temperature = config.temperature;
  }
  return body;
}
