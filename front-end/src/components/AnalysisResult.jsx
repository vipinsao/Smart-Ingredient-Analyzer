import React from "react";

const getScoreColor = (score) => {
  if (score >= 80) return "text-green-600";
  if (score >= 60) return "text-yellow-600";
  return "text-red-600";
};

const getScoreBg = (score) => {
  if (score >= 80) return "bg-green-50 border-green-200";
  if (score >= 60) return "bg-yellow-50 border-yellow-200";
  return "bg-red-50 border-red-200";
};

// Why an ingredient carries no verdict. Three different facts, three
// different headings: the backend now tags each `uncovered` entry with a code
// (rag/groundedAnalysis.js), because rendering "no authoritative source found"
// over an ingredient whose sources WERE found and were then dropped to fit the
// prompt is the one lie this app must never tell.
const UNCOVERED_GROUPS = [
  {
    code: "NO_SOURCE",
    title: "No authoritative source found",
    blurb:
      "These ingredients were read off the label but are not described in the reference corpus, so no verdict is given for them. The corpus covers regulated food additives and allergens, not whole foods.",
  },
  {
    code: "MODEL_DECLINED",
    title: "Sources found, but they did not settle it",
    blurb:
      "The reference passages for these ingredients were retrieved and put to the analyst, which declined to draw a verdict from them.",
  },
  {
    code: "BUDGET_DROPPED",
    title: "Not analysed - too many ingredients in one request",
    blurb:
      "Sources for these ingredients were found, but this label carried more ingredients than one request sends evidence for, so they were never analysed. This is a limit of the request, not a gap in the corpus - analyse a shorter list to get a verdict.",
  },
];

// An entry from before the codes existed, or one from a path that does not set
// them, is still an honest "no source found" - that was the only category then.
const groupOf = (entry) => entry.code || "NO_SOURCE";

const statusStyle = (status) =>
  status === "Good"
    ? "bg-green-100 text-green-800 border-green-200"
    : status === "Bad"
      ? "bg-red-100 text-red-800 border-red-200"
      : "bg-yellow-100 text-yellow-800 border-yellow-200";

