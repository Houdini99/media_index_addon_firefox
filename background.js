"use strict";

const ICON_URL = browser.runtime.getURL("icons/icon48.png");

// ---------------------------------------------------------------------------
// Configurable settings (loaded from browser.storage.local)
// ---------------------------------------------------------------------------
//
// `baseUrl`    — origin of the user's media index, e.g. "https://media.example.com".
// `nativeHost` — name of the installed yt-dlp helper for the nativeMessaging API.
//
// Both are user-editable from the options page. We mirror them into module-level
// `let`s so synchronous helpers can read the current values without awaiting.

const DEFAULT_NATIVE_HOST = "download_to_index.dl_helper";
let BASE_URL = "";
let NATIVE_HOST = DEFAULT_NATIVE_HOST;

// Uploads the user kicked off while logged out, waiting on a successful login.
// A queue (not a single slot) so right-clicking several items in quick succession
// doesn't silently lose all but the last.  Cleared in bulk on the first
// post-login navigation that lands on a recognised same-origin page.
const pendingUploads = [];
// id of the login tab we opened (if any) so we can close it once and don't
// keep opening new ones for each queued intent.
let loginTabId = null;

// Concurrent-upload cap.  Right-clicking many large files in quick succession
// would otherwise saturate the link and stress the server; queue the rest.
const MAX_CONCURRENT = 2;
const uploadQueue = [];
let activeUploads = 0;

// ---------------------------------------------------------------------------
// Referer/Origin rewrite
// ---------------------------------------------------------------------------
//
// Flask-WTF runs WTF_CSRF_SSL_STRICT (on by default for HTTPS sites), which
// rejects any POST whose Referer header is missing or not same-origin with
// the host.  An extension-originated fetch sends either no Referer at all
// or 'moz-extension://UUID/', both of which fail that check — so every
// POST gets a 400 even though the CSRF token itself is valid.
//
// Referer is a forbidden header for fetch(), so we can't set it in the
// request init.  Instead we rewrite headers on-the-fly with webRequest.
//
// The listener's URL filter is fixed at registration time, so when the user
// changes the configured host we have to remove and re-add the listener.

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
  // Skip registration when the user hasn't granted host access yet — the
  // listener would otherwise sit idle and Firefox logs noisy permission
  // warnings.  We re-run this from permissions.onAdded once access is granted.
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
    webRequestListener = null;
    webRequestUrlFilter = null;
  }
}

// ---------------------------------------------------------------------------
// Settings load / change handling
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await browser.storage.local.get({ baseUrl: "", nativeHost: DEFAULT_NATIVE_HOST });
  BASE_URL = (stored.baseUrl || "").replace(/\/+$/, "");
  NATIVE_HOST = stored.nativeHost || DEFAULT_NATIVE_HOST;
  applyHostListener();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let hostChanged = false;
  if (changes.baseUrl) {
    BASE_URL = (changes.baseUrl.newValue || "").replace(/\/+$/, "");
    hostChanged = true;
  }
  if (changes.nativeHost) {
    NATIVE_HOST = changes.nativeHost.newValue || DEFAULT_NATIVE_HOST;
  }
  if (hostChanged) applyHostListener();
});

// Re-evaluate listener registration when host permission grants change.  The
// user can grant or revoke origins from the addons manager at any time, and we
// must keep our webRequest filter in sync — registered when access exists,
// removed when it doesn't.
browser.permissions.onAdded.addListener(() => { applyHostListener(); });
browser.permissions.onRemoved.addListener(() => { applyHostListener(); });

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// Open the options page on first install so the user can configure the host
// before trying to upload anything.
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const stored = await browser.storage.local.get({ baseUrl: "" });
  if (!stored.baseUrl) browser.runtime.openOptionsPage();
});

// Toolbar button opens the options page.
browser.action.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

// Register at top level (not just onInstalled) so every background-page
// restart re-applies the current `contexts` list.  Firefox persists menu
// registrations across event-page restarts, so onInstalled alone can leave
// an old registration in place even after the extension is updated.
// removeAll() clears any stale entry first.
browser.contextMenus.removeAll();
browser.contextMenus.create({
  id: "download-to-index",
  title: "Download to Index",
  // page/frame are needed so the menu shows up when the user right-clicks on
  // a transparent overlay that covers the real <video>/<img>/<audio>.
  // link covers anchors that point directly at a media file (CDN URLs etc.).
  contexts: ["image", "video", "audio", "page", "frame", "link"]
});

