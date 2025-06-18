const AnalysisResult = ({ analysis }) => {
  return (
    <div className="bg-gray-50 p-4 sm:p-5 rounded-xl shadow space-y-4 overflow-x-auto">
      <div>
        <h2 className="font-semibold text-green-800 text-lg">
          🧠 Health Analysis
        </h2>
        <div className="space-y-3 text-sm text-gray-800">
          {Array.isArray(analysis) &&
            analysis.map((item, idx) => (
              <div
                key={idx}
                className="bg-white border border-gray-200 rounded-md p-3 shadow-sm"
              >
                <p>
                  <strong>Ingredient:</strong> {item.ingredient}
                </p>
                <p>
                  <strong>Status:</strong>{" "}
                  <span
                    className={`font-semibold ${
                      item.status === "Good"
                        ? "text-green-600"
                        : item.status === "Bad"
                        ? "text-red-600"
                        : "text-yellow-600"
                    }`}
                  >
                    {item.status}
                  </span>
                </p>
                <p>
                  <strong>Reason:</strong> {item.reason}
                </p>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};

export default AnalysisResult;
