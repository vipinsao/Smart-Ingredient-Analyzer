import React from "react";

const HowItWorks = () => {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  return (
    <div className="text-gray-700 bg-gradient-to-br from-blue-50 via-white to-green-50 p-4 sm:p-6 rounded-2xl shadow-lg border border-gray-100 space-y-4 sm:space-y-6 mx-2 max-w-full">
      <h2 className="text-xl sm:text-2xl font-bold text-blue-800 text-center flex items-center justify-center gap-3">
        <span className="text-2xl">📋</span>
        How It Works
      </h2>
      
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 text-center">
        <div className="space-y-3 p-4 bg-white rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
          <div className="text-4xl sm:text-5xl mb-2">📷</div>
          <h3 className="font-bold text-base sm:text-lg text-blue-700">1. Capture</h3>
          <p className="text-sm sm:text-base text-gray-600 leading-relaxed">
            Take a clear photo of the ingredients list on your food package
          </p>
          <div className="text-xs text-blue-600 bg-blue-50 rounded-lg px-2 py-1">
            {isMobile ? "Mobile optimized" : "Webcam ready"}
          </div>
        </div>
        
        <div className="space-y-3 p-4 bg-white rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
          <div className="text-4xl sm:text-5xl mb-2">🤖</div>
          <h3 className="font-bold text-base sm:text-lg text-green-700">2. AI Analysis</h3>
          <p className="text-sm sm:text-base text-gray-600 leading-relaxed">
            Each ingredient is looked up in the Open Food Facts taxonomies, and
            every verdict cites the passage it came from
          </p>
          <div className="text-xs text-green-700 bg-green-50 rounded-lg px-2 py-1">
            Tesseract OCR · Open Food Facts · a model on Groq
          </div>
        </div>
        
        <div className="space-y-3 p-4 bg-white rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
          <div className="text-4xl sm:text-5xl mb-2">📊</div>
          <h3 className="font-bold text-base sm:text-lg text-purple-700">3. Health Score</h3>
          <p className="text-sm sm:text-base text-gray-600 leading-relaxed">
            Get instant health insights, allergen alerts, and recommendations
          </p>
          <div className="text-xs text-purple-600 bg-purple-50 rounded-lg px-2 py-1">
            Instant results
          </div>
        </div>
      </div>
      
      <div className="text-center bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <p className="text-sm sm:text-base text-gray-700 font-medium mb-2">
          💡 <strong>Pro Tips for Best Results:</strong>
        </p>
        <div className="text-xs sm:text-sm text-gray-600 space-y-1">
          <p>✓ Focus only on the ingredients section of the label</p>
          <p>✓ Ensure good lighting and avoid shadows or glare</p>
          <p>✓ Hold the {isMobile ? 'phone' : 'camera'} steady for clear text</p>
          <p>✓ Make sure all ingredient text is visible and not cut off</p>
        </div>
      </div>
    </div>
  );
};

export default HowItWorks;