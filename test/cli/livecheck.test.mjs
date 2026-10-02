import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classify } from "../../cli/lib/livecheck.mjs";

test("T-SET-6: each failure class maps to its detail; unknown → unknown", () => {
  assert.equal(classify("spawn codex ENOENT"), "codex_missing");
  assert.equal(classify("Error: Not logged in. Run codex login"), "codex_auth");
  assert.equal(classify("401 Unauthorized"), "codex_auth");
  assert.equal(classify("model 'not-a-real-model' does not exist or you do not have access"), "model_invalid");
  assert.equal(classify("unknown variant `turbo`, expected one of minimal, low, medium, high for model_reasoning_effort"), "effort_invalid");
  assert.equal(classify("[plugin_pin_mismatch] companion changed"), "pin_mismatch");
  assert.equal(classify("[codex_timeout] exceeded 15 minutes"), "timeout");
  assert.equal(classify("[codex_output_invalid] could not parse"), "unparseable");
  assert.equal(classify("something new"), "unknown");
});

test("T-SET-6: real Codex error lines (codex-cli 0.159.0, companion 1.0.6, signed-out CODEX_HOME; captured 2026-09-30)", () => {
  // `codex exec` and the companion's parseError print this line, then ", cf-ray: …, request id: …", cut here.
  assert.equal(classify("ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"), "codex_auth");
  assert.equal(classify("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"), "codex_auth");
  assert.equal(classify("Not logged in"), "codex_auth"); // `codex login status`
  assert.equal(classify('"key": "0a4019853f", "label": "spec /tmp/rl-live-401abc/x.md", "message": "boom"'), "unknown", "a 401 inside a hex key or path is not an auth failure");
  assert.equal(classify("codex_failed: codex companion exited 1 in /tmp/rl-e2e-401-x"), "unknown", "a temp path with a 401 segment is not an auth failure");
  assert.equal(classify(JSON.parse(fs.readFileSync(new URL("../fixtures/companion-1.0.6-signed-out.json", import.meta.url), "utf8")).parseError), "codex_auth", "the captured 1.0.6 parseError");
  assert.equal(classify("ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses"), "codex_auth"); // `codex exec`, real
  assert.equal(classify("HTTP 401"), "codex_auth");
  assert.equal(classify("status code: 401"), "codex_auth");
});
