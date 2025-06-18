import React from "react";

const ModeSelection = ({ setMode }) => (
  <div className="flex flex-col items-center gap-3">
    <p className="text-gray-700 text-center">
      Choose how you'd like to input your product image:
    </p>
    <button
      onClick={() => setMode("camera")}
      className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg transition cursor-pointer"
    >
      📷 Take a Picture
    </button>
    <button
      onClick={() => setMode("upload")}
      className="w-full bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg transition cursor-pointer"
    >
      🖼️ Upload an Image
    </button>
  </div>
);

export default ModeSelection;
