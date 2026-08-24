// App.jsx
import React, { useRef, useState, useCallback, useEffect } from "react";
import WebcamCapture from "./components/WebcamCapture";
import ImageUploader from "./components/ImageUploader";
import ModeSelection from "./components/ModeSelection";
import ImagePreview from "./components/ImagePreview";
import AnalysisResult from "./components/AnalysisResult";
import HowItWorks from "./components/HowItWorks";
import { compressImage, detectDeviceCapabilities } from "./utils/imageUtils";

// Client-side request budget. Must stay above the backend's worst case
// (OCR + the model call), or the browser aborts work the server completed.
//
// 60s was still too short. The backend suspends after ~15 minutes idle, and a
// measured cold start put the Node process at ~28s before it served anything;
// the analyse request that followed exhausted 60s and aborted, so the first
// visitor after a quiet spell got a hard failure. The budget now covers a cold
// boot plus the warm worst case rather than only the warm one.
const REQUEST_TIMEOUT_MS = 120000;

// The wake-up request must outlive the cold start it exists to absorb. At 30s
// it was aborting before the server had finished booting - which is precisely
// when it was needed.
const PREWARM_TIMEOUT_MS = 120000;

function App() {
  const webcamRef = useRef(null);
  const [imageSrc, setImageSrc] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [mode, setMode] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [deviceCapabilities, setDeviceCapabilities] = useState(null);

  // Enhanced state for background processing
  const [processingState, setProcessingState] = useState({
    isProcessing: false,
    status: "",
    progress: 0,
    ocrText: null,
    analysisPromise: null,
    startedAt: null,
  });

  const [analysisReady, setAnalysisReady] = useState(false);
  // Whether the wake-up request has come back. Read through a ref inside the
  // async handler so it sees the current value, not the one captured at click.
  const [serverWarm, setServerWarm] = useState(false);
  const serverWarmRef = useRef(false);
  const [fullResults, setFullResults] = useState(null);

  // Detect device capabilities on mount
  useEffect(() => {
    const capabilities = detectDeviceCapabilities();
    setDeviceCapabilities(capabilities);
  }, []);

  // Where the API lives. Vite inlines VITE_API_URL at BUILD time, so this is
  // decided when the bundle is produced, not when the page loads.
  //
  // The previous version fell back to http://localhost:5000 in every build. In
  // a deployed bundle that is a URL the visitor's browser can never reach, so a
  // missing environment variable showed up as a confusing network error instead
  // of a configuration error. Localhost is now a development-only default.
  const getApiUrl = useCallback(() => {
    const configured = import.meta.env.VITE_API_URL?.trim();
    if (configured) return configured.replace(/\/$/, "");
    if (import.meta.env.DEV) return "http://localhost:5000";
    return null;
  }, []);

  useEffect(() => {
    serverWarmRef.current = serverWarm;
  }, [serverWarm]);

  // Wake the API while the visitor is still choosing an image.
  //
  // The backend runs on a tier that suspends after about 15 minutes idle, and
  // the first request after that pays the cold start: measured at 22.6s before
  // any OCR or model work. That lands entirely inside the analyse click, so the
  // first visitor of the hour waits roughly forty seconds on what is otherwise
  // a few-second request, with no way to tell it apart from a hang.
  //
  // Choosing an image takes far longer than the cold start, so spending it here
  // costs the visitor nothing. Deliberately fire-and-forget: this is an
  // optimisation, and a failure here must not surface as an error on a page
  // where the user has not asked for anything yet.
  useEffect(() => {
    const api = getApiUrl();
    if (!api) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PREWARM_TIMEOUT_MS);

    fetch(`${api}/health`, { signal: controller.signal })
      .then(() => setServerWarm(true))
      .catch(() => {})
      .finally(() => clearTimeout(timeoutId));

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [getApiUrl]);

  // Enhanced background processing function
  const startBackgroundProcessing = useCallback(async (imageData) => {
    setProcessingState({
      isProcessing: true,
      status: "Optimizing image...",
      progress: 10,
      ocrText: null,
      analysisPromise: null,
      startedAt: Date.now(),
    });

    try {
      // Get optimal settings based on device
      const settings = deviceCapabilities || detectDeviceCapabilities();
      
      setProcessingState(prev => ({
        ...prev,
        status: "📝 Extracting text...",
        progress: 30,
      }));

      const API = getApiUrl();

      if (!API) {
        const configError = new Error(
          "This build has no API address configured. Set VITE_API_URL before building the frontend."
        );
        configError.userFacing = true;
        throw configError;
      }

      // The server's own ceiling is roughly OCR (seconds, and slower on a free
      // hosting tier) plus a 20s model timeout. The old 15s/20s client budget
      // was below that, so a request the server answered successfully was
      // aborted by the browser first and shown to the user as a timeout.
      const timeoutMs = REQUEST_TIMEOUT_MS;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);


      const response = await fetch(`${API}/api/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          image: imageData,
          fastMode: settings.fastMode,
          isMobile: settings.isMobile
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);


      setProcessingState(prev => ({
        ...prev,
        status: "🧠 AI analyzing ingredients...",
        progress: 70,
      }));

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          error: "Server responded with an error",
          code: "UNKNOWN",
        }));

        console.error("🔴 Analysis failed:", {
          status: response.status,
          statusText: response.statusText,
          errorData
        });

        // The API answers every typed failure with a message written for a
        // human ("Point the camera at the ingredients section", "Image is too
        // large"). Show that instead of re-deriving it from the code here,
        // which is how the old mapping ended up referring to error codes the
        // server had stopped sending.
        const userFriendlyMessage = `❌ ${
          errorData.error || "Analysis failed, please try again."
        }`;

        setProcessingState(prev => ({
          ...prev,
          status: userFriendlyMessage,
          progress: 0,
        }));

        setErrorMessage(userFriendlyMessage);

        setTimeout(() => {
          setProcessingState(prev => ({
            ...prev,
            isProcessing: false,
          }));
        }, 3000);

        return;
      }

      const result = await response.json();

      setProcessingState(prev => ({
        ...prev,
        status: "✅ Analysis complete!",
        progress: 100,
        ocrText: result.ingredientsText,
        analysisPromise: Promise.resolve(result),
      }));

      setFullResults(result);
      setAnalysisReady(true);

      setTimeout(() => {
        setProcessingState(prev => ({
          ...prev,
          isProcessing: false,
        }));
      }, 1500);

    } catch (error) {
      console.error("🔴 Background processing error:", error);

      let errorMsg = "❌ Could not reach the server. Please check your connection.";

      if (error.userFacing) {
        errorMsg = `❌ ${error.message}`;
      } else if (error.name === 'AbortError') {
        // This used to read "try a clearer, smaller image", which blames the
        // user for the host's cold start: the image that produced it was 44 kB
        // and perfectly legible. The server going back to sleep is the far
        // likelier cause and the only one the visitor can act on.
        errorMsg = serverWarmRef.current
          ? "❌ The analysis timed out. Please try again."
          : "❌ The free-tier server was still waking up and did not answer in time. Press Analyse again — the second attempt is usually fast.";
      } else if (String(error.message).includes('Failed to fetch')) {
        errorMsg = "❌ Network error. Please check your internet connection.";
      }

      setProcessingState(prev => ({
        ...prev,
        status: errorMsg,
        progress: 0,
      }));

      setErrorMessage(errorMsg);

      setTimeout(() => {
        setProcessingState(prev => ({
          ...prev,
          isProcessing: false,
        }));
      }, 3000);
    }
  }, [deviceCapabilities, getApiUrl]);

  // Enhanced capture function
  // WebcamCapture takes the screenshot itself, at an explicit resolution and
  // quality chosen for OCR, and hands it over. Re-screenshotting here threw
  // that frame away and grabbed a second one at the component defaults.
  const captureImage = useCallback(async (capturedImage) => {
    try {
      const imageSrc = capturedImage || webcamRef.current?.getScreenshot();
      if (!imageSrc) {
        setErrorMessage("❌ Could not capture image. Please allow camera access.");
        return;
      }

      // Use high quality settings for OCR
      const settings = deviceCapabilities || detectDeviceCapabilities();
      
      // Maximum quality for webcam captures
      const ocrSettings = {
        ...settings,
        quality: 0.98, // Very high quality for webcam
        maxWidth: Math.max(settings.maxWidth, 2000) // High resolution
      };
      
      const compressedImage = await compressImage(
        imageSrc, 
        ocrSettings.quality, 
        ocrSettings.maxWidth
      );
      
      setImageSrc(compressedImage);
      startBackgroundProcessing(compressedImage);
    } catch (error) {
      console.error('Capture error:', error);
      setErrorMessage("❌ Failed to capture image. Please try again.");
    }
  }, [deviceCapabilities, startBackgroundProcessing]);

  // Enhanced upload handler
  const handleUpload = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Enhanced file validation
    const maxSize = deviceCapabilities?.isMobile ? 8 * 1024 * 1024 : 10 * 1024 * 1024; // 8MB mobile, 10MB desktop
    
    if (file.size > maxSize) {
      const maxSizeMB = Math.round(maxSize / (1024 * 1024));
      setErrorMessage(`❌ File too large. Please select an image under ${maxSizeMB}MB.`);
      return;
    }

    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setErrorMessage("❌ Please select a valid image file (JPG, PNG, WebP).");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = async () => {
      try {
        const settings = deviceCapabilities || detectDeviceCapabilities();
        
        // High quality for uploaded images
        const compressedImage = await compressImage(
          reader.result, 
          0.95, // High quality
          Math.max(settings.maxWidth, 2000) // High resolution
        );
        
        setImageSrc(compressedImage);
        startBackgroundProcessing(compressedImage);
      } catch (error) {
        console.error('Upload processing error:', error);
        setErrorMessage("❌ Failed to process image. Please try another image.");
      }
    };
    reader.readAsDataURL(file);
  }, [deviceCapabilities, startBackgroundProcessing]);

  // Instant analysis function
  const analyzeImage = useCallback(async () => {
    if (analysisReady && fullResults) {
      setAnalysis(fullResults.analysis);
    } else if (processingState.analysisPromise) {
      try {
        const response = await processingState.analysisPromise;
        setFullResults(response);
        setAnalysis(response.analysis);
        setAnalysisReady(true);
      } catch (error) {
        console.error("Error analyzing image:", error);
        setErrorMessage("❌ Failed to analyze image. Please try again.");
      }
    } else if (imageSrc) {
      // Nothing succeeded and nothing is in flight - the background run failed
      // and cleared isProcessing without leaving a promise behind. The button
      // re-enabled and re-labelled itself "Analyze Ingredients", and neither
      // branch above matched, so tapping it did nothing at all, for ever. The
      // only escape was "Retake", which is not what the button said.
      //
      // This is the state a visitor lands in when the first request to a cold
      // free-tier instance times out, which is to say: the common case.
      setErrorMessage("");
      startBackgroundProcessing(imageSrc);
    }
  }, [analysisReady, fullResults, processingState.analysisPromise, imageSrc, startBackgroundProcessing]);

  const reset = useCallback(() => {
    setImageSrc(null);
    setAnalysis(null);
    setMode(null);
    setAnalysisReady(false);
    setFullResults(null);
    setProcessingState({
      isProcessing: false,
      status: "",
      progress: 0,
      ocrText: null,
      analysisPromise: null,
      startedAt: null,
    });
    setErrorMessage(null);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50 p-2 sm:p-4 font-sans">
      <div className="max-w-4xl mx-auto shadow-2xl bg-white rounded-2xl sm:rounded-3xl p-4 sm:p-8 space-y-4 sm:space-y-8">
        <a href="/" className="block">
          <div className="text-center space-y-2 py-2">
            <div className="flex items-center justify-center gap-2 sm:gap-3 mb-2">
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-br from-blue-600 to-green-600 rounded-xl flex items-center justify-center shadow-lg transform hover:scale-105 transition-transform duration-300">
                <svg className="w-5 h-5 sm:w-7 sm:h-7 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C13.1 2 14 2.9 14 4C14 5.1 13.1 6 12 6C10.9 6 10 5.1 10 4C10 2.9 10.9 2 12 2ZM21 9V7L15 7.5V8.5C15 9.6 14.1 10.5 13 10.5S11 9.6 11 8.5V7.5L9 7.5V8.5C9 9.6 8.1 10.5 7 10.5S5 9.6 5 8.5V7.5L3 7V9C3 10.1 3.9 11 5 11V12.5C5 13.6 5.9 14.5 7 14.5S9 13.6 9 12.5V11H15V12.5C15 13.6 15.9 14.5 17 14.5S19 13.6 19 12.5V11C20.1 11 21 10.1 21 9ZM7.5 18C7.5 18.8 8.2 19.5 9 19.5S10.5 18.8 10.5 18V16.5H13.5V18C13.5 18.8 14.2 19.5 15 19.5S16.5 18.8 16.5 18V16.5H7.5V18Z" />
                </svg>
              </div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold bg-gradient-to-r from-blue-700 via-slate-700 to-green-700 bg-clip-text text-transparent leading-tight">
                <span className="inline-block transform hover:scale-105 transition-all duration-500 hover:text-blue-800">
                  AI
                </span>
                <span className="mx-1 sm:mx-2">Ingredient</span>
                <span className="inline-block transform hover:scale-105 transition-all duration-500 hover:text-green-800">
                  Analyzer
                </span>
              </h1>
            </div>
            <p className="text-sm sm:text-base text-gray-700 font-medium opacity-90 hover:opacity-100 transition-opacity duration-300">
              Instant health analysis of food ingredients
            </p>
          </div>
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
            onReset={reset}
            processingState={processingState}
            analysisReady={analysisReady}
          />
        )}

        {errorMessage && (
          <div
            role="alert"
            className="text-red-600 font-medium text-center bg-red-100 border border-red-300 px-4 py-3 rounded-xl shadow-sm text-sm"
          >
            {errorMessage}
            <button 
              onClick={() => setErrorMessage(null)}
              aria-label="Dismiss error"
              className="ml-3 text-red-800 hover:text-red-900 font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {analysis && fullResults && (
          <AnalysisResult
            analysis={analysis}
            healthScore={fullResults.healthScore}
            allergens={fullResults.allergens}
            allergenDetails={fullResults.allergenDetails}
            processingTime={fullResults.processingTime}
            uncovered={fullResults.uncovered}
            coverage={fullResults.coverage}
            grounded={fullResults.grounded !== false}
            degradedReason={fullResults.degradedReason}
          />
        )}
      </div>
    </div>
  );
}

export default App;