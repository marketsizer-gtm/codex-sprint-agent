import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGatewayBody,
  decideVerdict,
  parseIssueNumber,
  shouldUseGateway,
  validateDispatch,
} from "../lib.mjs";

test("Likely Resolved only when not present AND HIGH confidence", () => {
  assert.equal(decideVerdict({ still_exists: false, confidence: "HIGH" }).verdict, "resolved");
  assert.equal(decideVerdict({ still_exists: false, confidence: "high" }).label, "investigation-complete");
});

test("MEDIUM / LOW / missing confidence is inconclusive, never investigation-complete", () => {
  for (const confidence of ["MEDIUM", "LOW", undefined, ""]) {
    const v = decideVerdict({ still_exists: false, confidence });
    assert.equal(v.verdict, "inconclusive");
    assert.equal(v.headline, "⚪ Inconclusive");
    assert.equal(v.label, "investigation-inconclusive");
  }
});

test("non-boolean still_exists is inconclusive", () => {
  assert.equal(decideVerdict({ still_exists: "false", confidence: "HIGH" }).verdict, "inconclusive");
  assert.equal(decideVerdict({}).verdict, "inconclusive");
  assert.equal(decideVerdict(null).verdict, "inconclusive");
});

test("Still Present unchanged at any confidence", () => {
  for (const confidence of ["HIGH", "LOW", undefined]) {
    const v = decideVerdict({ still_exists: true, confidence });
    assert.equal(v.headline, "🔴 Still Present");
    assert.equal(v.label, "investigation-complete");
  }
});

test("issue number must be a positive integer", () => {
  assert.equal(parseIssueNumber(42), 42);
  assert.equal(parseIssueNumber("42"), 42);
  for (const bad of [0, -1, "1; rm -rf /", "1 --repo x", "01", 1.5, "", null, undefined]) {
    assert.equal(parseIssueNumber(bad), null, String(bad));
  }
});

test("dispatch validates repo against allow-list", () => {
  assert.deepEqual(validateDispatch({ repo: "marketsizer-gtm/ms-web-app-project", number: "7" }),
    { ok: true, repo: "marketsizer-gtm/ms-web-app-project", number: 7 });
  assert.equal(validateDispatch({ repo: "evil/repo", number: 1 }).ok, false);
  assert.equal(validateDispatch({ repo: "marketsizer-gtm/ms-web-app-project'; id #", number: 1 }).ok, false);
  assert.equal(validateDispatch({ repo: "toString", number: 1 }).ok, false);
  assert.equal(validateDispatch({ repo: "marketsizer-gtm/ms-web-app-project", number: "1;id" }).ok, false);
});

test("gateway only when both secrets are set", () => {
  assert.equal(shouldUseGateway({}), false);
  assert.equal(shouldUseGateway({ INTERNAL_AI_SECRET: "x" }), false);
  assert.equal(shouldUseGateway({ IGGY_GATEWAY_API_KEY: "y" }), false);
  assert.equal(shouldUseGateway({ INTERNAL_AI_SECRET: "x", IGGY_GATEWAY_API_KEY: "y" }), true);
});

test("gateway body: gpt-6 gets reasoning_effort none and no temperature", () => {
  const b = buildGatewayBody({ model: "gpt-6-sol-us", maxTokens: 3000, temperature: 0.2 }, []);
  assert.equal(b.reasoning_effort, "none");
  assert.equal("temperature" in b, false);
  assert.equal(b.max_completion_tokens, 3000);
  assert.equal(b.user, "sprint-investigator");
  assert.deepEqual(b.metadata, { tags: ["sprint-investigator"] });
  assert.deepEqual(b.response_format, { type: "json_object" });
});

test("gateway body: gpt-5 omits temperature, no reasoning_effort; others keep temperature", () => {
  const g5 = buildGatewayBody({ model: "gpt-5.4-mini", temperature: 0.2 }, []);
  assert.equal("temperature" in g5, false);
  assert.equal("reasoning_effort" in g5, false);
  assert.equal(g5.max_completion_tokens, 2000);
  const other = buildGatewayBody({ model: "claude-sonnet", temperature: 0.2 }, []);
  assert.equal(other.temperature, 0.2);
});
