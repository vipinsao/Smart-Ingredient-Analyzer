import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Validators from "../utils/validators.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleLabel = fs.readFileSync(path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg"));

test("sniffImageType identifies a real JPEG by its magic bytes", () => {
  assert.equal(Validators.sniffImageType(sampleLabel), "jpeg");
});

test("sniffImageType identifies PNG and WebP, and rejects a RIFF file that is not WebP", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.equal(Validators.sniffImageType(png), "png");

  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  assert.equal(Validators.sniffImageType(webp), "webp");

  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
  assert.equal(Validators.sniffImageType(wav), null);
});

test("validateImageBuffer rejects a non-image payload with a 415", () => {
  const notAnImage = Buffer.from("#!/bin/sh\nrm -rf /\n".repeat(200));
  const result = Validators.validateImageBuffer(notAnImage);

  assert.equal(result.valid, false);
  assert.equal(result.code, "UNSUPPORTED_IMAGE_TYPE");
  assert.equal(result.statusCode, 415);
});

test("validateImageBuffer accepts a real label photo and reports its format", () => {
  assert.deepEqual(Validators.validateImageBuffer(sampleLabel), { valid: true, format: "jpeg" });
});

test("validateImageBuffer rejects an oversized buffer with a 413", () => {
  const oversized = Buffer.alloc(9 * 1024 * 1024, 0xff);
  const result = Validators.validateImageBuffer(oversized);

  assert.equal(result.code, "IMAGE_TOO_LARGE");
  assert.equal(result.statusCode, 413);
});

test("validateBase64 rejects characters that cannot appear in base64", () => {
  assert.equal(Validators.validateBase64("aGVsbG8=").valid, true);
  assert.equal(Validators.validateBase64("data:image/jpeg;base64,AAAA").valid, false);
  assert.equal(Validators.validateBase64("").valid, false);
});

test("validateIngredients rejects a string too short to be an ingredient list", () => {
  assert.equal(Validators.validateIngredients("Milk, water, sugar").valid, true);
  assert.equal(Validators.validateIngredients("ab").code, "INSUFFICIENT_INGREDIENTS");
  assert.equal(Validators.validateIngredients(null).code, "INSUFFICIENT_INGREDIENTS");
});
