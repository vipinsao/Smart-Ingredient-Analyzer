// services/ocrService.js - The single entry point the route uses for OCR.
//
// Keeps engine selection and preprocessing out of the HTTP layer.
import { performSmartOCR } from "../optimized-ocr.js";

export class OCRService {
  /**
   * @param {Buffer} imageBuffer decoded, already validated image bytes
   * @param {{isMobile?: boolean}} options
   * @returns {Promise<{text: string, confidence: number, method: string, processingTime: number, preprocessMs: number}>}
   */
  async processImage(imageBuffer, options = {}) {
    const { isMobile = false } = options;
    const result = await performSmartOCR(imageBuffer, { isMobile });

    return {
      text: result.text,
      confidence: result.confidence,
      method: result.method,
      processingTime: result.processingTime,
      preprocessMs: result.preprocessMs,
    };
  }
}

export default new OCRService();
