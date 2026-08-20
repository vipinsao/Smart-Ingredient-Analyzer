// tests/env.test.js - Configuration that fails dangerously when it is wrong.
//
// `trust proxy: 1` looks cautious and is not: it reads req.ip out of a header
// the client controls, whether or not a proxy set it. This pins the safe
// default rather than the happy path.
import test from "node:test";
import assert from "node:assert/strict";

import { parseTrustProxy } from "../configuration/env.js";

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
