# 🧠 AI Ingredient Analyzer

A full-stack AI-powered web application designed to help users identify the health impact of food ingredients by simply uploading or capturing an image of the food label. The application uses Optical Character Recognition (OCR) to extract the ingredients, and then evaluates them using Google's Gemini AI.

Whether you're health-conscious, allergic to certain additives, or just curious about what you're eating—this tool is built for you.

---

## 🚀 Overview

**AI Ingredient Analyzer** simplifies the often confusing ingredient lists found on food packaging. Users can either **upload an image** or use their **device's webcam** to scan a food label. The app extracts the ingredient text using **Tesseract.js** (OCR), then sends it to the **Gemini AI** model, which classifies each ingredient as:

- ✅ **Good**
- ⚠️ **Neutral**
- ❌ **Bad**

Each classification comes with a brief reason, empowering users to make healthier decisions with ease.

---

## ✨ Features

- 📤 Upload or 📸 capture food label images
- 🔍 Extracts ingredients from blurry, printed, or digital labels using Tesseract.js
- 🧠 Uses Google Gemini AI to analyze ingredient health impact
- 🧾 Displays structured JSON output with classification and reason
- 🖼 Live image preview before submission
- 🔁 Reset and try another label easily
- 📱 Fully responsive on mobile and desktop
- ⚙️ Built with clean modular architecture (frontend & backend separate)

---

## 🛠 Tech Stack

### 🔹 Frontend
- React (with Vite)
- Tailwind CSS
- Axios
- React Webcam

### 🔹 Backend
- Node.js
- Express.js
- Tesseract.js (OCR)
- Google Gemini API
- dotenv for secure environment variable handling
- body-parser and cors for API support

---

## 🌐 Live Demo

- 🔗 Frontend (Vercel): [https://smart-ingredient-analyzer.vercel.app](https://smart-ingredient-analyzer.vercel.app)
- 🔗 Backend (Render): [https://smart-ingredient-analyzer.onrender.com](https://smart-ingredient-analyzer.onrender.com)

---

## 📦 Installation & Setup

### 🔧 Prerequisites

- Node.js (v16 or later recommended)
- A valid [Google Gemini API Key](https://makersuite.google.com/app)
- Vercel / Render accounts (for deployment if needed)

---

### 🖥️ Frontend Setup (React + Vite)

```bash
git clone https://github.com/your-username/smart-ingredient-analyzer.git
cd smart-ingredient-analyzer/frontend
npm install
```

Create a `.env` file:

```
VITE_API=https://smart-ingredient-analyzer.onrender.com
```

Run the development server:

```bash
npm run dev
```

---

### 🛠️ Backend Setup (Node.js + Express)

```bash
cd ../backend
npm install
```

Create a `.env` file:

```
PORT=5000
GEMINI_API_KEY=your_actual_gemini_api_key
```

Run the backend server:

```bash
npm start
```

---

## 🤖 Gemini AI Integration

We use Google Gemini's `generateContent` endpoint to send the extracted ingredient list and receive health analysis in structured JSON format.

### Example Prompt Sent:

```txt
You are a health food expert. Analyze the following list of food ingredients.

Return a JSON array only. Each object should be in this format:
{
  "ingredient": "<ingredient_name>",
  "status": "<Good|Bad|Neutral>",
  "reason": "<brief explanation>"
}
```

Gemini returns a response like:

```json
[
  {
    "ingredient": "sugar",
    "status": "Bad",
    "reason": "Excessive sugar intake is linked to obesity and diabetes."
  }
]
```

---

## ⚙️ How It Works

1. 📸 Upload or capture image.
2. 🔍 OCR reads text using Tesseract.js.
3. ✂️ Custom logic filters only the ingredient section.
4. 🧠 Gemini API analyzes and returns ingredient safety.
5. 📊 Results are shown clearly in frontend.

---

## 📌 Environment Variables

| Variable           | Description                                | Required |
|--------------------|--------------------------------------------|----------|
| `GEMINI_API_KEY`   | Google Gemini API Key                      | ✅       |
| `PORT`             | Port for backend server                    | Optional |
| `VITE_API`         | Used in frontend `.env` to connect to backend | ✅    |

---

## 📈 Roadmap / Ideas

- 🌍 Multi-language OCR support (Hindi, French, etc.)
- 🧬 Allergy-specific filtering
- 🗂 Save & download past analysis reports
- 🔊 Add voice search/image input
- 🧑‍💻 User authentication for saved history

---

## 🙋‍♂️ About Me

Hi, I'm **Vipin Chandra Sao**, an aspiring full-stack software engineer passionate about solving real-world problems with modern web technologies. I created this project as part of my personal learning and to help others make better food choices using AI.

If you'd like to connect or collaborate:

- GitHub: [@vipinsao](https://github.com/vipinsao)
- Twitter: [@vipinsao](https://twitter.com/vipinsao)

---

## 🤝 Contributing

Contributions, ideas, and feedback are always welcome!

```bash
# 1. Fork the repo
# 2. Create your branch (git checkout -b feature/feature-name)
# 3. Commit your changes (git commit -m 'Added something useful')
# 4. Push to the branch (git push origin feature/feature-name)
# 5. Open a Pull Request
```

---

> If you found this project helpful or inspiring, please ⭐ it and share it with your network. Thank you!

_Last updated: 2025-06-18_
