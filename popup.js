// popup.js — SmartGuide AI popup logic

const DEBUG = false;

function dbg(label, data) {
  if (!DEBUG) return;
  console.log(`[SmartGuide:popup] ${label}`, data ?? "");
}

let pageData = null;
let pageType = "content";
let conversationHistory = [];
let analysisCache = null;

// Models that are safe to use — anything NOT in this list gets wiped from storage
const VALID_MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash",
  "gemini-2.5-flash",
  "auto",
];

// Runs once when the popup opens — wipes any stale/bad model from storage
// BEFORE any API call can use it. Returns a Promise so we can await it.
function sanitiseStoredModels() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["selectedModel", "lastWorkingModel"], (stored) => {
      const toRemove = [];
      const toSet    = {};

      if (stored.lastWorkingModel && !VALID_MODELS.includes(stored.lastWorkingModel)) {
        toRemove.push("lastWorkingModel");
      }
      if (stored.selectedModel && !VALID_MODELS.includes(stored.selectedModel)) {
        toSet.selectedModel = "auto";
      }

      const done = () => resolve();
      if (toRemove.length) {
        chrome.storage.local.remove(toRemove, done);
      } else if (Object.keys(toSet).length) {
        chrome.storage.local.set(toSet, done);
      } else {
        resolve();
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Await sanitise so storage is guaranteed clean before any API call
  await sanitiseStoredModels();

  initEventListeners();
  try {
    const apiKey = await getStoredKey();
    if (!apiKey) {
      showScreen("api");
    } else {
      showScreen("main");
      await initMain();
    }
  } catch (err) {
    showScreen("api");
  }
});


function initEventListeners() {
  // ── API key save ──
  const saveKeyBtn = document.getElementById("save-key-btn");
  const apiKeyInput = document.getElementById("api-key-input");
  if (saveKeyBtn && apiKeyInput) {
    saveKeyBtn.addEventListener("click", async () => {
      const key = apiKeyInput.value.trim();
      if (!key || key.length < 20) return alert("Please enter a valid Gemini API key");
      const originalText = saveKeyBtn.textContent;
      saveKeyBtn.textContent = "Saving…";
      saveKeyBtn.disabled = true;
      try {
        await storeKey(key);
        const saved = await getStoredKey();
        if (!saved) throw new Error("Key not persisted to storage");
        showScreen("main");
        await initMain();
      } catch (err) {
        alert("Failed to save key: " + err.message);
      } finally {
        saveKeyBtn.textContent = originalText;
        saveKeyBtn.disabled = false;
      }
    });
    apiKeyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveKeyBtn.click();
    });
  }

  // ── Settings toggle ──
  document.getElementById("settings-toggle")?.addEventListener("click", toggleSettings);

  // ── Update key ──
  const updateKeyBtn = document.getElementById("update-key-btn");
  const settingsApiInput = document.getElementById("settings-api-input");
  if (updateKeyBtn && settingsApiInput) {
    updateKeyBtn.addEventListener("click", async () => {
      const key = settingsApiInput.value.trim();
      if (!key || key.length < 20) return alert("Please enter a valid Gemini API key");
      await storeKey(key);
      const model = document.getElementById("model-select")?.value;
      if (model) await chrome.storage.local.set({ selectedModel: model });
      analysisCache = null;
      alert("Settings saved!");
    });
  }

  // ── Load saved model ──
  chrome.storage.local.get(["selectedModel"], (r) => {
    if (r.selectedModel) {
      const sel = document.getElementById("model-select");
      if (sel) sel.value = r.selectedModel;
    }
  });

  // ── Clear key ──
  document.getElementById("clear-key-btn")?.addEventListener("click", async () => {
    await chrome.storage.local.remove("apiKey");
    location.reload();
  });

  // ── Tab switching ──
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      // deactivate all tabs and panels
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((p) => p.classList.remove("active"));
      // hide settings if open
      settingsOpen = false;
      const tabBar = document.getElementById("tab-bar");
      tabBar.style.opacity = "";
      tabBar.style.pointerEvents = "";
      // activate chosen tab
      tab.classList.add("active");
      document.getElementById(`panel-${target}`)?.classList.add("active");
    });
  });

  // ── Chat send ──
  document.getElementById("send-btn")?.addEventListener("click", sendChat);
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
}

// ── Main initialisation ──
async function initMain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    let hostname = "";
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      hostname = tab.url;
    }
    document.getElementById("page-url-label").textContent = hostname;

    const restrictedProtocols = [
      "chrome:", "chrome-extension:", "edge:", "brave:", "vivaldi:",
      "opera:", "about:", "moz-extension:", "file:",
    ];
    if (restrictedProtocols.some((p) => tab.url.startsWith(p))) {
      showHomeGreeting();
      const badge = document.getElementById("page-type-badge");
      badge.textContent = "Home";
      badge.className = "page-badge content";
      return;
    }

    showLoadingState(hostname);

    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
      .catch(() => {});

    pageData = await chrome.tabs
      .sendMessage(tab.id, { type: "GET_PAGE_DATA" })
      .catch(() => null);

    if (!pageData) {
      showAnalysisError("Could not read page content. Try refreshing the page.");
      return;
    }

    pageType = pageData.pageType;
    const badge = document.getElementById("page-type-badge");
    badge.textContent = pageType === "tool" ? "Tool" : "Content";
    badge.className = `page-badge ${pageType}`;

    const cacheKey = `analysis_v2_${pageData.url}`;
    const cached = await getCachedAnalysis(cacheKey);
    if (cached) {
      analysisCache = cached;
      renderAnalysis(cached);
      return;
    }

    setQuickPrompts(pageType);
    await runAnalysis(cacheKey);
  } catch (err) {
    showAnalysisError("Extension error: " + err.message);
  }
}

// ── Home / loading states ──
function showHomeGreeting() {
  setStatusCards("idle", "idle");
  const summaryEl = document.getElementById("summary-body");
  summaryEl.className = "summary-body";
  summaryEl.innerHTML = `
    <div style="padding:16px 0 8px; color:var(--text2); line-height:1.7; font-size:12px;">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--text);">Ready when you are</div>
      Visit any website and open SmartGuide to get a scam check, data verification, and AI summary.
    </div>
  `;
  document.getElementById("quick-prompts").innerHTML = "";
}

function showLoadingState(hostname) {
  setStatusCards("loading", "loading");
  const summaryEl = document.getElementById("summary-body");
  summaryEl.className = "summary-body loading-text";
  summaryEl.innerHTML = `
    <div class="skeleton w90"></div>
    <div class="skeleton w70"></div>
    <div class="skeleton w80"></div>
    <div class="skeleton w55"></div>
  `;
}

// ── Status cards ──
function setStatusCards(scamState, dataState, scamDetail = "", dataDetail = "") {
  const scamBox = document.getElementById("scam-status-box");
  const dataBox = document.getElementById("data-status-box");
  if (!scamBox || !dataBox) return;

  const scamValueEl  = document.getElementById("scam-value");
  const scamDetailEl = document.getElementById("scam-detail");
  const dataValueEl  = document.getElementById("data-value");
  const dataDetailEl = document.getElementById("data-detail");

  const scamMap = {
    loading:    { label: "Scanning…",   cls: "loading", sub: "Analyzing page content" },
    idle:       { label: "—",           cls: "idle",    sub: "Open a website to begin" },
    safe:       { label: "Not a Scam",  cls: "safe",    sub: scamDetail || "Looks genuine" },
    suspicious: { label: "Suspicious",  cls: "warn",    sub: scamDetail || "Use caution" },
    scam:       { label: "Likely Scam", cls: "danger",  sub: scamDetail || "High risk detected" },
    unknown:    { label: "Unknown",     cls: "idle",    sub: scamDetail || "Not enough info" },
  };

  const dataMap = {
    loading: { label: "Checking…",  cls: "loading", sub: "Verifying claims" },
    idle:    { label: "—",          cls: "idle",    sub: "Open a website to begin" },
    true:    { label: "Verified ✓", cls: "safe",    sub: dataDetail || "Claims look accurate" },
    false:   { label: "False Data", cls: "danger",  sub: dataDetail || "Misleading info found" },
    mixed:   { label: "Mixed",      cls: "warn",    sub: dataDetail || "Some claims unverified" },
    unknown: { label: "Unknown",    cls: "idle",    sub: dataDetail || "Not enough info" },
  };

  const scam = scamMap[scamState] || scamMap.unknown;
  const data = dataMap[dataState] || dataMap.unknown;

  scamBox.className = `status-card ${scam.cls}`;
  dataBox.className = `status-card ${data.cls}`;

  if (scamValueEl)  scamValueEl.textContent  = scam.label;
  if (scamDetailEl) scamDetailEl.textContent = scam.sub;
  if (dataValueEl)  dataValueEl.textContent  = data.label;
  if (dataDetailEl) dataDetailEl.textContent = data.sub;
}
function trustToScamState(verdict) {
  const v = (verdict || "").toLowerCase();
  if (v.includes("genuine") || v.includes("not a scam") || v.includes("safe")) return "safe";
  if (v.includes("scam")) return "scam";
  if (v.includes("suspicious")) return "suspicious";
  return "unknown";
}

function factToDataState(factCheck) {
  if (!factCheck) return "unknown";
  const falseCount     = factCheck.falseClaims?.length    || 0;
  const verifiedCount  = factCheck.verifiedClaims?.length || 0;
  const unverifiedCount= factCheck.unverifiedClaims?.length|| 0;
  const redFlagCount   = factCheck.redFlags?.length       || 0;

  if (falseCount > 0 || redFlagCount > 0) return "false";
  if (verifiedCount > 0 && unverifiedCount === 0) return "true";
  if (verifiedCount > 0 || unverifiedCount > 0) return "mixed";
  return "unknown";
}

function dataVerdictToState(data) {
  if (data.factCheck) return factToDataState(data.factCheck);
  const v = String(data.dataVerdict || "").toLowerCase();
  if (v === "true") return "true";
  if (v === "false") return "false";
  if (v === "mixed") return "mixed";
  return "unknown";
}

function updateStatusCards(data) {
  const scamState  = trustToScamState(data.trustCheck?.verdict || data.scamVerdict);
  const dataState  = dataVerdictToState(data);
  const scamDetail = data.trustCheck?.details || data.scamDetail || data.trustCheck?.verdict || data.scamVerdict || "";
  const falseCount    = data.factCheck?.falseClaims?.length   || 0;
  const verifiedCount = data.factCheck?.verifiedClaims?.length|| 0;
  let dataDetail = data.dataDetail || "";
  if (!dataDetail) {
    if (dataState === "false") dataDetail = `${falseCount || 1} false claim(s) found`;
    else if (dataState === "true") dataDetail = `${verifiedCount || 1} verified claim(s)`;
    else if (dataState === "mixed") dataDetail = "Some claims need checking";
  }

  setStatusCards(scamState, dataState, scamDetail, dataDetail);
}

// ── Analysis ──
async function runAnalysis(cacheKey) {
  if (analysisCache) {
    renderAnalysis(analysisCache);
    return;
  }

  const { reply: result, error } = await callGemini(null, true);
  if (!result) {
    showAnalysisError(error || "Could not reach Gemini. Please try again.");
    return;
  }

  const parsed = parseAnalysisJson(result);
  if (!parsed?.summary) {
    showAnalysisError("Could not read the AI response. Please try again.");
    return;
  }

  analysisCache = parsed;
  if (cacheKey) await setCachedAnalysis(cacheKey, parsed);
  renderAnalysis(parsed);
}

function unescapeJsonString(str) {
  return (str || "")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (raw.scamVerdict || raw.dataVerdict) {
    const dataVerdict = String(raw.dataVerdict || "").toLowerCase();
    const factCheck = { verifiedClaims: [], unverifiedClaims: [], falseClaims: [], redFlags: [] };

    if (dataVerdict === "true")  factCheck.verifiedClaims = [raw.dataDetail || "Claims appear accurate"];
    else if (dataVerdict === "false") factCheck.falseClaims = [raw.dataDetail || "Misleading information found"];
    else if (dataVerdict === "mixed") factCheck.unverifiedClaims = [raw.dataDetail || "Some claims need checking"];

    return {
      summary: raw.summary || "",
      trustCheck: {
        verdict: raw.scamVerdict || "Unknown",
        details: raw.scamDetail || "",
      },
      factCheck,
    };
  }

  return {
    summary: raw.summary || "",
    trustCheck: raw.trustCheck || null,
    factCheck:  raw.factCheck  || null,
  };
}

function parseAnalysisJson(text) {
  if (!text) return null;

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  for (const candidate of [cleaned, extractJsonBlock(cleaned)]) {
    if (!candidate) continue;
    try {
      return normalizeAnalysis(JSON.parse(candidate));
    } catch { /* try next */ }
  }

  return normalizeAnalysis(extractPartialAnalysis(cleaned));
}

function extractJsonBlock(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

function extractPartialAnalysis(text) {
  const result = {};

  const summaryMatch = text.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (summaryMatch) {
    result.summary = unescapeJsonString(summaryMatch[1]);
  } else {
    const openMatch = text.match(/"summary"\s*:\s*"([\s\S]+)$/);
    if (openMatch) {
      result.summary = unescapeJsonString(
        openMatch[1]
          .replace(/"?\s*,?\s*"(?:scamVerdict|trustCheck|dataVerdict|factCheck)".*$/, "")
          .trim()
      );
    }
  }

  const scamMatch  = text.match(/"scamVerdict"\s*:\s*"([^"]+)"/);
  const trustMatch = text.match(/"verdict"\s*:\s*"([^"]+)"/);
  if (scamMatch || trustMatch) {
    result.scamVerdict = scamMatch?.[1] || trustMatch[1];
    const detailMatch =
      text.match(/"scamDetail"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
      text.match(/"details"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (detailMatch) result.scamDetail = unescapeJsonString(detailMatch[1]);
  }

  const dataMatch = text.match(/"dataVerdict"\s*:\s*"([^"]+)"/);
  if (dataMatch) {
    result.dataVerdict = dataMatch[1];
    const detailMatch = text.match(/"dataDetail"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (detailMatch) result.dataDetail = unescapeJsonString(detailMatch[1]);
  }

  return result.summary || result.scamVerdict || result.dataVerdict ? result : null;
}

function showSummaryText(text) {
  const summaryEl = document.getElementById("summary-body");
  summaryEl.className = "summary-body";
  summaryEl.textContent = text || "No summary available.";
}

function renderAnalysis(data) {
  updateStatusCards(data);
  showSummaryText(data.summary || "No summary available.");
}

// ── Quick prompts ──
function setQuickPrompts(type) {
  const prompts =
    type === "tool"
      ? ["What does this do?", "How do I get started?", "Explain the main buttons"]
      : ["Summarize this", "Is this site trustworthy?", "What should I watch out for?"];

  const container = document.getElementById("quick-prompts");
  container.innerHTML = "";
  prompts.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "qp-chip";
    btn.textContent = p;
    btn.addEventListener("click", () => {
      // Switch to Ask AI tab first
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((panel) => panel.classList.remove("active"));
      document.querySelector('.tab[data-tab="chat"]')?.classList.add("active");
      document.getElementById("panel-chat")?.classList.add("active");

      document.getElementById("chat-input").value = p;
      sendChat();
    });
    container.appendChild(btn);
  });
}

// ── Chat ──
async function sendChat() {
  const input = document.getElementById("chat-input");
  const question = input.value.trim();
  if (!question) return;

  input.value = "";

  // Hide empty state on first message
  const emptyEl = document.getElementById("chat-empty");
  if (emptyEl) emptyEl.remove();

  addMessage("user", question);
  const typingEl = showTyping();

  const { reply, error } = await callGemini(question, false);
  typingEl.remove();

  if (reply) {
    addMessage("ai", reply);
    conversationHistory.push({ role: "user", content: question });
    conversationHistory.push({ role: "assistant", content: reply });
    if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);
  } else {
    // Show the real error so user knows what actually went wrong
    const msg = error || "No response received. Please try again.";
    addMessage("ai", `⚠ ${msg}`);
  }
}

