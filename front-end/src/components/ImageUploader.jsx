import React from "react";

const ImageUploader = ({ handleUpload, onBack }) => (
  <div className="flex flex-col items-center gap-4">
    <input
      type="file"
      accept="image/*"
      onChange={handleUpload}
      className="file:bg-green-500 file:text-white file:px-4 file:py-2 file:rounded-md file:border-none file:cursor-pointer text-sm"
    />
    <button
      onClick={onBack}
      className="text-red-500 hover:underline text-sm cursor-pointer"
    >
      🔙 Back
    </button>
  </div>
);

export default ImageUploader;
