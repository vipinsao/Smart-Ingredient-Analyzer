// tests/imageBounds.test.js - What an upload can make this process do.
//
// The size checks on an upload bound encoded bytes; Tesseract's runtime tracks
// pixels. A 2000x20000 text canvas is 5.46MB on the wire - inside the 8MB cap -
// and received no downscale at all, because targetWidth bounded width only and
// min(2000, 2000) is not a downscale. Measured cost: 126.2s against 11.4s for a
// 2000x1500 label of the same dense text, in the same run.
//
// `npm run bench:bounds` reproduces those figures.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { OCR_PREPROCESS } from "../configuration/constants.js";
import { boundedWidth, preprocessForOcr } from "../services/imagePreprocessor.js";

test("bounding width alone does not bound the work, so area is bounded too", () => {
  const limits = { maxWidth: 2000, maxPixels: 4_000_000 };

  // The shape that got through: the width cap is a no-op on it.
  assert.equal(boundedWidth(2000, 2000, limits), 2000, "the width cap alone would have allowed this");
  const tall = boundedWidth(2000, 20000, limits);
  assert.ok(tall < 2000, `a 2000x20000 image must be downscaled, got width ${tall}`);
  assert.ok(tall * (tall / 2000) * 20000 <= limits.maxPixels + 1, "result must fit the pixel budget");

  // A normal label is untouched: no accuracy is traded for this.
  assert.equal(boundedWidth(1599, 1200, limits), 1599);
  assert.equal(boundedWidth(2000, 1500, limits), 2000);

  // Aspect ratio is preserved rather than the image being cropped or refused.
  assert.equal(boundedWidth(4000, 3000, limits), 2000);
});

test("a tall image is downscaled to the pixel budget before it reaches OCR", async () => {
  const tall = await sharp({
    create: { width: 2000, height: 20000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();

  const processed = await preprocessForOcr(tall);
  const { width, height } = await sharp(processed).metadata();

  assert.ok(
    width * height <= OCR_PREPROCESS.maxPixels,
    `preprocessed image is ${width}x${height} = ${width * height} pixels, over the ${OCR_PREPROCESS.maxPixels} budget`
  );
  // Same shape, smaller: a tall receipt is shrunk, not cropped.
  assert.ok(height > width, "aspect ratio should be preserved");
});

test("the decoded-pixel ceiling is stated in this repo, not inherited from sharp", async () => {
  assert.equal(typeof OCR_PREPROCESS.limitInputPixels, "number");
  assert.ok(OCR_PREPROCESS.limitInputPixels > OCR_PREPROCESS.maxPixels);

  // Something past the ceiling is refused at decode, as a typed error, before
  // any row is processed.
  const huge = await sharp({
    create: { width: 12000, height: 12000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();

  await assert.rejects(
    () => preprocessForOcr(huge, { }),
    (error) => {
      // Its own code and a 413, not the generic "could not be decoded" 400:
      // the image is valid, it is just enormous, and the message has to say so
      // or it sends someone off re-encoding a file that was never corrupt.
      assert.equal(error.code, "IMAGE_TOO_MANY_PIXELS");
      assert.equal(error.statusCode, 413);
      return true;
    },
    "144M pixels is over the 80M ceiling and must be refused"
  );
});
