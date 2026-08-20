import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  inspectImage,
  preprocessForOcr,
  prepareForVision,
  measureContrast,
} from "../services/imagePreprocessor.js";

/** A deliberately low-contrast, oversized "photo": grey text on grey paper. */
async function lowContrastLabel({ width = 3200, height = 1600 } = {}) {
  const svg = `<svg width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#8a8a8a"/>
      <text x="60" y="${height / 2}" font-size="${Math.round(height / 8)}" fill="#7a7a7a">
        INGREDIENTS: WATER, SUGAR, SALT
      </text>
    </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

test("inspectImage returns dimensions for a real image", async () => {
  const metadata = await inspectImage(await lowContrastLabel({ width: 800, height: 400 }));
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 400);
});

test("inspectImage rejects bytes that are not a decodable image", async () => {
  await assert.rejects(
    () => inspectImage(Buffer.from("this is a text file, not a photo")),
    (error) => error.code === "UNREADABLE_IMAGE" && error.statusCode === 400
  );
});

test("preprocessForOcr converts to single-channel grayscale", async () => {
  const output = await preprocessForOcr(await lowContrastLabel({ width: 900, height: 400 }));
  const metadata = await sharp(output).metadata();

  assert.equal(metadata.channels, 1, "Tesseract binarises internally; colour is only noise to it");
});

test("preprocessForOcr raises contrast on a flat, badly-lit photo", async () => {
  const source = await lowContrastLabel({ width: 900, height: 400 });
  const before = await measureContrast(source);
  const after = await measureContrast(await preprocessForOcr(source));

  assert.ok(
    after > before * 1.5,
    `expected normalise to stretch the histogram, got ${before.toFixed(2)} -> ${after.toFixed(2)}`
  );
});

test("preprocessForOcr downscales an oversized photo and keeps the aspect ratio", async () => {
  const source = await lowContrastLabel({ width: 3200, height: 1600 });
  const metadata = await sharp(await preprocessForOcr(source, { maxWidth: 2000 })).metadata();

  assert.equal(metadata.width, 2000);
  assert.equal(metadata.height, 1000);
});

test("preprocessForOcr never upscales a small photo", async () => {
  const source = await lowContrastLabel({ width: 640, height: 320 });
  const metadata = await sharp(await preprocessForOcr(source, { maxWidth: 2000 })).metadata();

  assert.equal(metadata.width, 640, "enlarging invents no detail and only costs OCR time");
});

test("prepareForVision keeps colour and produces a smaller JPEG", async () => {
  const source = await lowContrastLabel({ width: 3200, height: 1600 });
  const output = await prepareForVision(source);
  const metadata = await sharp(output).metadata();

  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.channels, 3, "a vision model reads colour, so it is preserved");
  assert.ok(metadata.width <= 2400);
});
