"use strict";

// Guard against being injected more than once into the same document
if (!window.__indexAddonLoaded) {
  window.__indexAddonLoaded = true;

  // -------------------------------------------------------------------------
  // Right-click coordinate tracking
  //
  // Firefox lets us resolve the *exact* right-clicked element via
  // browser.menus.getTargetElement(targetElementId), but that returns only
  // that one node.  When the site places a transparent overlay on top of a
  // <video>, the target IS the overlay — so we also cache the viewport
  // coordinates to later walk the full z-stack with elementsFromPoint().
  //
  // Capture phase so we still see the event even if the page calls
  // stopPropagation() (common on streaming sites that suppress the native
  // context menu, then re-enable it by dispatching their own).
  // -------------------------------------------------------------------------

  let lastCoords = null;

  const captureCoords = (e) => {
    lastCoords = { x: e.clientX, y: e.clientY };
  };
  window.addEventListener("contextmenu", captureCoords, true);
  // Fallback: some pages call preventDefault() on contextmenu, which can
  // suppress it entirely.  mousedown with button=2 still fires.
  window.addEventListener("mousedown", (e) => {
    if (e.button === 2) captureCoords(e);
  }, true);

  // -------------------------------------------------------------------------
  // Message listener (receives commands from background.js)
  // -------------------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "showModal") {
      showModal(msg.srcUrl);
      return;
    }
    if (msg.action === "uploadStatus") {
      updatePill(msg.uploadId, msg);
      return;
    }
    if (msg.action === "probe") {
      // Return a promise so the background script can `await` the result.
      return Promise.resolve({ srcUrl: probeForMedia(msg.targetElementId) });
    }
    if (msg.action === "fetchInPage") {
      // Telegram Web (and similar SPAs) serve media via a service worker that
      // only intercepts requests originating from the page's context.  A
      // background-script fetch bypasses the SW and gets a placeholder; we
      // have to fetch from here, then ship the bytes back.
      return fetchInPage(msg.srcUrl, msg.uploadId);
    }
  });

  // -------------------------------------------------------------------------
  // In-page fetch — Telegram Web (and similar SPAs) only return real bytes
  // for fetches that originate from the PAGE'S MAIN WORLD, because their
  // service worker checks the request's client to distinguish the video
  // element's request from "naked" fetches (which get the nojs.mp4 fallback).
  //
  // Content-script fetch() runs in an isolated world that doesn't satisfy
  // the SW's checks.  So we inject `page_helper.js` into the page itself
  // (via web_accessible_resources) and bridge results back through
  // window.postMessage.
  // -------------------------------------------------------------------------

  // The helper is async: we must wait for the <script> tag's `load` event
  // before posting the first request, otherwise the message fires before the
  // helper's window-message listener is registered and is silently dropped.
  let pageHelperReady = null;

  function injectPageHelper() {
    if (pageHelperReady) return pageHelperReady;
    pageHelperReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = browser.runtime.getURL("page_helper.js");
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(
        "page_helper.js failed to load — likely blocked by the page's CSP. " +
        "Check the page console for a Content Security Policy error."
      ));
      (document.documentElement || document.head || document.body).appendChild(script);
    });
    return pageHelperReady;
  }

  async function fetchInPage(srcUrl, uploadId) {
    try {
      await injectPageHelper();
    } catch (e) {
      return { ok: false, error: e.message };
    }

    return new Promise((resolve) => {
      const id = "idx-" + Math.random().toString(36).slice(2);

      const onMessage = (e) => {
        if (e.source !== window) return;
        const msg = e.data;
        if (!msg || msg.id !== id) return;

        if (msg.__idx === "fetch-progress") {
          updatePill(uploadId, { phase: "downloading", loaded: msg.loaded, total: msg.total });
          return;
        }
        if (msg.__idx === "fetch-response") {
          window.removeEventListener("message", onMessage);
          if (msg.ok) {
            resolve({
              ok: true,
              bytes: msg.bytes,
              contentType: msg.contentType,
              fetchedUrl: msg.fetchedUrl,
            });
          } else {
            resolve({ ok: false, error: msg.error || "Unknown page-helper error" });
          }
        }
      };

      window.addEventListener("message", onMessage);
      // Pass the captured right-click coordinates so the helper can find the
      // exact element the user targeted (needed to disambiguate the doc ID
      // when Telegram serves nojs.mp4 for MSE videos and several real doc IDs
      // are visible on the page at once).
      const coords = lastCoords ? { x: lastCoords.x, y: lastCoords.y } : null;
      window.postMessage({ __idx: "fetch-request", id, url: srcUrl, coords }, "*");
    });
  }

  // -------------------------------------------------------------------------
  // Probe: find the real media URL near the user's right-click
  // -------------------------------------------------------------------------

  function probeForMedia(targetElementId) {
    // 1. Try the exact element the right-click landed on.
    const clicked = resolveTargetElement(targetElementId);
    if (clicked) {
      const fromClicked = findMediaIn(clicked);
      if (fromClicked) return fromClicked;
    }

    // 2. Overlay bypass: walk the full paint stack at the click coordinates.
    //    elementsFromPoint returns every element under the point in z-order,
    //    so transparent overlays are skipped past to reach the real media
    //    painted beneath them.
    if (lastCoords) {
      const stack = document.elementsFromPoint(lastCoords.x, lastCoords.y) || [];
      for (const el of stack) {
        const found = findMediaIn(el);
        if (found) return found;
      }
      // 3. CSS background-image fallback (some sites paint media via CSS).
      for (const el of stack) {
        const bg = extractBackgroundUrl(el);
        if (bg) return bg;
      }
    }

    return null;
  }

  function resolveTargetElement(targetElementId) {
    if (targetElementId == null) return null;
    // Firefox-only API, available to content scripts with the "menus"/
    // "contextMenus" permission.  Unlike coordinate-based lookup, this
    // returns the underlying element even if the page re-parented it
    // between the right-click and the menu click.
    try {
      if (browser.menus && browser.menus.getTargetElement) {
        return browser.menus.getTargetElement(targetElementId) || null;
      }
    } catch {}
    return null;
  }

  // Look for a playable media URL starting from `el`.  Checks the element
  // itself, its descendants (e.g. <video><source></video>), and a bounded
  // walk up its ancestors (for overlays parked inside the media container).
  function findMediaIn(el) {
    if (!el || el.nodeType !== 1) return null;

    const direct = extractMediaUrl(el);
    if (direct) return direct;

    const descendant = el.querySelector && el.querySelector("video, audio, img, source");
    if (descendant) {
      const fromDesc = extractMediaUrl(descendant);
      if (fromDesc) return fromDesc;
    }

    let cur = el.parentElement;
    let hops = 0;
    while (cur && hops < 6) {
      const fromAnc = extractMediaUrl(cur);
      if (fromAnc) return fromAnc;
      // Check siblings in the ancestor — covers overlay+video as siblings
      // inside a common container.
      const sib = cur.querySelector && cur.querySelector("video, audio, img, source");
      if (sib) {
        const fromSib = extractMediaUrl(sib);
        if (fromSib) return fromSib;
      }
      cur = cur.parentElement;
      hops++;
    }
    return null;
  }

  function extractMediaUrl(el) {
    const tag = el.tagName;
    if (!tag) return null;

    if (tag === "VIDEO" || tag === "AUDIO") {
      // currentSrc reflects the <source> the browser actually picked,
      // which is what we want for multi-source media elements.
      if (el.currentSrc) return el.currentSrc;
      if (el.src) return el.src;
      const inner = el.querySelector("source[src]");
      if (inner && inner.src) return inner.src;
      return null;
    }
    if (tag === "IMG") {
      return el.currentSrc || el.src || null;
    }
    if (tag === "SOURCE") {
      return el.src || null;
    }
    return null;
  }

  function extractBackgroundUrl(el) {
    try {
      const bg = window.getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none") return null;
      // Grab the first url(...) — ignore gradients etc.
      const m = bg.match(/url\((['"]?)(.*?)\1\)/);
      if (!m) return null;
      const raw = m[2];
      if (!raw || raw.startsWith("data:")) return null;
      try {
        return new URL(raw, location.href).href;
      } catch {
        return raw;
      }
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Modal
  // -------------------------------------------------------------------------

  function showModal(srcUrl) {
    // Remove any stale overlay from a previous invocation
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

    // Close on backdrop click
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
      // Spawn the pill synchronously so the user sees feedback before the
      // first status message round-trips through the background script.
      createPill(uploadId, url);
      browser.runtime.sendMessage({ action: "upload", srcUrl: url, tags, uploadId });
      removeModal();
    };

    document.getElementById("idx-upload-btn").addEventListener("click", submitUpload);

    // Keyboard shortcuts — Enter from either input submits, Escape closes.
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

  // uploadId -> pill record. The user can dismiss a pill before the upload
  // finishes; we remember dismissals so late status messages don't resurrect
  // a closed pill.
  const pills = new Map();
  const dismissed = new Set();

  // The "stuck" hint trips when a phase that should be making progress hasn't
  // sent a status message in this many ms — useful to distinguish a hung
  // upload from a slow one.
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
      // Only flag as "stuck" while we're still expecting progress messages.
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
    // Wait for the fade-out transition before removing.
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

    // Reset state classes that previous phases may have set.
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
        // Stay until manually dismissed so the user can read the reason.
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
