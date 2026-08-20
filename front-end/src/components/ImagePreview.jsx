import React from "react";
import ProcessingStatus from "./ProcessingStatus";

const ImagePreview = ({
  imageSrc,
  onAnalyze,
  onReset,
  processingState,
  analysisReady,
}) => {
  const { isProcessing, status, progress, ocrText, startedAt } = processingState;

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-6 px-2 max-w-full">
      {/* Enhanced image preview */}
      <div className="relative w-full max-w-md">
        <div className="relative rounded-2xl overflow-hidden shadow-2xl bg-white p-2">
          <img
            src={imageSrc}
            alt="Preview"
            className="rounded-xl w-full h-auto object-cover max-h-96"
          />
          
          {/* Status indicators */}
          {analysisReady && (
            <div className="absolute -top-2 -right-2 bg-green-500 text-white px-3 py-1 rounded-full text-xs font-bold animate-bounce shadow-lg z-10">
              ✓ Ready!
            </div>
          )}
          
          {isProcessing && (
            <div className="absolute inset-2 bg-black bg-opacity-40 rounded-xl flex items-center justify-center backdrop-blur-sm">
              <div className="bg-white rounded-xl p-4 shadow-xl">
                <div className="animate-spin w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full mx-auto mb-2"></div>
                <p className="text-sm font-medium text-gray-700">Processing...</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Processing status */}
      {isProcessing && (
        <ProcessingStatus
          status={status}
          progress={progress}
          ocrText={ocrText}
          startedAt={startedAt}
        />
      )}

      {/* Enhanced action buttons */}
      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
        <button
          onClick={onAnalyze}
          disabled={isProcessing && !analysisReady}
          className={`flex-1 py-4 px-6 rounded-xl font-bold transition-all transform text-base ${
            analysisReady
              ? "bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-xl hover:scale-105 animate-pulse active:scale-95"
              : isProcessing
              ? "bg-gray-400 text-gray-200 cursor-not-allowed opacity-75"
              : "bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-lg hover:scale-105 active:scale-95"
          } cursor-pointer`}
        >
          {isProcessing && !analysisReady
            ? "Processing..."
            : analysisReady
            ? "🚀 View Results"
            : "🧪 Analyze Ingredients"}
        </button>

        <button
          onClick={onReset}
          className="flex items-center justify-center gap-2 border-2 border-red-300 text-red-600 px-6 py-4 sm:py-3 rounded-xl hover:bg-red-50 transition-all cursor-pointer transform hover:scale-105 active:scale-95 font-semibold text-base sm:text-sm"
        >
          <span className="text-lg">🔁</span>
          <span>Retake</span>
        </button>
      </div>
      
      {/* Image info */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 w-full max-w-md">
        <div className="text-center">
          <p className="text-xs text-gray-600">
            📊 Image ready for analysis
          </p>
          {analysisReady && (
            <p className="text-xs text-green-600 font-medium mt-1">
              ✅ Background processing complete
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ImagePreview;