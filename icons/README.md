# Download to Index — Firefox for Android

Companion to the [desktop extension](../README.md), rebuilt for Firefox on Android. Tap the toolbar entry to pick any image, video, or audio on the current page and upload it to your self-hosted media index server.

> **Companion server:** [github.com/Houdini99/media_index](https://github.com/Houdini99/media_index)

## Why a separate folder?

Firefox for Android doesn't expose two APIs the desktop build relies on:

| Desktop feature | Android replacement |
|---|---|
| Right-click context menu (`contextMenus` API) | Toolbar action opens a **media picker** that lists every image / video / audio element found on the page |
| `nativeMessaging` (yt-dlp helper for streaming sites) | Removed — only directly downloadable media works on this build |

Everything else (upload queue, progress pills, login redirect, in-page fetch for Telegram/WhatsApp Web, CSRF/Referer rewrite, cookie injection) is identical.

## Features

- Toolbar button → full-screen picker listing every `<img>`, `<video>`, `<audio>`, direct media link, and CSS background image on the page
- Manual URL paste field as a fallback for media the scanner can't see
- Confirm-URL + tags modal before each upload
- Floating progress pill per upload (download → upload → server processing)
- Up to 2 uploads run in parallel; the rest queue automatically
- Login-not-active detection: opens your server's login page in a tab, then resumes every queued upload after you sign in
- Special handling for **Telegram Web** and **WhatsApp Web** (bypasses the `nojs.mp4` placeholder via the page's own service worker)

## Requirements

- Firefox for Android **128** or later
- A running instance of the [companion server](https://github.com/Houdini99/media_index)

## Install

Firefox for Android can side-load extensions through a custom add-on collection on AMO. The short version:

1. **Sign your build** (or zip it as `.xpi` and host it somewhere reachable).
   ```sh
   cd android
   zip -r ../download-to-index-android.xpi manifest.json background.js content.js content.css \
       page_helper.js options.html options.js options.css icons
   ```
2. Either publish to AMO and install via the listing, or use the [Firefox Android Custom Add-on Collection](https://extensionworkshop.com/documentation/develop/test-permissions-changes-in-mv3-extensions/) (Settings → About → tap the logo five times → enable Custom add-on collection) to install your own self-published collection.
3. Open the Firefox **⋮ menu** → the extension appears under **Extensions**.

For development, you can also use `web-ext run --target firefox-android` to live-reload onto a connected device over USB.

## Configure

1. Open the Firefox **⋮ menu** → **Add-ons & themes** → **Download to Index** → **Settings**.
2. Enter your server URL (e.g. `https://media.example.com`) and tap **Save**.
3. Firefox prompts for access to that host — accept.
4. Open your server in a tab and sign in.
5. Browse to any page with media, open the **⋮ menu**, tap **Download to Index**, and pick the media you want.

## How the picker works

When you tap the toolbar action, the content script scans the current page for:

- `<img>` elements with a non-empty `src` / `currentSrc`
- `<video>` and `<audio>` elements (including their `<source>` children)
- `<a href="…">` links pointing at common media file extensions
- CSS `background-image` declarations on figure/photo/thumbnail-shaped elements

Items are listed in a bottom sheet ordered videos → audio → images. Tap one to open the upload modal; the rest of the flow is identical to the desktop build.

If the scanner misses something — common on heavily-virtualised pages or media inside closed shadow roots — paste the URL directly into the manual field at the bottom of the picker.

## Project layout

```
android/
├── manifest.json      Manifest V3 entrypoint (no contextMenus / nativeMessaging)
├── background.js      Action button, upload queue, settings, header rewrite
├── content.js         Media scanner, picker, modal, progress pill
├── content.css        Picker / modal / pill styles, touch-sized
├── page_helper.js     Page-world fetch helper (Telegram / WhatsApp service workers)
├── options.html       Settings page (touch-friendly)
├── options.js
├── options.css
└── icons/
```

## Permissions

| Permission | Used for |
|---|---|
| `notifications` | Success / failure toasts |
| `storage` | Saving your server URL (`browser.storage.local`) |
| `cookies` | Reading the session cookie for **your own configured server** so cross-origin uploads stay logged in |
| `webRequest` + `webRequestBlocking` | Setting `Referer` / `Origin` on POSTs to **your own server** to satisfy Flask-WTF's strict CSRF check |
| `activeTab` + `scripting` | Injecting the content script when the toolbar action is tapped on pages where it isn't already loaded |
| `optional_host_permissions: <all_urls>` | **Not granted at install.** The extension calls `permissions.request()` only when you save a server URL, scoped to that single host |
| `content_scripts` matching `<all_urls>` | Required so the picker can scan media on any page; the script only acts when the toolbar action is tapped |

## Privacy

Same as the desktop build:

- No analytics, no telemetry, no third-party requests
- Uploads go only to the server URL you configure
- Cookies are read only for that server
- Settings stay in `browser.storage.local`

## License

MIT — see [LICENSE](../LICENSE).
