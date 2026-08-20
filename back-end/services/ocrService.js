// services/ocrService.js - OCR Service (Optional Reference)
// This is a service wrapper - the actual OCR functions are in optimized-ocr.js

import {
  performSmartOCR,
  ultraFastPreprocess,
  preprocessImage,
  performOCRWithMultipleVersions,
} from "../optimized-ocr.js";

export class OCRService {
  async processImage(imageBuffer, options = {}) {
    const { isMobile = false, fastMode = true } = options;

    try {
      let result;

      if (fastMode) {
        // Ultra-fast preprocessing for mobile and fast mode
        const processedBuffer = await ultraFastPreprocess(
          imageBuffer,
          isMobile
        );
        result = await performSmartOCR(processedBuffer);
      } else {
        // Standard preprocessing for better accuracy
        const processedImages = await preprocessImage(imageBuffer);
        result = await performOCRWithMultipleVersions(processedImages);
      }

      return {
        success: true,
        text: result.text,
        confidence: result.confidence,
        method: result.method,
        processingTime: result.processingTime,
      };
    } catch (error) {
      console.error("❌ OCR Service Error:", error.message);
      throw error;
    }
  }

  async smartOCR(imageBuffer) {
    try {
      const result = await performSmartOCR(imageBuffer);
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      console.error("❌ Smart OCR Error:", error.message);
      throw error;
    }
  }

  async fastPreprocess(imageBuffer, isMobile = false) {
    try {
      return await ultraFastPreprocess(imageBuffer, isMobile);
    } catch (error) {
      console.error("❌ Fast Preprocess Error:", error.message);
      throw error;
    }
  }
}

export default new OCRService();
