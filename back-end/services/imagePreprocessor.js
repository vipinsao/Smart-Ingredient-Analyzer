// services/imagePreprocessor.js - Image preparation before OCR.
//
// Two different consumers want two different images:
//
//   prepareForVision()  a vision model reads colour and layout, so it gets a
//                       downscaled but otherwise faithful colour JPEG.
//   preprocessForOcr()  Tesseract is a classical OCR engine working on glyph
//                       shapes. It does better on a downscaled, grayscale,
//                       contrast-normalised, sharpened image than on a large
//                       colour photo, which is what a phone camera produces.
import sharp from "sharp";
import { OCR_PREPROCESS, VISION_PREPROCESS } from "../configuration/constants.js";
import AppError from "../utils/AppError.js";
import logger from "../utils/logger.js";

/**
 * Decode the header of the buffer and return its metadata.
 * Throws a typed error when the bytes are not a decodable image, so an
 * unreadable upload fails here with a clear message instead of silently
 * travelling down the pipeline as an un-processed buffer.
 */
export async function inspectImage(buffer) {
  try {
    const metadata = await sharp(buffer, sharpLimits()).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("missing dimensions");
    }
    return metadata;
  } catch (error) {
    // An image that is perfectly valid but enormous is a different failure from
    // one that is corrupt, and telling someone to "upload a JPG" when they just
    // uploaded a JPG is the kind of message that wastes an afternoon.
    if (/pixel limit/i.test(error.message ?? "")) {
      throw new AppError(
        "That image is too large to process. Please upload a smaller photo.",
        {
          code: "IMAGE_TOO_MANY_PIXELS",
          statusCode: 413,
          details: `over the ${OCR_PREPROCESS.limitInputPixels} pixel ceiling`,
        }
      );
    }
    throw new AppError(
      "Image could not be decoded. Please upload a JPG, PNG or WebP photo.",
      { code: "UNREADABLE_IMAGE", statusCode: 400, details: error.message }
    );
  }
}

/**
 * Options handed to every sharp() constructor in this file.
 *
 * limitInputPixels is stated rather than inherited: sharp's default happens to
 * be sane, but a guarantee that lives only in a dependency's default is a
 * guarantee that can change under a version bump without anything here failing.
 */
function sharpLimits() {
  return { limitInputPixels: OCR_PREPROCESS.limitInputPixels };
}

function targetWidth(originalWidth, maxWidth) {
  // Never upscale: enlarging a small photo invents no new detail and only
  // makes OCR slower.
  return Math.min(originalWidth, maxWidth);
}

/**
 * Width that satisfies BOTH the width cap and the total-pixel cap.
 *
 * Bounding width alone does not bound the work, and the difference is not
 * academic: `targetWidth(2000, 2000)` is 2000, so a 2000x20000 upload was
 * passed to Tesseract at full size and took 126.2s against 11.4s for a normal
 * label. Aspect ratio routed straight around the width cap. Area is what
 * Tesseract's runtime tracks, so area is what has to be capped.
 *
 * Scaling is uniform, so the aspect ratio is preserved and a genuinely tall
 * receipt is shrunk rather than cropped or rejected.
 */
export function boundedWidth(width, height, { maxWidth, maxPixels }) {
  const byWidth = targetWidth(width, maxWidth);
  const pixelsAtThatWidth = (byWidth / width) ** 2 * width * height;
  if (pixelsAtThatWidth <= maxPixels) return Math.max(1, Math.round(byWidth));
  return Math.max(1, Math.floor(byWidth * Math.sqrt(maxPixels / pixelsAtThatWidth)));
}

/**
 * Downscale + re-encode for a vision model. Colour is preserved.
 */
export async function prepareForVision(buffer, { isMobile = false } = {}) {
  const metadata = await inspectImage(buffer);
  const maxWidth = isMobile ? VISION_PREPROCESS.maxWidthMobile : VISION_PREPROCESS.maxWidth;
  const width = boundedWidth(metadata.width, metadata.height, {
    maxWidth,
    maxPixels: OCR_PREPROCESS.maxPixels,
  });

  const output = await sharp(buffer, sharpLimits())
    .resize(width, null, { withoutEnlargement: true, kernel: sharp.kernel.lanczos3 })
    .jpeg({
      quality: isMobile ? VISION_PREPROCESS.qualityMobile : VISION_PREPROCESS.quality,
      mozjpeg: true,
    })
    .toBuffer();

  logger.debug("prepared image for vision model", {
    sourceBytes: buffer.length,
    outputBytes: output.length,
    sourceWidth: metadata.width,
    outputWidth: width,
  });

  return output;
}

/**
 * Prepare an image for classical OCR.
 *
 * Steps, in order and each with a reason:
 *   resize     - a 4000px phone photo costs Tesseract time without adding
 *                legible detail; cap the long edge.
 *   grayscale  - Tesseract binarises internally; colour is noise to it.
 *   normalise  - stretches the histogram so a flat, badly-lit photo regains
 *                separation between ink and paper.
 *   sharpen    - counteracts the softening introduced by downscaling.
 *   png        - lossless, so sharpened glyph edges are not re-blurred by JPEG
 *                block artefacts.
 */
export async function preprocessForOcr(buffer, options = {}) {
  const {
    maxWidth = OCR_PREPROCESS.maxWidth,
    maxPixels = OCR_PREPROCESS.maxPixels,
    compressionLevel = OCR_PREPROCESS.compressionLevel,
    grayscale = true,
    normalise = true,
    sharpen = true,
  } = options;

  const metadata = await inspectImage(buffer);
  const width = boundedWidth(metadata.width, metadata.height, { maxWidth, maxPixels });

  let pipeline = sharp(buffer, sharpLimits()).resize(width, null, {
    withoutEnlargement: true,
    kernel: sharp.kernel.lanczos3,
  });

  // .grayscale() sets the colours to grey; .toColourspace("b-w") is what
  // actually writes a single-channel image, which is both what Tesseract wants
  // and roughly a third of the bytes.
  if (grayscale) pipeline = pipeline.grayscale().toColourspace("b-w");
  if (normalise) pipeline = pipeline.normalise();
  if (sharpen) pipeline = pipeline.sharpen(OCR_PREPROCESS.sharpen);

  const output = await pipeline.png({ compressionLevel }).toBuffer();

  logger.debug("preprocessed image for OCR", {
    sourceBytes: buffer.length,
    outputBytes: output.length,
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    outputWidth: width,
    grayscale,
    normalise,
    sharpen,
  });

  return output;
}

/**
 * Contrast measurement used by the tests to prove that `normalise` actually
 * increases separation between text and background on a low-contrast image.
 */
export async function measureContrast(buffer) {
  const { channels } = await sharp(buffer, sharpLimits()).stats();
  const stdev = channels.reduce((sum, channel) => sum + channel.stdev, 0) / channels.length;
  return stdev;
}

export default { inspectImage, prepareForVision, preprocessForOcr, measureContrast, boundedWidth };