// Kick off settings load. All paths that need BASE_URL await ensureConfigured()
// first, so it's fine that this is async and may complete after the menu
// registration above.
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
// Context menu handler
// ---------------------------------------------------------------------------

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "download-to-index") return;

  if (!(await ensureConfigured())) return;

  // 1. Fast path: the browser already identified the media element for us.
  let srcUrl = info.srcUrl || null;

  // 2. Link context: the user right-clicked an <a> whose href points at a
  //    media file (e.g. a download link to an .mp4 on a CDN).  Use that
  //    before probing, since it's the user's explicit choice.
  if (!srcUrl && info.linkUrl) {
    srcUrl = info.linkUrl;
  }

  // 3. Fallback: ask the content script in the exact frame the user clicked in
  //    to look up the real media element — useful when a transparent overlay
  //    intercepts the right-click, or when the media is nested in an iframe.
  if (!srcUrl) {
    srcUrl = await probeFrame(tab.id, info.frameId ?? 0, info.targetElementId);
  }

  if (!srcUrl) {
    notify("Upload Failed", "Could not determine the media URL. Try right-clicking directly on the media.");
    return;
  }

  if (!(await hasSession())) {
    // Capture pageUrl now (not at upload time) so SPA navigation between the
    // right-click and the user finishing the modal doesn't store the wrong
    // source page on the upload record.
    pendingUploads.push({ srcUrl, tabId: tab.id, pageUrl: tab.url || null });
    // Reuse an already-open login tab if we have one, so a burst of right-clicks
    // doesn't spawn a tab per intent.
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
});

// Forget the login tab once the user closes it manually so the next
// logged-out right-click opens a fresh one instead of failing silently.
browser.tabs.onRemoved.addListener((tabId) => {
  if (loginTabId === tabId) loginTabId = null;
});

// Ask a single frame's content script to resolve the media URL near the
// right-click.  Returns null if the frame can't find anything (or the content
// script isn't loaded, e.g. on about:/chrome: pages).
async function probeFrame(tabId, frameId, targetElementId) {
  try {
    const resp = await browser.tabs.sendMessage(
      tabId,
      { action: "probe", targetElementId },
      { frameId }
    );
    return resp?.srcUrl || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Detect successful login and resume pending upload
// ---------------------------------------------------------------------------

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingUploads.length || changeInfo.status !== "complete" || !tab.url) return;
  if (!BASE_URL) return;

  // User landed on the main gallery or upload page after logging in
  const isHome = tab.url === `${BASE_URL}/` || tab.url.startsWith(`${BASE_URL}/?`);
  const isUploadPage = tab.url === `${BASE_URL}/upload`;
  if (!isHome && !isUploadPage) return;

  if (!(await hasSession())) return;

  // Drain the whole queue — every intent the user lined up while logged out
  // gets its modal in its original tab.
  const drained = pendingUploads.splice(0, pendingUploads.length);
  if (loginTabId === tabId) loginTabId = null;
  browser.tabs.remove(tabId).catch(() => {});
  for (const job of drained) {
    triggerModal(job.tabId, job.srcUrl, job.pageUrl);
  }
});

// ---------------------------------------------------------------------------
// Messages from content script
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "upload") {
    const tabId   = sender.tab ? sender.tab.id  : null;
    // Prefer the pageUrl the modal captured at right-click time (carried by
    // the content script in msg.pageUrl) so SPA navigation between the
    // right-click and Upload doesn't record the post-navigation page.
    const pageUrl = msg.pageUrl || (sender.tab ? sender.tab.url : null);
    const uploadId = msg.uploadId || newUploadId();
    enqueueUpload({ srcUrl: msg.srcUrl, tags: msg.tags, tabId, uploadId, pageUrl });
  }
});

function newUploadId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Send a progress update for a specific upload to the page that started it.
// Always target frameId 0 — the pill UI lives in the top frame, the same place
// the modal was rendered.
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

