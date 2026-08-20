import React, { useState, useCallback } from "react";
import { validateImageFile, detectDeviceCapabilities } from "../utils/imageUtils";

const ImageUploader = ({ handleUpload, onBack }) => {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const capabilities = detectDeviceCapabilities();

  const processFile = useCallback(async (file) => {
    try {
      setUploading(true);
      validateImageFile(file);
      
      // Create synthetic event for handleUpload
      const syntheticEvent = {
        target: { files: [file] }
      };
      
      await handleUpload(syntheticEvent);
    } catch (error) {
      alert(error.message);
    } finally {
      setUploading(false);
    }
  }, [handleUpload]);

  const handleFileSelect = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await processFile(file);
  }, [processFile]);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragOver(false);
    
    const file = e.dataTransfer.files[0];
    if (!file) return;
    
    await processFile(file);
  }, [processFile]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const maxSizeMB = capabilities.isMobile ? 8 : 10;

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-6 px-2 max-w-full">
      <div className="w-full max-w-lg relative">
        <div 
          className={`border-3 border-dashed rounded-2xl p-8 sm:p-12 text-center transition-all duration-300 relative min-h-[200px] flex flex-col justify-center ${
            dragOver 
              ? 'border-green-500 bg-green-50 scale-105' 
              : uploading 
                ? 'border-blue-500 bg-blue-50' 
                : 'border-gray-300 hover:border-green-400 hover:bg-gray-50 hover:scale-102'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="space-y-4 sm:space-y-6">
            <div className={`text-5xl sm:text-6xl transition-all duration-300 ${
              dragOver ? 'scale-125 animate-bounce' : uploading ? 'animate-pulse' : 'hover:scale-110'
            }`}>
              {uploading ? '⏳' : dragOver ? '📥' : '📁'}
            </div>
            
            <div className="space-y-2">
              <p className="text-gray-800 font-semibold text-lg sm:text-xl">
                {uploading ? 'Processing Image...' : dragOver ? 'Drop Image Here' : 'Upload Food Label'}
              </p>
              <p className="text-sm sm:text-base text-gray-600">
                {uploading ? 'Please wait...' : 'Click to select or drag & drop'}
              </p>
              <p className="text-xs text-gray-500">
                Supports JPG, PNG, WebP • Max {maxSizeMB}MB
              </p>
            </div>

            {/* Progress indicator for uploading */}
            {uploading && (
              <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
                <div className="bg-blue-600 h-2 rounded-full animate-pulse w-3/4"></div>
              </div>
            )}
          </div>
          
          {/* File input */}
          <input
            type="file"
            aria-label="Upload a photo of a food label"
            accept="image/jpeg,image/jpg,image/png,image/webp"
            onChange={handleFileSelect}
            disabled={uploading}
            className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* Enhanced action buttons */}
      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-lg">
        <button
          onClick={onBack}
          disabled={uploading}
          className="flex items-center justify-center gap-3 border-2 border-red-300 text-red-600 px-8 py-4 sm:px-6 sm:py-3 rounded-xl font-semibold shadow-sm cursor-pointer hover:bg-red-50 transition-all transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none text-base sm:text-sm"
        >
          <span className="text-xl sm:text-lg">🔙</span>
          <span>Back</span>
        </button>
      </div>
      
      {/* Enhanced mobile-specific tips */}
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 w-full max-w-lg">
        <div className="text-center">
          <p className="text-sm text-green-800 font-semibold mb-2">
            💡 <strong>Best Results Tips:</strong>
          </p>
          <div className="text-xs text-green-700 space-y-1 text-left">
            <p>✓ Clear, well-lit photos of ingredient labels</p>
            <p>✓ Avoid shadows, glare, and blurry images</p>
            <p>✓ Focus only on the ingredients section</p>
            <p>✓ Ensure text is readable and not cut off</p>
            {capabilities.isMobile && (
              <p>✓ Hold phone steady when taking photos</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageUploader;