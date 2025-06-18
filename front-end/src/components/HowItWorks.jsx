import React from "react";

const HowItWorks = () => {
  return (
    <div className="text-gray-700 bg-gray-50 p-4 sm:p-5 rounded-xl shadow space-y-4">
      <h2 className="text-lg font-semibold text-blue-800 text-center">
        📋 How to Use This App
      </h2>
      <p className="text-sm sm:text-base text-center">
        Upload a clear image of the <strong>ingredient list</strong> printed on
        your food product. This helps the system extract and analyze ingredients
        for their health impact.
      </p>
      <p className="text-sm sm:text-base text-center text-gray-600 italic">
        Do not upload the full package — just focus on the part where
        ingredients are written.
      </p>
      <div className="flex justify-center">
        <img
          src="/ingredient.jpeg" // ✅ Make sure you place this image in the `public` folder
          alt="Example Ingredient Area"
          className="rounded-lg shadow max-w-xs sm:max-w-md"
        />
      </div>
      <p className="text-sm text-center text-gray-500 mt-2">
        Example: An ideal photo shows only the text like “Ingredients: Water,
        Sugar, Salt...”
      </p>
    </div>
  );
};

export default HowItWorks;
