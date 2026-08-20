import React, { useState, useEffect, useCallback } from "react";
import Webcam from "react-webcam";

// Enhanced capture settings for better OCR
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1080;
const CAPTURE_QUALITY = 0.95; // Higher quality for better OCR

const WebcamCapture = ({ webcamRef, onCapture, onBack }) => {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState(null);
  const [facingMode, setFacingMode] = useState("environment");
  const [showGuides, setShowGuides] = useState(true);

  // Updated video constraints to use fixed capture size
  const getVideoConstraints = useCallback(() => {
    return {
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      facingMode: { ideal: facingMode },
      aspectRatio: { ideal: 16 / 9, min: 1.3, max: 2.0 },
      frameRate: { ideal: 15, max: 30 }, // Lower framerate for better quality
      focusMode: { ideal: "continuous" },
      exposureMode: { ideal: "continuous" },
      whiteBalanceMode: { ideal: "continuous" },
    };
  }, [facingMode]);

  const handleUserMedia = useCallback(() => {
    setIsReady(true);
    setError(null);
  }, []);

  const handleUserMediaError = useCallback((error) => {
    console.error("Camera error:", error);
    setError("Camera access denied or not available");
    setIsReady(false);
  }, []);

  // Enhanced capture handler with high quality settings
  const handleCapture = useCallback(() => {
    try {
      // Capture with maximum quality and full resolution
      const imageSrc = webcamRef.current?.getScreenshot({
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        quality: CAPTURE_QUALITY,
      });
      if (imageSrc) {
        onCapture(imageSrc);
      } else {
        setError("Unable to capture image. Please try again.");
      }
    } catch (error) {
      console.error("Capture error:", error);
      setError("Failed to capture image. Please try again.");
    }
  }, [webcamRef, onCapture]);

  const switchCamera = useCallback(() => {
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
  }, []);

  // Clear error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  return (
    <div className="space-y-4 sm:space-y-6 max-w-full">
      {/* Enhanced camera container */}
      <div className="bg-gray-900 rounded-xl sm:rounded-2xl shadow-2xl overflow-hidden relative max-w-4xl mx-auto">
        <div className="relative bg-black" style={{ aspectRatio: "16/9" }}>
          {!error ? (
            <Webcam
              ref={webcamRef}
              audio={false}
              screenshotFormat="image/jpeg"
              screenshotQuality={1}
              width={CAPTURE_WIDTH}
              height={CAPTURE_HEIGHT}
              videoConstraints={getVideoConstraints()}
              onUserMedia={handleUserMedia}
              onUserMediaError={handleUserMediaError}
              className="absolute inset-0 w-full h-full object-cover rounded-xl"
              mirrored={facingMode === "user"}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
              <div className="text-center text-white p-6">
                <div className="text-4xl mb-4">📷</div>
                <p className="text-lg font-medium mb-2">Camera Error</p>
                <p className="text-sm opacity-75">{error}</p>
                <button
                  onClick={() => window.location.reload()}
                  className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Simplified overlay guides - only show when needed */}
          {isReady && !error && showGuides && (
            <div className="absolute inset-0 pointer-events-none z-10">
              {/* Simple center guide */}
              <div className="absolute top-4 left-1/2 transform -translate-x-1/2">
                <div className="bg-black/60 text-white px-4 py-2 rounded-lg text-sm font-medium backdrop-blur-sm">
                  📋 Focus on ingredients
                </div>
              </div>

              {/* Simple focus frame */}
              <div className="absolute inset-x-8 inset-y-16 border-2 border-dashed border-green-400 opacity-50 rounded-lg">
                <div className="absolute -top-6 left-1/2 transform -translate-x-1/2 bg-green-400 text-black px-2 py-1 rounded text-xs font-medium">
                  INGREDIENTS
                </div>
              </div>
            </div>
          )}

          {/* Loading indicator */}
          {!isReady && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
              <div className="text-center text-white">
                <div className="animate-spin w-8 h-8 border-3 border-white border-t-transparent rounded-full mx-auto mb-4"></div>
                <p className="text-sm">Loading camera...</p>
              </div>
            </div>
          )}

          {/* Toggle guides button */}
          {isReady && !error && (
            <button
              onClick={() => setShowGuides(!showGuides)}
              className="absolute top-4 right-4 bg-black/60 text-white px-3 py-2 rounded-lg text-xs font-medium backdrop-blur-sm hover:bg-black/80 transition-all z-20"
            >
              {showGuides ? "👁️ Hide guides" : "📋 Show guides"}
            </button>
          )}
        </div>
      </div>

      {/* Enhanced button controls */}
      <div className="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4 px-2">
        <button
          onClick={handleCapture}
          disabled={!isReady || error}
          className="flex items-center justify-center gap-3 bg-blue-600 text-white px-8 py-4 sm:px-6 sm:py-3 rounded-xl font-semibold shadow-lg cursor-pointer hover:bg-blue-700 transition-all transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none text-base sm:text-sm"
        >
          <span className="text-xl sm:text-lg">📸</span>
          <span>Capture Photo</span>
        </button>

        {/* Camera switch button for mobile */}
        <button
          onClick={switchCamera}
          disabled={!isReady || error}
          className="flex items-center justify-center gap-2 bg-gray-600 text-white px-6 py-4 sm:px-4 sm:py-3 rounded-xl font-medium shadow-md cursor-pointer hover:bg-gray-700 transition-all transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
        >
          <span className="text-lg sm:text-base">🔄</span>
          <span>Switch</span>
        </button>

        <button
          onClick={onBack}
          className="flex items-center justify-center gap-3 border-2 border-red-300 text-red-600 px-8 py-4 sm:px-6 sm:py-3 rounded-xl font-semibold shadow-sm cursor-pointer hover:bg-red-50 transition-all transform hover:scale-105 active:scale-95 text-base sm:text-sm"
        >
          <span className="text-xl sm:text-lg">🔙</span>
          <span>Back</span>
        </button>
      </div>

      {/* Simplified tips */}
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 mx-2">
        <div className="text-center">
          <p className="text-sm text-green-800 font-medium mb-2">
            📱 <strong>Capture Tips:</strong>
          </p>
          <div className="text-xs text-green-700 space-y-1">
            <p>• Hold device steady and ensure good lighting</p>
            <p>• Ensure bright, even lighting without shadows</p>
            <p>• Focus on ingredients section only</p>
            <p>• Avoid glare and ensure text is readable</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WebcamCapture;
