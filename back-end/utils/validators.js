// utils/validators.js - Request-boundary validation.
//
// Every check returns { valid, error, code } rather than throwing, so the route
// can answer with a specific message and a machine-readable code instead of a
// generic 400.
import { IMAGE_LIMITS, SUPPORTED_IMAGE_SIGNATURES } from "../configuration/constants.js";

const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]*={0,2}$/;

export class Validators {
  static validateRequestBody(req) {
    if (!req.body || typeof req.body !== "object") {
      return { valid: false, error: "No request body", code: "NO_REQUEST_BODY" };
    }
    return { valid: true };
  }

  static validateImage(image) {
    if (!image) {
      return { valid: false, error: "Image is missing", code: "MISSING_IMAGE" };
    }
    if (typeof image !== "string") {
      return {
        valid: false,
        error: "Image must be a base64 string",
        code: "INVALID_IMAGE_FORMAT",
      };
    }
    return { valid: true };
  }

  static validateBase64(base64Data) {
    if (!base64Data) {
      return {
        valid: false,
        error: "No base64 data found in image",
        code: "INVALID_IMAGE_DATA",
      };
    }

    if (!BASE64_PATTERN.test(base64Data)) {
      return {
        valid: false,
        error: "Invalid base64 format",
        code: "INVALID_IMAGE_DATA",
      };
    }

    return { valid: true };
  }

  /**
   * Identify the image format from its leading bytes.
   *
   * The declared MIME type in a data URL is attacker-controlled, so the bytes
   * are what decide. Returns null for anything that is not one of the three
   * formats the UI offers.
   */
  static sniffImageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

    for (const { format, bytes } of SUPPORTED_IMAGE_SIGNATURES) {
      const matches = bytes.every((byte, index) => buffer[index] === byte);
      if (!matches) continue;

      // "RIFF" also fronts WAV and AVI; a WebP additionally carries "WEBP" at
      // offset 8.
      if (format === "webp" && buffer.toString("ascii", 8, 12) !== "WEBP") continue;

      return format;
    }

    return null;
  }

  static validateImageBuffer(buffer) {
    if (!buffer || buffer.length === 0) {
      return { valid: false, error: "Empty image buffer", code: "INVALID_IMAGE_DATA" };
    }

    if (buffer.length > IMAGE_LIMITS.maxSizeBytes) {
      return {
        valid: false,
        error: "Image file too large",
        code: "IMAGE_TOO_LARGE",
        statusCode: 413,
        maxSize: `${Math.round(IMAGE_LIMITS.maxSizeBytes / (1024 * 1024))}MB`,
      };
    }

    if (buffer.length < IMAGE_LIMITS.minSizeBytes) {
      return {
        valid: false,
        error: "Image file too small",
        code: "IMAGE_TOO_SMALL",
        minSize: "1KB",
      };
    }

    const format = Validators.sniffImageType(buffer);
    if (!format) {
      return {
        valid: false,
        error: "Unsupported image format. Please upload a JPG, PNG or WebP photo.",
        code: "UNSUPPORTED_IMAGE_TYPE",
        statusCode: 415,
      };
    }

    return { valid: true, format };
  }

  static validateIngredients(ingredients) {
    if (typeof ingredients !== "string" || ingredients.trim().length < 5) {
      return {
        valid: false,
        error:
          "No ingredient list found in image. Please focus on the ingredients section of the food label.",
        code: "INSUFFICIENT_INGREDIENTS",
      };
    }
    return { valid: true };
  }
}

export default Validators;
