import React, { useEffect, useState } from "react";
import Webcam from "react-webcam";

const WebcamCapture = ({ webcamRef, onCapture, onBack }) => {
  const [deviceId, setDeviceId] = useState(null);

  // Check if device is mobile
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  const videoConstraints = {
    facingMode: isMobile ? { exact: "environment" } : "user", // back for mobile, front/default for desktop
    deviceId: deviceId ? { exact: deviceId } : undefined,
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <Webcam
        audio={false}
        ref={webcamRef}
        screenshotFormat="image/jpeg"
        videoConstraints={videoConstraints}
        className="rounded-lg shadow w-full max-w-md"
      />

      <div className="flex gap-4 flex-wrap justify-center">
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
};

export default WebcamCapture;