// Build a Cookie header string from all cookies stored for BASE_URL.
// Firefox enforces SameSite=Lax even for extension fetch() — the session
// cookie is NOT sent automatically on cross-origin POSTs.  Reading the
// cookies via the cookies API and injecting them as an explicit header
// bypasses that restriction (extensions are permitted to set Cookie).
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
    // Always render the modal in the top frame so it overlays the whole tab,
    // not a potentially tiny cross-origin iframe that triggered the click.
    // pageUrl is captured at right-click time and threaded back via the
    // upload message, so SPA navigation doesn't change the recorded source.
    await browser.tabs.sendMessage(tabId, { action: "showModal", srcUrl, pageUrl }, { frameId: 0 });
  } catch {
    notify("Error", "Could not show the tag input. Refresh the page and try again.");
  }
}

// Fetch the current CSRF token by GETting the upload page.
// cookieHeader must be passed in so both the GET and the subsequent POST
// use the same session — guaranteeing the token matches the session.
async function fetchCsrfToken(cookieHeader) {
  const headers = { Accept: "text/html" };
  if (cookieHeader) headers["Cookie"] = cookieHeader;

  const resp = await fetch(`${BASE_URL}/upload`, {
    credentials: "include",
    headers
  });
  if (!resp.ok || resp.url.includes("/login")) return null;

  const html = await resp.text();
  // Prefer the <meta> tag; fall back to the hidden input
  const m =
    html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/) ||
    html.match(/name="csrf_token"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

// Some sites (Telegram Web, WhatsApp Web) serve media via a service worker
// that intercepts requests originating from the page's context — typically
// decoding bytes from IndexedDB or an in-memory cache.  A fetch from the
// background script bypasses the SW entirely and gets a placeholder/404, so
// for those origins we have to delegate the download to the content script.
//
// blob: URLs are also always routed in-page: they're scoped to the document
// that created them, so a background-script fetch can't see them at all
// (it rejects with bare "NetworkError when attempting to fetch resource").
// new URL("blob:https://host/...").hostname is "" — only `origin` carries the
// inner host — so we have to special-case the protocol before host-matching.
function requiresInPageFetch(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:") return true;
    return u.hostname === "web.telegram.org" || u.hostname === "web.whatsapp.com";
  } catch {
    return false;
  }
}

// URLs ending in one of these extensions are already direct media files —
// no point paying the yt-dlp roundtrip (which can take seconds to tens of
// seconds per call) just to confirm "yes, that IS the video URL".
const DIRECT_MEDIA_EXT_RE = /\.(?:jpe?g|png|gif|webp|heic|heif|avif|svg|bmp|ico|mp4|m4v|webm|mov|mkv|avi|flv|3gp|mp3|m4a|ogg|oga|wav|flac|aac|opus)(?:[?#]|$)/i;

function isDirectMediaUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:" || u.protocol === "data:") return true;
    return DIRECT_MEDIA_EXT_RE.test(u.pathname);
  } catch {
    return false;
  }
}

// Try the native messaging host (yt-dlp wrapper) to resolve HLS/DASH/site
// page URLs into a direct media URL.  If the host isn't installed or yt-dlp
// can't extract anything useful, we silently fall back to the original URL.
// Skipped for URLs that are clearly already direct media files, since yt-dlp
// has nothing to add and adds latency in the common case.
async function resolveSrcUrl(srcUrl, pageUrl) {
  if (isDirectMediaUrl(srcUrl)) return srcUrl;
  if (!NATIVE_HOST) return srcUrl;
  try {
    const reply = await browser.runtime.sendNativeMessage(
      NATIVE_HOST,
      { srcUrl, pageUrl }
    );
    if (reply && reply.kind === "direct" && reply.url) return reply.url;
  } catch {
    // Host not installed or crashed; original URL is still our best bet.
  }
  return srcUrl;
}

// Anti-download placeholder filenames we should never use as the upload
// filename, regardless of what URL pathway exposed them.
const PLACEHOLDER_NAMES = /^(?:nojs|noscript)\.mp4$/i;