function addMessage(role, text) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `
    <div class="msg-avatar">${role === "user" ? "👤" : "⚡"}</div>
    <div class="msg-bubble">${escapeHtml(text)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "msg ai";
  div.innerHTML = `
    <div class="msg-avatar">⚡</div>
    <div class="msg-bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// ── Gemini API call ──
// Returns { reply, error } — never throws.
async function callGemini(userQuestion, isFirstAnalysis) {
  if (!pageData) return { reply: null, error: "No page data available." };

  const sendBtn = document.getElementById("send-btn");
  if (sendBtn) sendBtn.disabled = true;

  try {
    // Single attempt — background.js handles all model retries internally
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "CALL_GEMINI",
        payload: {
          pageData,
          userQuestion,
          conversationHistory: isFirstAnalysis ? [] : conversationHistory,
          isAnalysis: isFirstAnalysis,
        },
      });
    } catch (err) {
      // Background service worker not ready yet — retry once after short wait
      if (err.message?.includes("receiving end does not exist")) {
        await sleep(600);
        try {
          response = await chrome.runtime.sendMessage({
            type: "CALL_GEMINI",
            payload: {
              pageData,
              userQuestion,
              conversationHistory: isFirstAnalysis ? [] : conversationHistory,
              isAnalysis: isFirstAnalysis,
            },
          });
        } catch (err2) {
          return { reply: null, error: "Extension not ready. Try reloading the page." };
        }
      } else {
        return { reply: null, error: err.message || "Unknown error." };
      }
    }

    if (!response) {
      return { reply: null, error: "No response from extension background." };
    }

    if (!response.ok) {
      const errMsg = response.error || "Unknown API error.";
      if (isFirstAnalysis) showAnalysisError(errMsg);
      return { reply: null, error: errMsg };
    }

    return { reply: response.data, error: null };

  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Settings toggle ──
let settingsOpen = false;

function toggleSettings() {
  settingsOpen = !settingsOpen;
  const tabBar = document.getElementById("tab-bar");

  // Hide all panels first
  document.querySelectorAll(".tab-content").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));

  if (settingsOpen) {
    // Show settings panel
    document.getElementById("panel-settings").classList.add("active");
    tabBar.style.opacity = "0.4";
    tabBar.style.pointerEvents = "none";
  } else {
    // Restore Analysis tab
    document.getElementById("panel-analysis").classList.add("active");
    document.querySelector('.tab[data-tab="analysis"]')?.classList.add("active");
    tabBar.style.opacity = "";
    tabBar.style.pointerEvents = "";
  }
}

// ── Screen switching ──
function showScreen(name) {
  document.getElementById("api-screen").classList.toggle("hidden", name !== "api");
  document.getElementById("main-screen").classList.toggle("hidden", name !== "main");
}

// ── Error display ──
function showAnalysisError(msg) {
  setStatusCards("unknown", "unknown", "Analysis failed", msg);
  const summaryEl = document.getElementById("summary-body");
  summaryEl.className = "summary-body";
  summaryEl.innerHTML = `<div class="error-msg">⚠ ${escapeHtml(msg || "Unknown error")}</div>`;
}

// ── Storage helpers ──
function getStoredKey() {
  return new Promise((res) => chrome.storage.local.get("apiKey", (r) => res(r.apiKey || "")));
}

function storeKey(key) {
  return new Promise((res) => chrome.storage.local.set({ apiKey: key }, res));
}

function getCachedAnalysis(key) {
  return new Promise((res) => chrome.storage.session.get(key, (r) => res(r[key] || null)));
}

function setCachedAnalysis(key, data) {
  return new Promise((res) => chrome.storage.session.set({ [key]: data }, res));
}

// ── HTML escape ──
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
