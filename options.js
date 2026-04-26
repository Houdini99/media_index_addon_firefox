"use strict";

const DEFAULTS = {
  baseUrl: "",
  nativeHost: "download_to_index.dl_helper",
};

const $url = document.getElementById("base-url");
const $nh = document.getElementById("native-host");
const $status = document.getElementById("status");
const $form = document.getElementById("settings-form");
const $save = document.getElementById("save-btn");
const $test = document.getElementById("test-btn");

function setStatus(text, kind) {
  $status.textContent = text || "";
  $status.className = kind || "";
}

// Strip trailing slashes; reject anything that isn't http(s).
function normalizeBaseUrl(raw) {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, error: "Server URL is required." };
  let u;
  try { u = new URL(trimmed); }
  catch { return { ok: false, error: "Not a valid URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  // Drop any path/query/hash — only the origin is meaningful.
  return { ok: true, value: u.origin };
}

function originPattern(baseUrl) {
  return `${baseUrl}/*`;
}

async function load() {
  const stored = await browser.storage.local.get(DEFAULTS);
  $url.value = stored.baseUrl || "";
  $nh.value = stored.nativeHost ?? DEFAULTS.nativeHost;
}

// Request host permission for the configured server.  permissions.request()
// MUST be called from inside a user-gesture handler (button click), so this
// helper is invoked directly from save/test handlers — never from a deferred
// continuation.
async function requestHostPermission(baseUrl) {
  try {
    return await browser.permissions.request({ origins: [originPattern(baseUrl)] });
  } catch (err) {
    setStatus(`Could not request permission: ${err.message}`, "err");
    return false;
  }
}

async function save(e) {
  e.preventDefault();
  const norm = normalizeBaseUrl($url.value);
  if (!norm.ok) {
    setStatus(norm.error, "err");
    $url.focus();
    return;
  }

  const granted = await requestHostPermission(norm.value);
  if (!granted) {
    setStatus("Permission denied. The extension needs access to your server to upload.", "err");
    return;
  }

  // Revoke the previous host's permission if we're switching servers, so the
  // extension doesn't accumulate access to URLs the user no longer uses.
  const prev = await browser.storage.local.get({ baseUrl: "" });
  if (prev.baseUrl && prev.baseUrl !== norm.value) {
    try {
      await browser.permissions.remove({ origins: [originPattern(prev.baseUrl)] });
    } catch {}
  }

  const nh = $nh.value.trim();
  await browser.storage.local.set({
    baseUrl: norm.value,
    nativeHost: nh || DEFAULTS.nativeHost,
  });
  $url.value = norm.value;
  setStatus("Saved.", "ok");
}

async function test() {
  const norm = normalizeBaseUrl($url.value);
  if (!norm.ok) {
    setStatus(norm.error, "err");
    return;
  }

  const granted = await requestHostPermission(norm.value);
  if (!granted) {
    setStatus("Permission denied — can't reach the server without host access.", "err");
    return;
  }

  $test.disabled = true;
  setStatus("Testing…", "info");
  try {
    const resp = await fetch(`${norm.value}/login`, {
      method: "GET",
      credentials: "include",
    });
    if (resp.ok || resp.status === 302 || resp.status === 401) {
      setStatus(`Reachable (HTTP ${resp.status}).`, "ok");
    } else {
      setStatus(`Server responded HTTP ${resp.status}.`, "err");
    }
  } catch (err) {
    setStatus(`Connection failed: ${err.message}`, "err");
  } finally {
    $test.disabled = false;
  }
}

$form.addEventListener("submit", save);
$test.addEventListener("click", test);

load();
