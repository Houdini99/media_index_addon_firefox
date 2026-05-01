"use strict";

// Firefox Android port.
//
// On desktop, the user right-clicks media and the background script asks us
// for the URL.  Android has no context menu API, so the toolbar action sends
// us an "openPicker" message instead — we scan the page for media and let
// the user tap one to start the upload.  Everything downstream of that
// (modal, progress pill, in-page fetch for Telegram/WhatsApp) is identical.

if (!window.__indexAddonLoaded) {
  window.__indexAddonLoaded = true;

  // -------------------------------------------------------------------------
  // Right-click coordinate tracking
  //
  // Even though Android has no right-click, we keep tracking the most recent
  // touch point so the page_helper.js Telegram retarget logic still has
  // coordinates to query elementsFromPoint() with when the user picks a
  // Telegram blob/nojs.mp4 placeholder out of the picker.
  // -------------------------------------------------------------------------

  let lastCoords = null;

  const captureMouseCoords = (e) => {
    lastCoords = { x: e.clientX, y: e.clientY };
  };
  const captureTouchCoords = (e) => {
    const t = e.touches && e.touches[0];
    if (t) lastCoords = { x: t.clientX, y: t.clientY };
  };
  window.addEventListener("contextmenu", captureMouseCoords, true);
  window.addEventListener("mousedown", (e) => {
    if (e.button === 2) captureMouseCoords(e);
  }, true);
  window.addEventListener("touchstart", captureTouchCoords, true);

  // -------------------------------------------------------------------------
  // Message listener (receives commands from background.js)
  // -------------------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "openPicker") {
      showPicker();
      return;
    }
    if (msg.action === "showModal") {
      showModal(msg.srcUrl, msg.pageUrl);
      return;
    }
    if (msg.action === "uploadStatus") {
      updatePill(msg.uploadId, msg);
      return;
    }
    if (msg.action === "fetchInPage") {
      return fetchInPage(msg.srcUrl, msg.uploadId);
    }
  });

  // -------------------------------------------------------------------------
  // In-page fetch — Telegram/WhatsApp service-worker bypass.  Same logic as
  // the desktop build; on Android the picker can still surface blob: URLs
  // and we route them through the page helper too.
  // -------------------------------------------------------------------------

  let pageHelperReady = null;

  function injectPageHelper() {
    if (pageHelperReady) return pageHelperReady;
    pageHelperReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = browser.runtime.getURL("page_helper.js");
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(
        "page_helper.js failed to load — likely blocked by the page's CSP."
      ));
      (document.documentElement || document.head || document.body).appendChild(script);
    });
    return pageHelperReady;
  }

  const FETCH_IDLE_TIMEOUT_MS = 90_000;

  async function fetchInPage(srcUrl, uploadId) {
    try {
      await injectPageHelper();
    } catch (e) {
      return { ok: false, error: e.message };
    }

    return new Promise((resolve) => {
      const id = "idx-" + Math.random().toString(36).slice(2);
      let idleTimer = null;
      let settled = false;

      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        if (idleTimer != null) { clearTimeout(idleTimer); idleTimer = null; }
      };
      const settle = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload);
      };
      const armIdleTimer = () => {
        if (idleTimer != null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          settle({
            ok: false,
            error: `In-page fetch timed out (no progress for ${FETCH_IDLE_TIMEOUT_MS / 1000}s)`,
          });
        }, FETCH_IDLE_TIMEOUT_MS);
      };

      const onMessage = (e) => {
        if (e.source !== window) return;
        const msg = e.data;
        if (!msg || msg.id !== id) return;

        if (msg.__idx === "fetch-progress") {
          armIdleTimer();
          updatePill(uploadId, { phase: "downloading", loaded: msg.loaded, total: msg.total });
          return;
        }
        if (msg.__idx === "fetch-response") {
          if (msg.ok) {
            settle({
              ok: true,
              bytes: msg.bytes,
              contentType: msg.contentType,
              fetchedUrl: msg.fetchedUrl,
            });
          } else {
            settle({ ok: false, error: msg.error || "Unknown page-helper error" });
          }
        }
      };

      window.addEventListener("message", onMessage);
      armIdleTimer();
      const coords = lastCoords ? { x: lastCoords.x, y: lastCoords.y } : null;
      window.postMessage({ __idx: "fetch-request", id, url: srcUrl, coords }, "*");
    });
  }

  // -------------------------------------------------------------------------
  // Media scanner — finds every plausible media element/URL on the page.
  // Returns an array of { url, kind, label, thumb } objects.  Deduplicates
  // by URL.  Skips off-screen or display:none elements so the picker doesn't
  // surface stale media from carousels and lazy-load skeletons.
  // -------------------------------------------------------------------------

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    return true;
  }

  function absUrl(raw) {
    if (!raw) return null;
    if (raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
    try { return new URL(raw, location.href).href; } catch { return null; }
  }

  function scanForMedia() {
    const found = new Map();
    const add = (rawUrl, kind, label, thumb) => {
      const url = absUrl(rawUrl);
      if (!url) return;
      if (found.has(url)) return;
      found.set(url, { url, kind, label: label || url, thumb: thumb || null });
    };

    // <img>
    for (const img of document.querySelectorAll("img")) {
      if (!isVisible(img)) continue;
      const src = img.currentSrc || img.src;
      if (!src) continue;
      add(src, "image", img.alt || src, src);
    }

    // <video> and <video><source>
    for (const video of document.querySelectorAll("video")) {
      if (!isVisible(video)) continue;
      let src = video.currentSrc || video.src;
      if (!src) {
        const inner = video.querySelector("source[src]");
        if (inner) src = inner.src;
      }
      if (src) add(src, "video", video.title || "video", video.poster || null);
    }

    // <audio> and <audio><source>
    for (const audio of document.querySelectorAll("audio")) {
      if (!isVisible(audio)) continue;
      let src = audio.currentSrc || audio.src;
      if (!src) {
        const inner = audio.querySelector("source[src]");
        if (inner) src = inner.src;
      }
      if (src) add(src, "audio", audio.title || "audio", null);
    }

    // <a href> pointing at a direct media file (CDN download links).
    const mediaExtRe = /\.(?:jpe?g|png|gif|webp|heic|heif|avif|svg|bmp|mp4|m4v|webm|mov|mkv|avi|flv|3gp|mp3|m4a|ogg|oga|wav|flac|aac|opus)(?:[?#]|$)/i;
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!href || !mediaExtRe.test(href)) continue;
      const kind = /\.(?:mp4|m4v|webm|mov|mkv|avi|flv|3gp)(?:[?#]|$)/i.test(href) ? "video"
                 : /\.(?:mp3|m4a|ogg|oga|wav|flac|aac|opus)(?:[?#]|$)/i.test(href) ? "audio"
                 : "image";
      add(href, kind, (a.textContent || "").trim() || href, null);
    }

    // CSS background-image for visible elements that look like media tiles.
    // Scanning every element is expensive; restrict to elements that have
    // sensible dimensions and likely tile classes/inline styles.
    for (const el of document.querySelectorAll("[style*='background-image'], figure, .image, .photo, .media, [class*='thumb']")) {
      if (!isVisible(el)) continue;
      try {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (!bg || bg === "none") continue;
        const m = bg.match(/url\((['"]?)(.*?)\1\)/);
        if (!m) continue;
        const raw = m[2];
        if (!raw) continue;
        add(raw, "image", "background image", raw);
      } catch {}
    }

    // Sort: visible viewport items first (rough heuristic by tag presence),
    // then by kind so videos/audio float above the long tail of images.
    return Array.from(found.values()).sort((a, b) => {
      const order = { video: 0, audio: 1, image: 2 };
      return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
    });
  }

  // -------------------------------------------------------------------------
  // Picker — full-screen list of every media item on the page.
  // -------------------------------------------------------------------------

  function showPicker() {
    removePicker();

    const items = scanForMedia();

    const overlay = document.createElement("div");
    overlay.id = "idx-picker-overlay";

    const sheet = document.createElement("div");
    sheet.id = "idx-picker-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Pick media to upload");

    const header = document.createElement("div");
    header.id = "idx-picker-header";
    header.innerHTML = `
      <span id="idx-picker-title">Pick media to upload</span>
      <button id="idx-picker-close" type="button" aria-label="Close">×</button>
    `;
    sheet.appendChild(header);

    const sub = document.createElement("div");
    sub.id = "idx-picker-sub";
    sub.textContent = items.length
      ? `${items.length} item${items.length === 1 ? "" : "s"} found on this page`
      : "No media found on this page.";
    sheet.appendChild(sub);

    const list = document.createElement("div");
    list.id = "idx-picker-list";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.id = "idx-picker-empty";
      empty.textContent = "Try scrolling the page first so images and videos load, then tap the toolbar button again.";
      list.appendChild(empty);
    } else {
      for (const item of items) {
        list.appendChild(buildPickerRow(item));
      }
    }

    sheet.appendChild(list);

    // Manual URL fallback.  If the user knows the media URL but the scanner
    // can't find it (e.g. inside a closed shadow root or behind a click
    // handler that swaps the src), they can paste it directly.
    const manual = document.createElement("div");
    manual.id = "idx-picker-manual";
    manual.innerHTML = `
      <label for="idx-picker-manual-input">Or paste a media URL</label>
      <div id="idx-picker-manual-row">
        <input id="idx-picker-manual-input" type="url" placeholder="https://example.com/file.jpg" spellcheck="false" autocomplete="off" />
        <button id="idx-picker-manual-go" type="button">Use</button>
      </div>
    `;
    sheet.appendChild(manual);

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) removePicker();
    });
    document.getElementById("idx-picker-close").addEventListener("click", removePicker);

    const manualGo = () => {
      const v = document.getElementById("idx-picker-manual-input").value.trim();
      if (!v) return;
      pickMedia(v);
    };
    document.getElementById("idx-picker-manual-go").addEventListener("click", manualGo);
    document.getElementById("idx-picker-manual-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") manualGo();
    });
  }

  function buildPickerRow(item) {
    const row = document.createElement("button");
    row.className = "idx-picker-row";
    row.type = "button";
    row.dataset.kind = item.kind;

    const thumb = document.createElement("div");
    thumb.className = "idx-picker-thumb";
    if (item.kind === "image" && item.thumb) {
      const img = document.createElement("img");
      img.src = item.thumb;
      img.loading = "lazy";
      img.alt = "";
      thumb.appendChild(img);
    } else if (item.kind === "video" && item.thumb) {
      const img = document.createElement("img");
      img.src = item.thumb;
      img.loading = "lazy";
      img.alt = "";
      thumb.appendChild(img);
      const badge = document.createElement("span");
      badge.className = "idx-picker-badge";
      badge.textContent = "▶";
      thumb.appendChild(badge);
    } else {
      const ph = document.createElement("span");
      ph.className = "idx-picker-thumb-ph";
      ph.textContent = item.kind === "video" ? "▶" : item.kind === "audio" ? "♪" : "🖼";
      thumb.appendChild(ph);
    }

    const meta = document.createElement("div");
    meta.className = "idx-picker-meta";
    const label = document.createElement("div");
    label.className = "idx-picker-label";
    let labelText = item.label;
    try {
      const u = new URL(item.url);
      labelText = decodeURIComponent(u.pathname.split("/").pop() || u.hostname);
    } catch {}
    label.textContent = labelText || item.url;
    const url = document.createElement("div");
    url.className = "idx-picker-url";
    url.textContent = item.url;
    meta.appendChild(label);
    meta.appendChild(url);

    row.appendChild(thumb);
    row.appendChild(meta);
    row.addEventListener("click", () => pickMedia(item.url));
    return row;
  }

  function pickMedia(srcUrl) {
    removePicker();
    // Hand the chosen URL to the background, which runs the same login-gate
    // and then sends us an "showModal" message with the same URL.
    browser.runtime.sendMessage({ action: "pickerSelected", srcUrl });
  }

  function removePicker() {
    const el = document.getElementById("idx-picker-overlay");
    if (el) el.remove();
  }

  // -------------------------------------------------------------------------
  // Modal (URL + tags input) — same as desktop, restyled for touch.
  // -------------------------------------------------------------------------

  function showModal(srcUrl, pageUrl) {
    removeModal();

    const overlay = document.createElement("div");
    overlay.id = "idx-overlay";

    overlay.innerHTML = `
      <div id="idx-modal" role="dialog" aria-modal="true" aria-label="Download to Index">
        <p id="idx-title">Download to Index</p>
        <input
          id="idx-url"
          type="url"
          value="${escHtml(srcUrl)}"
          spellcheck="false"
          autocomplete="off"
          title="Edit if the wrong element was detected"
        />
        <label id="idx-label" for="idx-tags-input">
          Tags <span id="idx-hint">(comma-separated, optional)</span>
        </label>
        <input
          id="idx-tags-input"
          type="text"
          placeholder="nature, funny, animals"
          autocomplete="off"
          spellcheck="false"
        />
        <div id="idx-status" aria-live="polite"></div>
        <div id="idx-buttons">
          <button id="idx-cancel-btn" type="button">Cancel</button>
          <button id="idx-upload-btn" type="button">Upload</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById("idx-tags-input").focus();

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) removeModal();
    });

    document.getElementById("idx-cancel-btn").addEventListener("click", removeModal);

    const submitUpload = () => {
      const url  = document.getElementById("idx-url").value.trim();
      const tags = document.getElementById("idx-tags-input").value.trim();
      const status = document.getElementById("idx-status");
      try { new URL(url); } catch {
        status.textContent = "Not a valid URL.";
        status.className = "idx-err";
        return;
      }
      const uploadId = newUploadId();
      createPill(uploadId, url);
      browser.runtime.sendMessage({ action: "upload", srcUrl: url, tags, uploadId, pageUrl: pageUrl || location.href });
      removeModal();
    };

    document.getElementById("idx-upload-btn").addEventListener("click", submitUpload);

    const onKey = (e) => {
      if (e.key === "Enter") submitUpload();
      if (e.key === "Escape") removeModal();
    };
    document.getElementById("idx-url").addEventListener("keydown", onKey);
    document.getElementById("idx-tags-input").addEventListener("keydown", onKey);
  }

  function removeModal() {
    const el = document.getElementById("idx-overlay");
    if (el) el.remove();
  }

  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // -------------------------------------------------------------------------
  // Status pill — persistent floating indicator per in-flight upload
  // -------------------------------------------------------------------------

  const pills = new Map();
  const dismissed = new Set();

  const STUCK_MS = 30_000;

  function newUploadId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function ensurePillContainer() {
    let c = document.getElementById("idx-pills");
    if (!c) {
      c = document.createElement("div");
      c.id = "idx-pills";
      document.body.appendChild(c);
    }
    return c;
  }

  function createPill(uploadId, srcUrl) {
    if (pills.has(uploadId) || dismissed.has(uploadId)) return pills.get(uploadId);
    const container = ensurePillContainer();

    const root = document.createElement("div");
    root.className = "idx-pill idx-pill-indet";
    root.dataset.id = uploadId;
    root.dataset.phase = "preparing";
    root.innerHTML = `
      <div class="idx-pill-row">
        <span class="idx-pill-icon">⚙</span>
        <span class="idx-pill-phase">Preparing…</span>
        <span class="idx-pill-time">0:00</span>
        <button class="idx-pill-close" type="button" aria-label="Dismiss">×</button>
      </div>
      <div class="idx-pill-name"></div>
      <div class="idx-pill-bar"><div class="idx-pill-fill"></div></div>
      <div class="idx-pill-meta">Authenticating…</div>
    `;
    container.appendChild(root);

    let initialName = "";
    try {
      initialName = decodeURIComponent(new URL(srcUrl, location.href).pathname.split("/").pop() || "");
    } catch {}
    const nameEl = root.querySelector(".idx-pill-name");
    nameEl.textContent = initialName || srcUrl;
    nameEl.title = srcUrl;

    const pill = {
      root,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      ticker: 0,
      done: false
    };

    pill.ticker = setInterval(() => {
      const elapsed = Math.floor((Date.now() - pill.startTime) / 1000);
      root.querySelector(".idx-pill-time").textContent = formatTime(elapsed);
      const phase = root.dataset.phase;
      if (!pill.done && (phase === "preparing" || phase === "uploading" || phase === "processing" || phase === "downloading")) {
        const idle = Date.now() - pill.lastUpdate;
        root.classList.toggle("idx-pill-stuck", idle > STUCK_MS);
      }
    }, 500);

    root.querySelector(".idx-pill-close").addEventListener("click", () => {
      dismissed.add(uploadId);
      destroyPill(uploadId);
    });

    pills.set(uploadId, pill);
    return pill;
  }

  function destroyPill(uploadId) {
    const pill = pills.get(uploadId);
    if (!pill) return;
    clearInterval(pill.ticker);
    pill.root.classList.add("idx-pill-fade");
    setTimeout(() => {
      pill.root.remove();
      pills.delete(uploadId);
      const container = document.getElementById("idx-pills");
      if (container && !container.children.length) container.remove();
    }, 320);
  }

  function autoDismiss(uploadId, delay) {
    setTimeout(() => destroyPill(uploadId), delay);
  }

  function updatePill(uploadId, msg) {
    if (dismissed.has(uploadId)) return;
    let pill = pills.get(uploadId);
    if (!pill) pill = createPill(uploadId, msg.srcUrl || "");
    if (!pill) return;

    pill.lastUpdate = Date.now();
    const root = pill.root;
    root.dataset.phase = msg.phase;
    root.classList.remove("idx-pill-stuck");

    const phaseEl = root.querySelector(".idx-pill-phase");
    const iconEl = root.querySelector(".idx-pill-icon");
    const fillEl = root.querySelector(".idx-pill-fill");
    const metaEl = root.querySelector(".idx-pill-meta");
    const nameEl = root.querySelector(".idx-pill-name");

    if (msg.filename) nameEl.textContent = msg.filename;

    root.classList.remove("idx-pill-success", "idx-pill-duplicate", "idx-pill-error");

    switch (msg.phase) {
      case "queued":
        iconEl.textContent = "⋯";
        phaseEl.textContent = msg.position
          ? `Queued (${msg.position} ahead)`
          : "Queued";
        root.classList.add("idx-pill-indet");
        fillEl.style.width = "100%";
        metaEl.textContent = "Waiting for an upload slot";
        break;
      case "preparing":
        iconEl.textContent = "⚙";
        phaseEl.textContent = "Preparing…";
        root.classList.add("idx-pill-indet");
        fillEl.style.width = "100%";
        metaEl.textContent = "Authenticating…";
        break;
      case "downloading":
        iconEl.textContent = "⬇";
        phaseEl.textContent = "Downloading…";
        if (msg.total && msg.total > 0) {
          const pct = Math.min(100, (msg.loaded / msg.total) * 100);
          root.classList.remove("idx-pill-indet");
          fillEl.style.width = `${pct.toFixed(1)}%`;
          metaEl.textContent = `${formatBytes(msg.loaded)} / ${formatBytes(msg.total)} · ${pct.toFixed(0)}%`;
        } else {
          root.classList.add("idx-pill-indet");
          fillEl.style.width = "100%";
          metaEl.textContent = formatBytes(msg.loaded || 0);
        }
        break;
      case "uploading":
        iconEl.textContent = "⬆";
        phaseEl.textContent = "Uploading…";
        if (msg.total && msg.total > 0 && msg.loaded != null) {
          const pct = Math.min(100, (msg.loaded / msg.total) * 100);
          root.classList.remove("idx-pill-indet");
          fillEl.style.width = `${pct.toFixed(1)}%`;
          metaEl.textContent = `${formatBytes(msg.loaded)} / ${formatBytes(msg.total)} · ${pct.toFixed(0)}%`;
        } else {
          root.classList.add("idx-pill-indet");
          fillEl.style.width = "100%";
          metaEl.textContent = msg.size ? `Sending ${formatBytes(msg.size)}…` : "Sending…";
        }
        break;
      case "processing":
        iconEl.textContent = "⏳";
        phaseEl.textContent = "Processing…";
        root.classList.add("idx-pill-indet");
        fillEl.style.width = "100%";
        metaEl.textContent = "Server is saving the file";
        break;
      case "success":
        iconEl.textContent = "✓";
        phaseEl.textContent = "Saved";
        root.classList.remove("idx-pill-indet");
        root.classList.add("idx-pill-success");
        fillEl.style.width = "100%";
        metaEl.textContent = "Added to your Index";
        pill.done = true;
        autoDismiss(uploadId, 3000);
        break;
      case "duplicate":
        iconEl.textContent = "ⓘ";
        phaseEl.textContent = "Already in Index";
        root.classList.remove("idx-pill-indet");
        root.classList.add("idx-pill-duplicate");
        fillEl.style.width = "100%";
        metaEl.textContent = "Duplicate — already saved";
        pill.done = true;
        autoDismiss(uploadId, 5000);
        break;
      case "error":
        iconEl.textContent = "✗";
        phaseEl.textContent = "Failed";
        root.classList.remove("idx-pill-indet");
        root.classList.add("idx-pill-error");
        fillEl.style.width = "0%";
        metaEl.textContent = msg.error || "Unknown error";
        pill.done = true;
        break;
    }
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  function formatBytes(n) {
    if (!n && n !== 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
}
