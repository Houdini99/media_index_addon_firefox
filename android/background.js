"use strict";

// Firefox Android port.
//
// Differences from the desktop background script:
//   * No contextMenus API on Android. The toolbar action triggers a content-
//     script media picker instead of a right-click menu entry.
//   * No nativeMessaging on Android. The yt-dlp resolution path is removed —
//     only directly downloadable media works on this build.
//   * webRequest / webRequestBlocking, cookies, notifications, storage all
//     work the same as desktop, so the upload flow is otherwise unchanged.

const ICON_URL = browser.runtime.getURL("icons/icon48.png");

// ---------------------------------------------------------------------------
// Configurable settings (loaded from browser.storage.local)
// ---------------------------------------------------------------------------

let BASE_URL = "";

// Uploads the user kicked off while logged out, waiting on a successful login.
const pendingUploads = [];
let loginTabId = null;

// Concurrent-upload cap.
const MAX_CONCURRENT = 2;
const uploadQueue = [];
let activeUploads = 0;

// ---------------------------------------------------------------------------
// Referer/Origin rewrite — same rationale as the desktop build (Flask-WTF
// CSRF requires same-origin Referer, and Referer is a forbidden header for
// fetch()).  We try to register the listener; on Android builds where
// webRequestBlocking isn't available it'll throw and we silently continue.
// The upload still works on most servers, only failing if WTF_CSRF_SSL_STRICT
// is on AND Referer/Origin can't be rewritten.
// ---------------------------------------------------------------------------

let webRequestListener = null;
let webRequestUrlFilter = null;

function rewriteReferer(details) {
  if (!BASE_URL) return {};
  const headers = details.requestHeaders.filter(h => {
    const n = h.name.toLowerCase();
    return n !== "referer" && n !== "origin";
  });
  headers.push({ name: "Referer", value: `${BASE_URL}/` });
  headers.push({ name: "Origin", value: BASE_URL });
  return { requestHeaders: headers };
}

async function hasHostPermission(baseUrl) {
  if (!baseUrl) return false;
  try {
    return await browser.permissions.contains({ origins: [`${baseUrl}/*`] });
  } catch {
    return false;
  }
}

async function applyHostListener() {
  if (webRequestListener) {
    try { browser.webRequest.onBeforeSendHeaders.removeListener(webRequestListener); } catch {}
    webRequestListener = null;
    webRequestUrlFilter = null;
  }
  if (!BASE_URL) return;
  if (!(await hasHostPermission(BASE_URL))) return;
  webRequestListener = rewriteReferer;
  webRequestUrlFilter = `${BASE_URL}/*`;
  try {
    browser.webRequest.onBeforeSendHeaders.addListener(
      webRequestListener,
      { urls: [webRequestUrlFilter] },
      ["blocking", "requestHeaders"]
    );
  } catch {
    // webRequestBlocking not available on this Firefox Android build — the
    // upload may still succeed if the server doesn't enforce strict CSRF.
    webRequestListener = null;
    webRequestUrlFilter = null;
  }
}

// ---------------------------------------------------------------------------
// Settings load / change handling
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await browser.storage.local.get({ baseUrl: "" });
  BASE_URL = (stored.baseUrl || "").replace(/\/+$/, "");
  applyHostListener();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.baseUrl) {
    BASE_URL = (changes.baseUrl.newValue || "").replace(/\/+$/, "");
    applyHostListener();
  }
});

browser.permissions.onAdded.addListener(() => { applyHostListener(); });
browser.permissions.onRemoved.addListener(() => { applyHostListener(); });

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const stored = await browser.storage.local.get({ baseUrl: "" });
  if (!stored.baseUrl) browser.runtime.openOptionsPage();
});

loadSettings();

