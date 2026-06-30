# 🛡️ SmartGuide AI

> A Chrome extension that uses Google Gemini AI to summarize pages, detect scams, verify facts, and let you chat about any website — instantly.

<div align="center">
  <img src="icons/icon128.png" alt="SmartGuide AI" width="128" />
</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔍 **Analysis Tab** | Scam detection, fact-checking, and page summary powered by Gemini AI |
| 💬 **Ask AI Tab** | Chat with Gemini about the current page — ask anything |
| 🛡️ **Scam Detection** | Detects fraudulent, phishing, and suspicious websites |
| 📊 **Fact Check** | Verifies claims on the page and flags misleading info |
| 📝 **Page Summary** | 1-2 sentence AI-generated summary of any page |
| ⚡ **Fast Fallback** | Auto-tries multiple Gemini models if one is unavailable |
| 🎨 **Premium UI** | Dark glassmorphism design with smooth animations |

---

## 🚀 Installation

### From Source (Developer Mode)

1. Clone this repo:
   ```bash
   git clone https://github.com/Jagganu/smart-guide.git
   ```

2. Open Chrome and go to `chrome://extensions`

3. Enable **Developer Mode** (top right toggle)

4. Click **"Load unpacked"** and select the cloned folder

5. Click the SmartGuide AI icon in your toolbar

6. Go to **Settings** ⚙ and enter your [Gemini API key](https://aistudio.google.com/app/apikey)

---

## 🔑 Getting a Gemini API Key

1. Visit [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Copy and paste it into SmartGuide AI → Settings

> The API key is stored locally in your browser — never sent anywhere except Google's Gemini API.

---

## 🗂️ Project Structure

```
smart-guide/
├── manifest.json       # Chrome extension manifest (v3)
├── popup.html          # Main UI — tabs, cards, chat
├── popup.js            # UI logic, tab switching, chat handling
├── background.js       # Gemini API calls, model fallback
├── content.js          # Page data extraction
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🤖 AI Models Used

SmartGuide AI automatically tries these Gemini models in order (fastest first):

1. `gemini-2.0-flash-lite`
2. `gemini-2.0-flash`
3. `gemini-1.5-flash-8b`
4. `gemini-1.5-flash`
5. `gemini-2.5-flash`

---

## 🛠️ Tech Stack

- **Manifest V3** Chrome Extension
- **Vanilla JS / HTML / CSS** — no build step needed
- **Google Gemini API** (`v1beta`)
- **Inter** + **JetBrains Mono** fonts

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

## 🙌 Contributing

Pull requests are welcome! Feel free to open issues for bugs or feature requests.
