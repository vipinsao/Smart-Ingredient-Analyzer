// App.jsx
import React, { useRef, useState } from "react";
import WebcamCapture from "./components/WebcamCapture";
import ImageUploader from "./components/ImageUploader";
import ModeSelection from "./components/ModeSelection";
import ImagePreview from "./components/ImagePreview";
import AnalysisResult from "./components/AnalysisResult";
import HowItWorks from "./components/HowItWorks";
import axios from "axios";

function App() {
  const webcamRef = useRef(null);
  const [imageSrc, setImageSrc] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState(null);

  const captureImage = () => {
    const src = webcamRef.current.getScreenshot();
    setImageSrc(src);
  };

  const handleUpload = (e) => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onloadend = () => setImageSrc(reader.result);
    if (file) reader.readAsDataURL(file);
  };

  const analyzeImage = async () => {
    if (!imageSrc) return;
    setLoading(true);
    try {
      const API = import.meta.env.VITE_API_URL;
      console.log(API);
      const response = await axios.post(`${API}/api/analyze`, {
        image: imageSrc,
      });
      setAnalysis(response.data.analysis);
    } catch (error) {
      console.error("Error analyzing image:", error);
      alert("Failed to analyze image.");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setImageSrc(null);
    setAnalysis(null);
    setMode(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-100 to-white p-4 sm:p-6 font-sans">
      <div className="max-w-4xl mx-auto shadow-xl bg-white rounded-2xl p-5 sm:p-8 space-y-6">
        <a href="/">
          <h1 className="text-2xl sm:text-3xl font-bold text-center mb-4 text-blue-800">
            🧠 AI Ingredient Analyzer
          </h1>
        </a>

        {!mode && <HowItWorks />}

        {!mode && <ModeSelection setMode={setMode} />}

        {mode === "camera" && !imageSrc && (
          <WebcamCapture
            webcamRef={webcamRef}
            onCapture={captureImage}
            onBack={reset}
          />
        )}

        {mode === "upload" && !imageSrc && (
          <ImageUploader handleUpload={handleUpload} onBack={reset} />
        )}

        {imageSrc && (
          <ImagePreview
            imageSrc={imageSrc}
            onAnalyze={analyzeImage}
            loading={loading}
            onReset={reset}
          />
        )}

        {analysis ? (
          <AnalysisResult analysis={analysis} />
        ) : (
          <RingLoader size="60" loading={true} />
        )}
      </div>
    </div>
  );
}

export default App;