async function ensureConfigured() {
  if (!BASE_URL) await loadSettings();
  if (!BASE_URL) {
    notify("Not configured", "Open the extension settings to set your media index server URL.");
    browser.runtime.openOptionsPage();
    return false;
  }
  if (!(await hasHostPermission(BASE_URL))) {
    notify("Permission required", "Open the extension settings and re-grant access to your media server.");
    browser.runtime.openOptionsPage();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Toolbar action — replaces right-click context menu on Android.
//
// On Firefox Android the toolbar action lives in the address-bar overflow
// menu.  Tapping it fires onClicked with the active tab.  We forward to the
// content script, which scans the page for media and shows a picker overlay.
// ---------------------------------------------------------------------------

browser.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  if (!(await ensureConfigured())) return;

  // Make sure the content script is loaded — some sites (e.g. about:reader,
  // pages opened before the extension was installed) won't have it yet.
  // scripting.executeScript no-ops if the script is already present.
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ["content.js"],
    });
  } catch {
    // Some pages (about:*, addons.mozilla.org) refuse injection. Tell the
    // user instead of silently doing nothing.
    notify("Cannot scan this page", "This page doesn't allow extension content. Try a regular webpage.");
    return;
  }

  try {
    await browser.tabs.sendMessage(tab.id, { action: "openPicker" }, { frameId: 0 });
  } catch {
    notify("Cannot scan this page", "Couldn't reach the page. Reload it and try again.");
  }
});

// ---------------------------------------------------------------------------
// Login flow & message handling
// ---------------------------------------------------------------------------

browser.tabs.onRemoved.addListener((tabId) => {
  if (loginTabId === tabId) loginTabId = null;
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingUploads.length || changeInfo.status !== "complete" || !tab.url) return;
  if (!BASE_URL) return;

  const isHome = tab.url === `${BASE_URL}/` || tab.url.startsWith(`${BASE_URL}/?`);
  const isUploadPage = tab.url === `${BASE_URL}/upload`;
  if (!isHome && !isUploadPage) return;

  if (!(await hasSession())) return;

  const drained = pendingUploads.splice(0, pendingUploads.length);
  if (loginTabId === tabId) loginTabId = null;
  browser.tabs.remove(tabId).catch(() => {});
  for (const job of drained) {
    triggerModal(job.tabId, job.srcUrl, job.pageUrl);
  }
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "upload") {
    const tabId   = sender.tab ? sender.tab.id  : null;
    const pageUrl = msg.pageUrl || (sender.tab ? sender.tab.url : null);
    const uploadId = msg.uploadId || newUploadId();
    enqueueUpload({ srcUrl: msg.srcUrl, tags: msg.tags, tabId, uploadId, pageUrl });
    return;
  }
  if (msg.action === "pickerSelected") {
    // The content-script picker emitted a chosen media URL. Run the same
    // login-gate the desktop right-click flow uses, then show the modal.
    handlePickerSelection(msg.srcUrl, sender.tab);
    return;
  }
});

async function handlePickerSelection(srcUrl, tab) {
  if (!srcUrl || !tab) return;
  if (!(await ensureConfigured())) return;

  if (!(await hasSession())) {
    pendingUploads.push({ srcUrl, tabId: tab.id, pageUrl: tab.url || null });
    if (loginTabId != null) {
      try { await browser.tabs.update(loginTabId, { active: true }); return; } catch {}
      loginTabId = null;
    }
    try {
      const loginTab = await browser.tabs.create({ url: `${BASE_URL}/login` });
      loginTabId = loginTab && loginTab.id != null ? loginTab.id : null;
    } catch {}
    return;
  }

  triggerModal(tab.id, srcUrl, tab.url || null);
}

