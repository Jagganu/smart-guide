// content.js — Extracts page content and metadata for SmartGuide AI

(function () {
  // Guard: prevent double-injection error
  if (window.__smartGuideInjected) return;
  window.__smartGuideInjected = true;

  const DEBUG = true; // safely inside IIFE now — no redeclaration

  function dbg(label, data) {
    if (!DEBUG) return;
    console.log(`%c[SmartGuide:content] ${label}`, "color:#00e5c3;font-weight:bold;", data ?? "");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_PAGE_DATA") {
      const data = extractPageData();
      dbg("Page data extracted", {
        pageType: data.pageType,
        bodyTextLength: data.bodyText.length,
        uiElements: data.uiElements.length,
        url: data.url,
      });
      sendResponse(data);
    }
    return true;
  });

  function extractPageData() {
    const url = window.location.href;
    const title = document.title || "";
    const metaDesc = document.querySelector('meta[name="description"]')?.content || "";
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
    const ogType = document.querySelector('meta[property="og:type"]')?.content || "";

    // Detect page type heuristics
    const pageType = detectPageType(url, title, metaDesc, ogType);

    // Extract readable body text (strip nav/footer noise)
    const bodyText = extractBodyText();

    // Extract interactive elements for tool pages
    const uiElements = pageType === "tool" ? extractUIElements() : [];

    return {
      url,
      title,
      metaDesc,
      ogTitle,
      ogType,
      pageType,
      bodyText: bodyText.slice(0, 8000), // token budget
      uiElements,
    };
  }

  function detectPageType(url, title, desc, ogType) {
    const toolKeywords = [
      "dashboard", "console", "admin", "app", "editor", "studio",
      "workspace", "settings", "portal", "platform", "tool", "builder",
      "figma", "notion", "trello", "airtable", "canva", "slack",
      "github", "gitlab", "jira", "asana", "linear", "vercel",
      "netlify", "supabase", "firebase", "aws", "azure", "gcp",
    ];
    const combined = (url + " " + title + " " + desc).toLowerCase();
    const isTool = toolKeywords.some((kw) => combined.includes(kw));

    const inputs = document.querySelectorAll("input, select, textarea, button").length;
    const paragraphs = document.querySelectorAll("p, article, section").length;
    const hasHighInteractivity = inputs > 10 && inputs > paragraphs;

    dbg("Page type detection", { isTool, hasHighInteractivity, inputs, paragraphs, ogType });

    if (isTool || hasHighInteractivity) return "tool";
    if (ogType === "article" || ogType === "website") return "content";

    const wordCount = document.body.innerText.trim().split(/\s+/).length;
    dbg("Word count fallback", { wordCount });
    return wordCount > 300 ? "content" : "tool";
  }

  function extractBodyText() {
    // Clone body and remove noisy elements
    const clone = document.body.cloneNode(true);
    const noise = clone.querySelectorAll(
      "nav, footer, header, script, style, noscript, iframe, [aria-hidden='true'], .ad, .advertisement, .cookie-banner"
    );
    noise.forEach((el) => el.remove());

    return clone.innerText.replace(/\s+/g, " ").trim();
  }

  function extractUIElements() {
    const elements = [];
    const seen = new Set();

    // Buttons
    document.querySelectorAll("button, [role='button'], a.btn, a.button").forEach((el) => {
      const label = (el.innerText || el.getAttribute("aria-label") || el.title || "").trim();
      if (label && !seen.has(label) && label.length < 80) {
        seen.add(label);
        elements.push({ type: "button", label });
      }
    });

    // Nav links
    document.querySelectorAll("nav a, [role='navigation'] a").forEach((el) => {
      const label = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (label && !seen.has(label) && label.length < 60) {
        seen.add(label);
        elements.push({ type: "nav", label });
      }
    });

    // Inputs / forms
    document.querySelectorAll("input, select, textarea").forEach((el) => {
      const label =
        el.getAttribute("placeholder") ||
        el.getAttribute("aria-label") ||
        document.querySelector(`label[for='${el.id}']`)?.innerText ||
        el.name ||
        "";
      if (label && !seen.has(label) && label.length < 80) {
        seen.add(label);
        elements.push({ type: el.tagName.toLowerCase(), label: label.trim() });
      }
    });

    return elements.slice(0, 60); // cap at 60 elements
  }
})();
