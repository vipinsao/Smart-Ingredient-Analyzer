// Enhanced image utilities with perfect mobile optimization

export const detectDeviceCapabilities = () => {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isSlowConnection = navigator.connection && 
    (navigator.connection.effectiveType === 'slow-2g' || 
     navigator.connection.effectiveType === '2g' ||
     navigator.connection.saveData);
  
  const deviceMemory = navigator.deviceMemory || 4; // Default to 4GB if not available
  const isLowEndDevice = deviceMemory < 4;
  
  // Detect screen size
  const isSmallScreen = window.innerWidth < 768;
  
  return {
    isMobile,
    isSlowConnection,
    isLowEndDevice,
    isSmallScreen,
    // High quality settings for better OCR
    quality: isSlowConnection ? 0.9 : 0.95, // Higher quality across all devices
    maxWidth: isSlowConnection ? 1600 : isMobile ? 2000 : 2400, // Higher resolution
    fastMode: isMobile || isSlowConnection || isLowEndDevice,
    deviceMemory,
    connectionType: navigator.connection?.effectiveType || 'unknown'
  };
};

export const compressImage = (file, quality = 0.8, maxWidth = 1200) => {
  return new Promise((resolve, reject) => {
    try {
      console.log(`🖼️ Starting image compression: quality=${quality}, maxWidth=${maxWidth}`);
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();
      
      img.onload = () => {
        try {
          // Calculate optimal dimensions
          let { width, height } = img;
          console.log(`📐 Original dimensions: ${width}x${height}`);
          
          // Maintain high resolution for better OCR
          // Only resize if image is very large (over 3000px)
          const maxOCRWidth = Math.max(maxWidth, 2400); // Minimum 2400px for OCR
          if (width > 3000) {
            height = (height * maxOCRWidth) / width;
            width = maxOCRWidth;
          }
          
          // Ensure minimum size for OCR readability
          const minWidth = 1200; // Higher minimum for better text recognition
          if (width < minWidth) {
            height = (height * minWidth) / width;
            width = minWidth;
          }
          
          console.log(`📐 Final dimensions: ${width}x${height}`);
          
          canvas.width = width;
          canvas.height = height;
          
          // High quality rendering
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          
          // Draw image
          ctx.drawImage(img, 0, 0, width, height);
          
          // Colour and detail are deliberately preserved here. The OCR-specific
          // transforms (grayscale, contrast normalisation, sharpening) run on
          // the server in back-end/services/imagePreprocessor.js, where they
          // can be tuned per OCR engine.
          const ocrQuality = Math.max(quality, 0.95);
          const compressedDataUrl = canvas.toDataURL('image/jpeg', ocrQuality);

          console.log(`📊 Image processed: ${width}x${height}, quality=${ocrQuality}`);
          
          resolve(compressedDataUrl);
        } catch (error) {
          console.error('Canvas processing error:', error);
          reject(error);
        }
      };
      
      img.onerror = () => {
        reject(new Error('Failed to load image'));
      };
      
      img.src = file;
    } catch (error) {
      reject(error);
    }
  });
};

export const validateImageFile = (file) => {
  const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const capabilities = detectDeviceCapabilities();
  const maxSize = capabilities.isMobile ? 8 * 1024 * 1024 : 10 * 1024 * 1024; // 8MB mobile, 10MB desktop
  
  if (!validTypes.includes(file.type)) {
    throw new Error('Please select a valid image file (JPG, PNG, WebP)');
  }
  
  if (file.size > maxSize) {
    const maxSizeMB = Math.round(maxSize / (1024 * 1024));
    throw new Error(`Image file is too large. Please select an image under ${maxSizeMB}MB.`);
  }
  
  return true;
};

export const preloadImage = (src) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
};

// Enhanced image optimization for different scenarios
export const optimizeForOCR = async (imageData) => {
  const capabilities = detectDeviceCapabilities();
  
  // Use different optimization strategies based on device
  const settings = {
    quality: capabilities.isSlowConnection ? 0.7 : 0.85,
    maxWidth: capabilities.isMobile ? 1000 : 1200,
    enhanceContrast: true,
    sharpen: !capabilities.isLowEndDevice
  };
  
  return await compressImage(imageData, settings.quality, settings.maxWidth);
};