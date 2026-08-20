import React from "react";

const ModeSelection = ({ setMode }) => {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  return (
    <div className="flex flex-col items-center gap-6 px-2 max-w-full">
      <div className="text-center space-y-2">
        <p className="text-gray-700 text-base sm:text-lg font-medium">
          Choose how you'd like to input your product image:
        </p>
        <p className="text-sm text-gray-500">
          Focus on the ingredients section for best results
        </p>
      </div>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full max-w-md">
        <button
          onClick={() => setMode("camera")}
          className="bg-gradient-to-br from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white py-6 sm:py-8 px-6 rounded-2xl transition-all transform hover:scale-105 active:scale-95 shadow-xl cursor-pointer group"
        >
          <div className="space-y-3">
            <div className="text-4xl sm:text-5xl group-hover:scale-110 transition-transform duration-300">
              📷
            </div>
            <div className="space-y-1">
              <div className="font-bold text-lg sm:text-xl">Take Photo</div>
              <div className="text-sm">
                {isMobile ? "Use camera" : "Use webcam"}
              </div>
              <div className="text-xs">
                Real-time capture
              </div>
            </div>
          </div>
        </button>
        
        <button
          onClick={() => setMode("upload")}
          className="bg-gradient-to-br from-green-700 to-green-800 hover:from-green-800 hover:to-green-900 text-white py-6 sm:py-8 px-6 rounded-2xl transition-all transform hover:scale-105 active:scale-95 shadow-xl cursor-pointer group"
        >
          <div className="space-y-3">
            <div className="text-4xl sm:text-5xl group-hover:scale-110 transition-transform duration-300">
              🖼️
            </div>
            <div className="space-y-1">
              <div className="font-bold text-lg sm:text-xl">Upload Image</div>
              <div className="text-sm">
                From gallery
              </div>
              <div className="text-xs">
                Drag & drop support
              </div>
            </div>
          </div>
        </button>
      </div>
      
      {/* Device-specific tips */}
      <div className="bg-gradient-to-r from-blue-50 to-green-50 border border-gray-200 rounded-xl p-4 w-full max-w-md">
        <div className="text-center">
          <p className="text-sm text-gray-700 font-medium mb-2">
            {isMobile ? "📱 Mobile Optimized" : "💻 Desktop Ready"}
          </p>
          <p className="text-xs text-gray-600">
            {isMobile 
              ? "Optimized for mobile cameras and touch interface"
              : "Supports webcam capture and file uploads"
            }
          </p>
        </div>
      </div>
    </div>
  );
};

export default ModeSelection;