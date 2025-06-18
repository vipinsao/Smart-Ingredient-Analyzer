import React from "react";
import Webcam from "react-webcam";

const WebcamCapture = ({ webcamRef, onCapture, onBack }) => (
  <div className="flex flex-col items-center gap-4">
    <Webcam
      audio={false}
      ref={webcamRef}
      screenshotFormat="image/jpeg"
      className="rounded-lg shadow w-full max-w-md"
    />
    <div className="flex gap-4">
      <button
        onClick={onCapture}
        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md cursor-pointer"
      >
        📸 Capture
      </button>
      <button
        onClick={onBack}
        className="text-red-500 hover:underline text-sm self-center cursor-pointer"
      >
        🔙 Back
      </button>
    </div>
  </div>
);

export default WebcamCapture;
