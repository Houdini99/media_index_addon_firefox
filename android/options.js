"use strict";

const DEFAULTS = {
  baseUrl: "",
};

const $url = document.getElementById("base-url");
const $status = document.getElementById("status");
const $form = document.getElementById("settings-form");
const $save = document.getElementById("save-btn");
const $test = document.getElementById("test-btn");

function setStatus(text, kind) {
  $status.textContent = text || "";
  $status.className = kind || "";
}

function normalizeBaseUrl(raw) {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, error: "Server URL is required." };
  let u;
  try { u = new URL(trimmed); }
  catch { return { ok: false, error: "Not a valid URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  return { ok: true, value: u.origin };
}

function originPattern(baseUrl) {
  return `${baseUrl}/*`;
}

async function load() {
  const stored = await browser.storage.local.get(DEFAULTS);
  $url.value = stored.baseUrl || "";
}

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

  const prev = await browser.storage.local.get({ baseUrl: "" });
  if (prev.baseUrl && prev.baseUrl !== norm.value) {
    try {
      await browser.permissions.remove({ origins: [originPattern(prev.baseUrl)] });
    } catch {}
  }

  await browser.storage.local.set({
    baseUrl: norm.value,
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
