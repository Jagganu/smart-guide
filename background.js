// background.js — SmartGuide AI service worker (Gemini API)

const DEBUG = false;

function dbg(label, data) {
  if (!DEBUG) return;
  console.log(`[SmartGuide] ${label}`, data ?? "");
}

// ── Nuke any stale model from storage the instant this service worker loads ─
// We never read lastWorkingModel anymore, so always remove it.
// Reset selectedModel to "auto" if it's anything other than a known-safe value.
const SAFE_SELECTED = new Set([
  "auto","gemini-2.0-flash-lite","gemini-2.0-flash",
  "gemini-1.5-flash-8b","gemini-1.5-flash","gemini-2.5-flash",
]);
chrome.storage.local.remove("lastWorkingModel");
chrome.storage.local.get("selectedModel", (s) => {
  if (s.selectedModel && !SAFE_SELECTED.has(s.selectedModel)) {
    chrome.storage.local.set({ selectedModel: "auto" });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CALL_GEMINI") {
    callGemini(msg.payload)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err)  => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});


// ── Model list: fastest first ──────────────────────────────────────────────
const GEMINI_MODELS = [
  "gemini-2.0-flash-lite",   // ~1-2s — primary for chat
  "gemini-2.0-flash",        // ~2-3s — fallback
  "gemini-1.5-flash-8b",     // ~2-3s — fallback
  "gemini-1.5-flash",        // ~3-4s — fallback
  "gemini-2.5-flash",        // ~4-6s — last resort
];

const RETIRED_MODELS = new Set([
  "gemini-2.5-flash-preview-05-20",
  "gemini-2.5-pro-preview-05-06",
  "gemini-3-flash-preview",
  "gemini-1.5-pro",
]);

// Per-session blacklist for 404/unavailable models
const sessionBlacklist = new Set();

// ── Timeout: abort fetch if model takes too long ───────────────────────────
// Timeout: abort if a model takes too long, immediately try the next one
const CHAT_TIMEOUT_MS     = 12000;   // 12s per model for chat
const ANALYSIS_TIMEOUT_MS = 18000;   // 18s per model for analysis

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ── Error helpers ──────────────────────────────────────────────────────────
function isRetryableModelError(message, status) {
  const m = (message || "").toLowerCase();
  if (status === 429 || status === 503 || status === 404) return true;
  if (m.includes("quota") || m.includes("rate limit") || m.includes("resource_exhausted")) return true;
  if (m.includes("not found") || m.includes("not supported")) return true;
  if (m.includes("overloaded") || m.includes("unavailable")) return true;
  if (m.includes("mime type") || m.includes("mimetype")) return true;
  if (m.includes("aborted") || m.includes("timed out") || m.includes("timeout")) return true;
  return false;
}

function isModelNotFound(message, status) {
  const m = (message || "").toLowerCase();
  return status === 404
    || m.includes("not found")
    || m.includes("not supported for generatecontent");
}

// ── Main Gemini caller ─────────────────────────────────────────────────────
async function callGemini({ pageData, userQuestion, conversationHistory, isAnalysis }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("No API key set. Please enter your Gemini API key in Settings.");

  const systemPrompt = buildSystemPrompt(pageData, isAnalysis);
  const contents     = buildGeminiContents(pageData, userQuestion, conversationHistory, isAnalysis);

  // Always use GEMINI_MODELS in fixed order — no storage, no caching.
  // This prevents any stale/retired model from ever being selected.
  const modelsToTry = GEMINI_MODELS.filter((m) => !sessionBlacklist.has(m));

  let lastError = "";

  for (const model of modelsToTry) {
    try {
      const result = await callGeminiModel(
        apiKey, model, systemPrompt, contents, isAnalysis, true
      );
      return result;

    } catch (err) {
      lastError = err.message;
      dbg(`model ${model} failed`, err.message);

      // Skip this model for the rest of the session if it's not found
      if (isModelNotFound(err.message, err.status || 0)) {
        sessionBlacklist.add(model);
      }

      // If model rejects JSON mode, retry without it (same model, no delay)
      if (isAnalysis && err.message.toLowerCase().includes("response mime type")) {
        try {
          return await callGeminiModel(
            apiKey, model, systemPrompt, contents, isAnalysis, false
          );
        } catch (retryErr) {
          lastError = retryErr.message;
        }
      }

      // Non-retryable error (e.g. bad key) — fail immediately
      if (!isRetryableModelError(err.message, err.status || 0)) throw err;

      // No sleep between model attempts — immediately try next model
    }
  }

  throw new Error(`Could not reach Gemini. ${lastError}`);
}

