// tests/env.test.js - The two configuration decisions that fail dangerously.
//
// Both of these were wrong in the same direction: a value that looked cautious
// and was not. `trust proxy: 1` reads req.ip out of a header the client
// controls, and `NODE_ENV !== "production"` treats every unrecognised value as
// a development box. Each test pins the safe default rather than the happy path.
import test from "node:test";
import assert from "node:assert/strict";

import { parseTrustProxy, isProductionEnv } from "../configuration/env.js";

test("trust proxy defaults to trusting nothing, and refuses the unsafe values", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("false"), false);
  // "true" trusts every hop, so a client can name its own address.
  assert.equal(parseTrustProxy("true"), false);
  assert.equal(parseTrustProxy("yes"), false);
  // A hop count is the supported way to opt in.
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("2"), 2);
  assert.deepEqual(parseTrustProxy("10.0.0.1, 10.0.0.2"), ["10.0.0.1", "10.0.0.2"]);
});

test("any unrecognised NODE_ENV is treated as production", () => {
  assert.equal(isProductionEnv("development"), false);
  assert.equal(isProductionEnv("test"), false);
  assert.equal(isProductionEnv("production"), true);
  // The values that used to leak internal error detail.
  assert.equal(isProductionEnv("prod"), true);
  assert.equal(isProductionEnv("Production"), true);
  assert.equal(isProductionEnv("staging"), true);
  assert.equal(isProductionEnv(""), true);
  assert.equal(isProductionEnv(undefined), true);
});
