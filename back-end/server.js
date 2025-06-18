import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Tesseract from "tesseract.js";
import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Check if API key is loaded
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY not found in .env");
  process.exit(1);
} else {
  console.log("✅ Gemini API Key loaded");
}

// Middlewares
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// Extract ingredients from OCR text
function extractIngredients(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const ingredientLines = [];

  let startFound = false;
  for (let line of lines) {
    if (!startFound && /ingredients?/i.test(line)) {
      startFound = true;
      ingredientLines.push(line);
      continue;
    }

    if (startFound) {
      if (
        /^(nutritional|nutrition|storage|manufactured|marketed|packed|usage|instructions|allergy|net weight)/i.test(
          line
        )
      ) {
        break;
      }
      ingredientLines.push(line);
    }
  }

  return ingredientLines.join(" ");
}

// API route
app.post("/api/analyze", async (req, res) => {
  const { image } = req.body;

  if (!image) {
    return res
      .status(400)
      .json({ error: "Image is missing in the request body" });
  }

  try {
    // OCR from image
    const {
      data: { text },
    } = await Tesseract.recognize(image, "eng", {
      logger: (m) => console.log("[Tesseract]", m),
    });

    console.log("\n[OCR Text]:\n", text);

    const ingredientsOnly = extractIngredients(text);
    console.log("\n[Extracted Ingredients]:\n", ingredientsOnly);

    if (!ingredientsOnly || ingredientsOnly.length < 10) {
      return res
        .status(400)
        .json({ error: "Could not extract ingredients from image" });
    }

    // Gemini prompt
    const prompt = `
You are a health food expert. Analyze the following list of food ingredients.

Return a JSON array only. Each object should be in this format:
{
  "ingredient": "<ingredient_name>",
  "status": "<Good|Bad|Neutral>",
  "reason": "<brief explanation>"
}

⚠️ Strictly return valid JSON. No markdown, no explanations, no formatting.

Ingredients:
${ingredientsOnly}
    `.trim();

    // Gemini API request
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const geminiJson = await geminiResponse.json();
    console.log(
      "\n[Gemini Raw Response]:\n",
      JSON.stringify(geminiJson, null, 2)
    );

    // Error from Gemini API
    if (geminiJson.error) {
      console.error("[Gemini API Error]:", geminiJson.error);
      return res
        .status(500)
        .json({ error: "Gemini API Error", details: geminiJson.error });
    }

    let geminiText =
      geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("\n[Gemini Text]:\n", geminiText);

    // Cleanup: Remove ```json and ``` if present
    geminiText = geminiText
      .trim()
      .replace(/^```json/i, "")
      .replace(/```$/, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(geminiText);
    } catch (e) {
      console.error("[JSON Parse Error]:", e.message);
      return res.status(500).json({
        error: "Gemini response is not valid JSON",
        raw: geminiText,
      });
    }

    res.json({
      ingredientsText: ingredientsOnly,
      analysis: parsed,
    });
  } catch (error) {
    console.error("[Server Error]:", error.message);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  // console.log(`🚀 Server running at ${PORT}`);
});
