import React, { useEffect, useState } from "react";

// OCR takes seconds, and tens of seconds on a cold free-tier instance. A
// progress bar that sits still for that long reads as a hung page, so the
// elapsed time is shown and a reassurance appears once the wait gets long.
const LONG_WAIT_SECONDS = 8;

const ProcessingStatus = ({ status, progress, ocrText, startedAt }) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return undefined;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4 sm:p-6 space-y-4 w-full max-w-md shadow-lg"
    >
      <div className="flex items-center gap-3">
        <div className="animate-spin w-6 h-6 border-3 border-blue-600 border-t-transparent rounded-full" />
        <span className="font-semibold text-blue-800 text-sm sm:text-base flex-1">{status}</span>
        {startedAt && (
          <span className="text-xs text-blue-700 tabular-nums" aria-label={`${elapsed} seconds elapsed`}>
            {elapsed}s
          </span>
        )}
      </div>

      {progress > 0 && (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-blue-700">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div
            className="w-full bg-blue-200 rounded-full h-3 overflow-hidden"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="bg-gradient-to-r from-blue-600 to-indigo-600 h-3 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {ocrText && (
        <div className="mt-4 p-4 bg-white rounded-xl border shadow-sm">
          <p className="text-xs text-gray-600 mb-2 font-medium">Detected ingredients:</p>
          <p className="text-xs sm:text-sm text-gray-800 italic leading-relaxed">
            {ocrText.substring(0, 150)}
            {ocrText.length > 150 ? "..." : ""}
          </p>
        </div>
      )}

      {elapsed >= LONG_WAIT_SECONDS && (
        <p className="text-xs text-blue-600 text-center">
          Reading the label. The first request after an idle period wakes the free-tier
          server and can take up to a minute.
        </p>
      )}
    </div>
  );
};

export default ProcessingStatus;
