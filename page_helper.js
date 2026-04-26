"use strict";

// Runs in the PAGE's main world (not the content-script isolated world) so
// that fetch() goes through the page's service worker — which is the only
// way to get the real bytes for SW-served URLs like Telegram Web's
// /a/progressive/document* (the SW serves a `nojs.mp4` placeholder to
// requests that didn't originate from the page's own context).
//
// Protocol:
//   content script  → page world : {__idx: "fetch-request", id, url}
//   page world      → content    : {__idx: "fetch-progress", id, loaded, total}
//   page world      → content    : {__idx: "fetch-response", id, ok, bytes, contentType}
//                                  or {ok: false, error}

(() => {
  if (window.__idxPageHelperLoaded) return;
  window.__idxPageHelperLoaded = true;
  console.log("[idx] page_helper loaded");

  // Telegram Web's "no JavaScript" fallback file.  When a video is played via
  // MediaSource (instead of progressive download), the <video> element's src
  // is literally `nojs.mp4` and the real bytes only exist in MSE buffers /
  // IndexedDB.  Fetching this URL just gives us the placeholder, which is
  // useless to upload.
  const TELEGRAM_PLACEHOLDER_RE = /\/(?:nojs|noscript)\.mp4(?:[?#]|$)/;
  const DOC_ID_RE = /\b(\d{15,20})\b/;

  // React stores its component-tree metadata as a `__reactFiber$<random>`
  // expando on every rendered DOM node.  We can walk that fiber chain upward
  // from a DOM element to read the actual component props — which for
  // Telegram-A's <video> element will include the real document object that
  // we'd otherwise have no way to identify.
  function getReactFiber(el) {
    if (!el) return null;
    for (const k in el) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
        return el[k];
      }
    }
    return null;
  }

  // Walk the fiber chain looking for props that name a media document.
  // Returns the first 15-20 digit ID found, or null.  Logs every visited
  // fiber's prop keys to the console so we can refine the prop list if the
  // first attempt picks the wrong one.
  function findDocIdViaFiber(rootEl, label) {
    let fiber = getReactFiber(rootEl);
    let depth = 0;
    const dumps = [];
    while (fiber && depth < 30) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      const typeName =
        (fiber.type && (fiber.type.displayName || fiber.type.name)) ||
        (typeof fiber.type === "string" ? fiber.type : "?");
      if (props) {
        dumps.push({ depth, type: typeName, keys: Object.keys(props) });
        // Try several likely shapes used by Telegram-A and similar SPAs.
        const tries = [
          ["document", props.document],
          ["video", props.video],
          ["media", props.media],
          ["doc", props.doc],
          ["file", props.file],
          ["attachment", props.attachment],
          ["documentId", props.documentId && { id: props.documentId }],
          ["mediaId", props.mediaId && { id: props.mediaId }],
          ["fileId", props.fileId && { id: props.fileId }],
        ];
        for (const [key, candidate] of tries) {
          if (candidate && candidate.id != null) {
            const idStr = String(candidate.id);
            if (/^\d{15,20}$/.test(idStr)) {
              console.log("[idx] fiber doc ID found via prop", key, "on", typeName, "at depth", depth, "→", idStr);
              return idStr;
            }
          }
        }
      }
      fiber = fiber.return;
      depth++;
    }
    console.log("[idx] fiber walk for", label, "found no doc ID. Components visited:", dumps);
    return null;
  }

  // Scan only the direct ancestor chain (NOT siblings/subtrees) of `el` for
  // a doc ID attribute.  This is the safe attribute-based fallback when
  // fiber inspection fails — picking the closest ancestor avoids grabbing
  // unrelated stickers/icons that share the message wrapper.
  function findDocIdInAncestors(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      for (const a of cur.attributes || []) {
        const m = a.value.match(DOC_ID_RE);
        if (m) return m[1];
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // Pull the doc ID out of any progressive URL on a <video> element.
  // Telegram-A swaps the <video src> to nojs.mp4 momentarily during the
  // right-click event (an anti-download trick), but by the time the user
  // clicks Upload in our modal it's been swapped back to the real URL.
  function extractDocIdFromVideo(video) {
    if (!video || video.tagName !== "VIDEO") return null;
    const candidates = [video.currentSrc, video.src];
    if (video.querySelectorAll) {
      for (const s of video.querySelectorAll("source[src]")) candidates.push(s.src);
    }
    for (const c of candidates) {
      if (!c) continue;
      const m = c.match(/\/progressive\/document(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  // Resolve the real URL for the media at (x, y).  Telegram-A serves images
  // as blob: URLs (already in page memory) and videos via progressive document
  // URLs encoded into <video src>.  When the user right-clicks, Telegram
  // briefly swaps these to nojs.mp4 to defeat "Save As", but by the time we
  // run the post-click query the real values are back.  Returns a URL string
  // the page-world fetch can resolve, or null if we can't find anything.
  function findRealUrlAtPoint(x, y) {
    const stack = document.elementsFromPoint(x, y) || [];
    console.log("[idx] elementsFromPoint:", stack.slice(0, 5).map(el => el.tagName + (el.id ? "#" + el.id : "")));

    // 1. Media-viewer fast path: if the full-screen video viewer is open, the
    // right-click was almost certainly on it.
    const mvVideo = document.getElementById("media-viewer-video");
    if (mvVideo && mvVideo.offsetParent !== null) {
      const id = extractDocIdFromVideo(mvVideo);
      if (id) {
        const url = telegramProgressiveUrl(id);
        console.log("[idx] using #media-viewer-video URL:", url);
        return url;
      }
    }

    if (!stack.length) {
      console.warn("[idx] elementsFromPoint returned empty for", x, y);
      return null;
    }

    // 2. Image at click — img.src is a blob: URL holding the real bytes.
    const img = stack.find(el => el.tagName === "IMG");
    if (img && img.src && !TELEGRAM_PLACEHOLDER_RE.test(img.src)) {
      console.log("[idx] using <img> src:", img.src);
      return img.src;
    }

    // 3. Video at click — extract the progressive doc ID from src.
    const clickVideo = stack.find(el => el.tagName === "VIDEO");
    if (clickVideo) {
      const id = extractDocIdFromVideo(clickVideo);
      if (id) {
        const url = telegramProgressiveUrl(id);
        console.log("[idx] using clicked <video> URL:", url);
        return url;
      }
    }

    const target = stack[0];
    console.log("[idx] target element at click:",
      target.tagName, target.className || "", target.id || "(no id)");

    // 4. Fiber walk (Teact won't have __reactFiber$ expandos, but harmless to try).
    const fromFiber = findDocIdViaFiber(target, target.tagName);
    if (fromFiber) return telegramProgressiveUrl(fromFiber);

    // 5. Last resort: ancestor attribute scan.
    const fromAttr = findDocIdInAncestors(target);
    if (fromAttr) return telegramProgressiveUrl(fromAttr);

    return null;
  }

  function telegramProgressiveUrl(docId) {
    return `https://web.telegram.org/a/progressive/document${docId}`;
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.__idx !== "fetch-request") return;
    let { id, url, coords } = msg;
    console.log("[idx] fetch-request", id, url, coords);

    const reply = (payload) => {
      console.log("[idx] fetch-response", id, payload.ok ? `ok (${payload.bytes && payload.bytes.byteLength} bytes, ${payload.contentType})` : `error: ${payload.error}`);
      window.postMessage({ __idx: "fetch-response", id, ...payload }, "*");
    };
    const progress = (loaded, total) => window.postMessage({ __idx: "fetch-progress", id, loaded, total }, "*");

    // Telegram retarget: nojs.mp4 is a placeholder src that Telegram-A swaps
    // in momentarily during the right-click event (anti-download trick).
    // Look at the elements at the original click coordinates to find the real
    // <img> blob URL or <video> progressive URL.
    if (TELEGRAM_PLACEHOLDER_RE.test(url)) {
      const realUrl = coords ? findRealUrlAtPoint(coords.x, coords.y) : null;
      if (realUrl) {
        console.log("[idx] Telegram retarget:", url, "→", realUrl);
        url = realUrl;
      } else {
        console.warn("[idx] Telegram retarget — no real URL found at click coordinates", coords);
        reply({
          ok: false,
          error: "Telegram — could not find the real media at the click. Try right-clicking directly on the image or video.",
        });
        return;
      }
    }

    // Chunked Range fetch — Telegram's service worker caps each response at
    // 512 KB regardless of the Range we request, so we have to issue
    // successive Range requests until we've covered Content-Range's total.
    // Plain HTTP servers either honour the first request's full range or
    // ignore Range and return 200 with the whole body — both are handled
    // by the early-exit conditions below.
    const CHUNK_SIZE = 512 * 1024;
    const chunks = [];
    let offset = 0;
    let total = null;
    let contentType = "";

    progress(0, null);

    try {
      while (true) {
        const rangeStart = offset;
        const rangeEnd = total != null
          ? Math.min(offset + CHUNK_SIZE - 1, total - 1)
          : offset + CHUNK_SIZE - 1;
        const requestedSize = rangeEnd - rangeStart + 1;

        const resp = await fetch(url, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
          credentials: "include",
        });
        if (!resp.ok && resp.status !== 206) {
          reply({ ok: false, error: `HTTP ${resp.status} at offset ${offset}` });
          return;
        }

        if (!contentType) {
          contentType = (resp.headers.get("content-type") || "").split(";")[0].trim();
        }

        if (total == null) {
          const cr = resp.headers.get("content-range");
          if (cr) {
            const m = cr.match(/\/(\d+)$/);
            if (m) total = parseInt(m[1], 10);
          }
          if (total == null && resp.status === 200) {
            const cl = resp.headers.get("content-length");
            if (cl) total = parseInt(cl, 10);
          }
        }

        const buf = await resp.arrayBuffer();
        if (buf.byteLength === 0) break;
        chunks.push(new Uint8Array(buf));
        offset += buf.byteLength;
        progress(offset, total);

        if (total != null && offset >= total) break;
        if (resp.status === 200) break;            // server returned the whole file in one go
        if (buf.byteLength < requestedSize) break; // file shorter than requested range
      }

      const totalBytes = chunks.reduce((s, b) => s + b.byteLength, 0);
      const out = new Uint8Array(totalBytes);
      let pos = 0;
      for (const b of chunks) { out.set(b, pos); pos += b.byteLength; }

      // Report the URL we actually fetched (may differ from the one we were
      // asked to fetch, if Telegram retargeting kicked in) so the background
      // can derive a sensible filename instead of using the placeholder name.
      reply({ ok: true, bytes: out.buffer, contentType, fetchedUrl: url });
    } catch (err) {
      reply({ ok: false, error: (err && err.message) || String(err) });
    }
  });
})();
