import React from "react";

const ImagePreview = ({ imageSrc, onAnalyze, loading, onReset }) => (
  <div className="flex flex-col items-center gap-4">
    <img
      src={imageSrc}
      alt="Preview"
      className="rounded-lg shadow-md w-full max-w-md"
    />
    <button
      onClick={onAnalyze}
      className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-md w-full sm:w-auto cursor-pointer"
      disabled={loading}
    >
      {loading ? "Analyzing..." : "🧪 Analyze Ingredients"}
    </button>
    <button
      onClick={onReset}
      className="text-red-500 hover:underline text-sm cursor-pointer"
    >
      🔁 Choose another image
    </button>
  </div>
);

export default ImagePreview;