// ── Per-model API call with hard timeout ───────────────────────────────────
async function callGeminiModel(apiKey, model, systemPrompt, contents, isAnalysis, useJsonMode) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const generationConfig = {
    maxOutputTokens: isAnalysis ? 500 : 350,
    temperature:     isAnalysis ? 0.1 : 0.5,
  };
  if (isAnalysis && useJsonMode) generationConfig.responseMimeType = "application/json";

  const timeoutMs = isAnalysis ? ANALYSIS_TIMEOUT_MS : CHAT_TIMEOUT_MS;

  let response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig,
        }),
      },
      timeoutMs
    );
  } catch (fetchErr) {
    // AbortError = timed out — treat as retryable so we move to next model
    const e = new Error(fetchErr.name === "AbortError" ? "Request timed out" : fetchErr.message);
    e.status = 0;
    throw e;
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err?.error?.message || `Gemini API error ${response.status}`;
    const e   = new Error(msg);
    e.status  = response.status;
    if (response.status === 401 || response.status === 403) {
      throw new Error("Invalid API key. Update it in Settings.");
    }
    throw e;
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── System prompts ─────────────────────────────────────────────────────────
function buildSystemPrompt(pageData, isAnalysis) {
  // Chat uses a much shorter excerpt to reduce prompt size = faster response
  const excerptLen = isAnalysis ? 1500 : 1000;
  const excerpt = pageData.bodyText.slice(0, excerptLen);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const dateNote = `Today is ${today}. Do NOT treat dates on or before today as future or fictional.`;

  if (isAnalysis) {
    return `${dateNote}
Analyze this web page. Reply with ONLY a JSON object, no markdown, no explanation.
Page: "${pageData.title}" (${pageData.url})
Content: ${excerpt}
Return exactly:
{"summary":"1-2 sentences","scamVerdict":"Genuine|Suspicious|Likely Scam|Unknown","scamDetail":"brief reason","dataVerdict":"True|False|Mixed|Unknown","dataDetail":"brief reason"}`;
  }

  if (pageData.pageType === "tool") {
    return `${dateNote}
You are a concise assistant helping users understand tool/app websites. Reply in 2-4 sentences max.
Page: "${pageData.title}" (${pageData.url})
Content: ${excerpt}`;
  }

  return `${dateNote}
You are a concise assistant helping users understand web pages. Reply in 2-4 sentences max. Be direct.
Page: "${pageData.title}" (${pageData.url})
Content: ${excerpt}`;
}

// ── Gemini contents builder ────────────────────────────────────────────────
function buildGeminiContents(pageData, userQuestion, conversationHistory, isAnalysis) {
  const contents = [];

  // Include recent conversation history (last 6 turns only to keep prompt small)
  const recentHistory = conversationHistory?.slice(-6) || [];
  for (const msg of recentHistory) {
    contents.push({
      role:  msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  }

  if (isAnalysis) {
    contents.push({ role: "user", parts: [{ text: "Analyze this page now." }] });
  }

  if (userQuestion) {
    contents.push({ role: "user", parts: [{ text: userQuestion }] });
  }

  return contents;
}

// ── Storage helper ─────────────────────────────────────────────────────────
async function getApiKey() {
  return new Promise((resolve) =>
    chrome.storage.local.get("apiKey", (r) => resolve(r.apiKey || ""))
  );
}