const AnalysisResult = ({
  analysis,
  healthScore,
  allergens,
  allergenDetails,
  processingTime,
  uncovered = [],
  coverage,
  grounded = true,
  degradedReason,
}) => (
  <div className="space-y-4 sm:space-y-6 px-2 max-w-full">
    {/* Whether these verdicts are sourced is the first thing a reader needs. */}
    {!grounded && (
      <div role="alert" className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 text-sm text-amber-900">
        <strong className="block mb-1">Shown without sources</strong>
        {degradedReason ||
          "The reference corpus could not produce a cited answer, so these verdicts are the model's own."}
      </div>
    )}

    {healthScore && (
      <div className={`${getScoreBg(healthScore.score)} p-6 sm:p-8 rounded-2xl border-2 shadow-xl`}>
        <div className="text-center space-y-4">
          <div>
            <div className={`text-5xl sm:text-6xl font-black ${getScoreColor(healthScore.score)} mb-2`}>
              {healthScore.score}
              <span className="text-2xl sm:text-3xl">/100</span>
            </div>
            <div className="text-lg sm:text-xl text-gray-700 font-semibold">Health Score</div>
            {coverage && (
              <p className="text-xs text-gray-600 mt-2">
                Scored on {coverage.analysed} of {coverage.parsed} ingredients read from the label.
                {coverage.uncovered > 0 && ` ${coverage.uncovered} carry no verdict, listed with the reason below.`}
              </p>
            )}
          </div>

          {healthScore.breakdown && (
            <div className="flex justify-center gap-4 text-sm">
              <div className="text-center">
                <div className="font-bold text-green-600">{healthScore.breakdown.good}</div>
                <div className="text-xs text-gray-600">Good</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-yellow-600">{healthScore.breakdown.neutral}</div>
                <div className="text-xs text-gray-600">Neutral</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-red-600">{healthScore.breakdown.bad}</div>
                <div className="text-xs text-gray-600">Bad</div>
              </div>
            </div>
          )}

          {processingTime && (
            <div className="text-sm text-gray-600 bg-white/50 rounded-lg px-3 py-1 inline-block">
              Analysed in {(processingTime / 1000).toFixed(1)}s
            </div>
          )}
        </div>
      </div>
    )}

    {allergens && allergens.length > 0 && (
      <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-4 sm:p-6 shadow-lg">
        <h3 className="font-bold text-red-800 mb-2 text-base sm:text-lg">Allergen alert</h3>
        <p className="text-xs text-red-700 mb-3">
          Matched against a fixed keyword list, not generated by the model. Always read the label yourself.
        </p>
        <div className="flex flex-wrap gap-2">
          {allergens.map((allergen) => {
            const detail = allergenDetails?.find((entry) => entry.allergen === allergen);
            return (
              <span
                key={allergen}
                title={detail ? `matched: ${detail.matches.join(", ")}` : undefined}
                className="bg-red-100 text-red-800 px-4 py-2 rounded-full text-sm font-semibold border border-red-200"
              >
                {allergen}
                {detail && <span className="ml-2 text-xs font-normal opacity-80">{detail.matches.join(", ")}</span>}
              </span>
            );
          })}
        </div>
      </div>
    )}

    <div className="bg-gradient-to-br from-gray-50 to-white p-4 sm:p-6 rounded-2xl shadow-xl border border-gray-200 space-y-4">
      <h2 className="font-bold text-green-800 text-lg sm:text-xl flex items-center gap-3">
        Ingredient analysis
        <span className="text-sm font-normal text-gray-600 bg-gray-100 px-3 py-1 rounded-full">
          {analysis?.length || 0} sourced
        </span>
      </h2>

      <div className="grid gap-3 sm:gap-4">
        {Array.isArray(analysis) &&
          analysis.map((item, index) => (
            <div key={`${item.ingredient}-${index}`} className="bg-white border-2 border-gray-100 rounded-xl p-4 sm:p-5 shadow-md">
              <div className="flex justify-between items-start mb-3 gap-3">
                <h3 className="font-semibold text-gray-900 text-sm sm:text-base flex-1 capitalize">{item.ingredient}</h3>
                <span className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap border ${statusStyle(item.status)}`}>
                  {item.status}
                </span>
              </div>

              <p className="text-xs sm:text-sm text-gray-700 leading-relaxed mb-3">{item.reason}</p>

              {item.concerns?.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {item.concerns.map((concern) => (
                    <span key={concern} className="bg-gray-100 text-gray-600 px-2 py-1 rounded-md text-xs border">
                      {concern}
                    </span>
                  ))}
                </div>
              )}

              {/* The citation is the point: a verdict without one never reaches here. */}
              {item.sources?.length > 0 && (
                <p className="text-xs text-gray-500 border-t pt-2">
                  Source:{" "}
                  {item.sources.map((source, sourceIndex) => (
                    <React.Fragment key={source.id}>
                      {sourceIndex > 0 && ", "}
                      <a href={source.url} target="_blank" rel="noreferrer noopener" className="underline hover:text-gray-700">
                        {source.title}
                      </a>
                    </React.Fragment>
                  ))}{" "}
                  — Open Food Facts, ODbL 1.0
                </p>
              )}
            </div>
          ))}
      </div>
    </div>

    {/* Reporting the gap, rather than filling it with a guess. */}
    {UNCOVERED_GROUPS.map(({ code, title, blurb }) => {
      const entries = uncovered.filter((entry) => groupOf(entry) === code);
      if (entries.length === 0) return null;

      return (
        <div key={code} className="bg-slate-50 border border-slate-200 rounded-2xl p-4 sm:p-6">
          <h3 className="font-bold text-slate-800 mb-2 text-base">{title}</h3>
          <p className="text-xs text-slate-600 mb-3">{blurb}</p>
          <div className="flex flex-wrap gap-2">
            {entries.map((entry) => (
              <span key={entry.ingredient} className="bg-white text-slate-700 px-3 py-1.5 rounded-full text-sm border border-slate-200">
                {entry.ingredient}
              </span>
            ))}
          </div>
        </div>
      );
    })}

    <p className="text-center text-xs text-gray-500 px-4">
      Not medical or dietary advice. Verdicts are generated from Open Food Facts passages and are not reviewed by a
      professional.
    </p>
  </div>
);

export default AnalysisResult;