// Map common MIME types to the extensions the backend accepts
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
    // Update each remaining queued job's position so the user can see the line move.
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

  // Best-effort filename hint shown in the pill before the headers come back.
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

  // 1. Read cookies once; reuse for both the CSRF GET and the upload POST -----
  const cookieHeader = await getCookieHeader();

  // 2. Get a fresh CSRF token ------------------------------------------------
  let csrfToken;
  try {
    csrfToken = await fetchCsrfToken(cookieHeader);
  } catch (e) {
    return finish(false, `CSRF fetch failed: ${e.message}`);
  }
  if (!csrfToken) {
    return finish(false, "Not logged in or session expired. Please log in and try again.");
  }

  // 3. Download the media as a Blob ------------------------------------------
  // First, give the native-messaging host (yt-dlp wrapper) a chance to resolve
  // a streaming/page URL into a direct media URL.  Falls back to the original
  // srcUrl if the host isn't installed or doesn't recognise the site.
  const resolvedUrl = await resolveSrcUrl(srcUrl, pageUrl);

  // Stream the body so we can report byte-level progress.  Throttled to ~10/s
  // so we don't flood the message channel on fast/large transfers.
  let blob, filename, contentType = "";
  // The page-world helper may transparently retarget the URL (e.g. nojs.mp4
  // → blob:... for a Telegram image, or → progressive/documentN for a video).
  // It reports back what it actually fetched so we can name the file
  // correctly instead of using the placeholder URL we sent in.
  let fetchedUrl = null;
  try {
    if (requiresInPageFetch(resolvedUrl) && tabId != null) {
      // Delegate the download to the content script so the page's service
      // worker (e.g. Telegram Web's MTProto decoder) can intercept it.  The
      // content script reports its own download progress directly to the pill.
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

    // Derive a filename with the correct extension.  Try in order:
    //   1. fetchedUrl   — what the page helper actually downloaded
    //   2. resolvedUrl  — possibly rewritten by yt-dlp / native host
    //   3. srcUrl       — what the user originally right-clicked
    //   4. content-type — last resort
    // Skip anti-download placeholder filenames (nojs.mp4) so we don't tag a
    // JPEG with .mp4 just because that was the URL we sent the helper.
    // decodeURIComponent so spaces and unicode in filenames survive intact.
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

  // 4. POST multipart form to /upload ----------------------------------------
  // Use XHR (not fetch) because only XHR exposes upload-byte progress via
  // xhr.upload.onprogress.  Without it, large uploads sit on an indeterminate
  // animation long enough that the "stuck" detector trips.
  status({ phase: "uploading", filename, size: blob.size, loaded: 0, total: blob.size });

  let uploadResp;
  try {
    const fd = new FormData();
    fd.append("files", blob, filename);
    fd.append("tags_0", tags);
    fd.append("csrf_token", csrfToken);
    if (pageUrl) fd.append("source_url", pageUrl);

    // Explicitly set Cookie so the same session is used as in the CSRF GET,
    // bypassing the SameSite=Lax restriction on cross-origin POST requests.
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
        // All bytes uploaded; server is now ingesting & generating thumbnails.
        status({ phase: "processing" });
      }
    );
  } catch (e) {
    return finish(false, `Upload request failed: ${e.message}`);
  }

  // 5. Parse the result -------------------------------------------------------
  if (!uploadResp.ok) {
    return finish(false, `Server returned HTTP ${uploadResp.status}.`);
  }
  if (uploadResp.url.includes("/login")) {
    return finish(false, "Session expired. Please log in and try again.");
  }

  // Flask always redirects back to /upload and communicates status via flash
  // messages embedded in the HTML, so inspect the response body.  NOTE: the
  // upload page's <style> block contains ".flash-danger" etc. as CSS rules —
  // we must match the actual rendered <div class="flash flash-*"> element,
  // not the bare class name, or we get false positives on every response.
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

// XHR-based POST that surfaces upload-byte progress, since fetch() does not.
// onProgress(loaded, total) fires while bytes are streaming to the server;
// onUploadComplete() fires the moment the last byte goes out (i.e. server is
// now processing).  Resolves with a fetch-like object once the response body
// is in.
function postWithProgress(url, body, headers, onProgress, onUploadComplete) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.responseType = "text";
    xhr.withCredentials = true;

    for (const [k, v] of Object.entries(headers)) {
      // Cookie is a "forbidden" header for normal pages but extensions with
      // host_permissions are permitted to set it.
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