function newUploadId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendStatus(tabId, uploadId, payload) {
  if (tabId == null) return;
  browser.tabs.sendMessage(
    tabId,
    { action: "uploadStatus", uploadId, ...payload },
    { frameId: 0 }
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hasSession() {
  if (!BASE_URL) return false;
  try {
    const cookie = await browser.cookies.get({ url: BASE_URL, name: "session" });
    return !!cookie;
  } catch {
    return false;
  }
}

async function getCookieHeader() {
  if (!BASE_URL) return null;
  try {
    const cookies = await browser.cookies.getAll({ url: BASE_URL });
    if (!cookies.length) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch {
    return null;
  }
}

async function triggerModal(tabId, srcUrl, pageUrl) {
  try {
    await browser.tabs.sendMessage(tabId, { action: "showModal", srcUrl, pageUrl }, { frameId: 0 });
  } catch {
    notify("Error", "Could not show the tag input. Refresh the page and try again.");
  }
}

async function fetchCsrfToken(cookieHeader) {
  const headers = { Accept: "text/html" };
  if (cookieHeader) headers["Cookie"] = cookieHeader;

  const resp = await fetch(`${BASE_URL}/upload`, {
    credentials: "include",
    headers
  });
  if (!resp.ok || resp.url.includes("/login")) return null;

  const html = await resp.text();
  const m =
    html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/) ||
    html.match(/name="csrf_token"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

// blob: URLs and SPA service-worker hosts always require in-page fetch.
function requiresInPageFetch(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:") return true;
    return u.hostname === "web.telegram.org" || u.hostname === "web.whatsapp.com";
  } catch {
    return false;
  }
}

// Anti-download placeholder filenames.
const PLACEHOLDER_NAMES = /^(?:nojs|noscript)\.mp4$/i;

const CT_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/avi": "avi",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
};

// ---------------------------------------------------------------------------
// Upload queue
// ---------------------------------------------------------------------------

function filenameHintFor(srcUrl) {
  try {
    return decodeURIComponent(new URL(srcUrl).pathname.split("/").pop()) || "media";
  } catch {
    return "media";
  }
}

function enqueueUpload(job) {
  if (activeUploads < MAX_CONCURRENT) {
    activeUploads++;
    runUpload(job);
  } else {
    uploadQueue.push(job);
    sendStatus(job.tabId, job.uploadId, {
      phase: "queued",
      filename: filenameHintFor(job.srcUrl),
      position: uploadQueue.length,
    });
  }
}

function pumpQueue() {
  activeUploads--;
  const next = uploadQueue.shift();
  if (next) {
    activeUploads++;
    uploadQueue.forEach((job, i) => sendStatus(job.tabId, job.uploadId, {
      phase: "queued", position: i + 1,
    }));
    runUpload(next);
  }
}

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------

async function runUpload(job) {
  const { srcUrl, tags, tabId, uploadId, pageUrl } = job;
  try {
  const status = (payload) => sendStatus(tabId, uploadId, payload);

  if (!(await ensureConfigured())) {
    status({ phase: "error", error: "Server URL not configured. Open the extension settings." });
    return;
  }

  let filenameHint = "media";
  try {
    filenameHint = decodeURIComponent(new URL(srcUrl).pathname.split("/").pop()) || "media";
  } catch {}

  status({ phase: "preparing", srcUrl, filename: filenameHint });

  const finish = (success, error, opts = {}) => {
    if (success) {
      status({ phase: opts.duplicate ? "duplicate" : "success" });
      if (opts.duplicate) {
        notify("Already in Index", "This file is already saved in your Index (duplicate).");
      } else {
        notify("Upload Successful", "Media was saved to your Index.");
      }
    } else {
      status({ phase: "error", error: error || "Unknown error." });
      notify("Upload Failed", error || "Unknown error.");
    }
  };

  const cookieHeader = await getCookieHeader();

  let csrfToken;
  try {
    csrfToken = await fetchCsrfToken(cookieHeader);
  } catch (e) {
    return finish(false, `CSRF fetch failed: ${e.message}`);
  }
  if (!csrfToken) {
    return finish(false, "Not logged in or session expired. Please log in and try again.");
  }

  // No native helper on Android — the URL is what we got from the picker.
  const resolvedUrl = srcUrl;

  let blob, filename, contentType = "";
  let fetchedUrl = null;
  try {
    if (requiresInPageFetch(resolvedUrl) && tabId != null) {
      status({ phase: "downloading", loaded: 0, total: null, filename: filenameHint });
      const reply = await browser.tabs.sendMessage(tabId, {
        action: "fetchInPage",
        srcUrl: resolvedUrl,
        uploadId,
      }, { frameId: 0 });
      if (!reply || !reply.ok) {
        throw new Error(reply && reply.error ? reply.error : "In-page fetch failed");
      }
      contentType = reply.contentType || "";
      fetchedUrl = reply.fetchedUrl || null;
      blob = new Blob([reply.bytes], contentType ? { type: contentType } : {});
    } else {
      const mediaResp = await fetch(resolvedUrl);
      if (!mediaResp.ok) throw new Error(`HTTP ${mediaResp.status}`);

      const totalHeader = mediaResp.headers.get("content-length");
      const total = totalHeader ? parseInt(totalHeader, 10) : null;
      contentType = (mediaResp.headers.get("content-type") || "").split(";")[0].trim();

      status({ phase: "downloading", loaded: 0, total, filename: filenameHint });

      if (mediaResp.body && mediaResp.body.getReader) {
        const reader = mediaResp.body.getReader();
        const chunks = [];
        let loaded = 0;
        let lastTick = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
          const now = Date.now();
          if (now - lastTick > 100) {
            status({ phase: "downloading", loaded, total });
            lastTick = now;
          }
        }
        status({ phase: "downloading", loaded, total: total ?? loaded });
        blob = new Blob(chunks, contentType ? { type: contentType } : {});
      } else {
        blob = await mediaResp.blob();
        status({ phase: "downloading", loaded: blob.size, total: blob.size });
      }
    }

    const safePathname = (u) => {
      try {
        const raw = new URL(u).pathname.split("/").pop() || "";
        return decodeURIComponent(raw);
      } catch {
        return "";
      }
    };
    const candidatePaths = [
      fetchedUrl ? safePathname(fetchedUrl) : "",
      safePathname(resolvedUrl),
      safePathname(srcUrl),
    ];
    filename = "";
    for (const p of candidatePaths) {
      if (p && p.includes(".") && !PLACEHOLDER_NAMES.test(p)) {
        filename = p;
        break;
      }
    }
    if (!filename) {
      const ct = contentType || blob.type || "";
      const ext = CT_TO_EXT[ct] || ct.split("/")[1] || "bin";
      filename = `media.${ext}`;
    }
  } catch (e) {
    return finish(false, `Could not fetch media: ${e.message}`);
  }

  status({ phase: "uploading", filename, size: blob.size, loaded: 0, total: blob.size });

  let uploadResp;
  try {
    const fd = new FormData();
    fd.append("files", blob, filename);
    fd.append("tags_0", tags);
    fd.append("csrf_token", csrfToken);
    if (pageUrl) fd.append("source_url", pageUrl);

    const uploadHeaders = { "X-CSRFToken": csrfToken };
    if (cookieHeader) uploadHeaders["Cookie"] = cookieHeader;

    let lastUploadTick = 0;
    uploadResp = await postWithProgress(
      `${BASE_URL}/upload`,
      fd,
      uploadHeaders,
      (loaded, total) => {
        const now = Date.now();
        if (now - lastUploadTick > 100) {
          status({ phase: "uploading", filename, size: blob.size, loaded, total });
          lastUploadTick = now;
        }
      },
      () => {
        status({ phase: "processing" });
      }
    );
  } catch (e) {
    return finish(false, `Upload request failed: ${e.message}`);
  }

  if (!uploadResp.ok) {
    return finish(false, `Server returned HTTP ${uploadResp.status}.`);
  }
  if (uploadResp.url.includes("/login")) {
    return finish(false, "Session expired. Please log in and try again.");
  }

  const html = uploadResp.text || "";
  const flashRe = /<div\s+class="flash\s+flash-(success|warning|danger)"/;
  const m = html.match(flashRe);
  const category = m ? m[1] : null;

  if (category === "danger") {
    return finish(false, "Server rejected the file (unsupported type or processing error).");
  }
  if (category === "warning") {
    return finish(true, null, { duplicate: true });
  }

  finish(true, null);
  } finally {
    pumpQueue();
  }
}

function postWithProgress(url, body, headers, onProgress, onUploadComplete) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.responseType = "text";
    xhr.withCredentials = true;

    for (const [k, v] of Object.entries(headers)) {
      try { xhr.setRequestHeader(k, v); } catch {}
    }

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    });
    xhr.upload.addEventListener("load", () => {
      onUploadComplete();
    });

    xhr.addEventListener("load", () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        url: xhr.responseURL || url,
        text: xhr.responseText
      });
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("abort", () => reject(new Error("Aborted")));
    xhr.addEventListener("timeout", () => reject(new Error("Timed out")));

    xhr.send(body);
  });
}

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: ICON_URL,
    title,
    message
  });
}
