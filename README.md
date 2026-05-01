# Download to Index

Firefox extension that adds a **Download to Index** entry to the right-click menu for images, videos, and audio. One click sends the media — plus optional tags — to a self-hosted media index server you control.

The extension is host-agnostic: configure your server URL once in Settings, and right-click upload works on every site you visit.

> **OFFICIAL RELEASE VERSION:** [https://addons.mozilla.org/en-US/firefox/addon/download-to-index/](https://addons.mozilla.org/en-US/firefox/addon/download-to-index/) — DOWNLOAD HERE.

> **Companion server:** [github.com/Houdini99/media_index](https://github.com/Houdini99/media_index) — the open-source backend this extension is built for, by the same developer.

> [!NOTE]
> AI helps me build this stuff. I check over everything and try to fix bugs as fast as possible. Not a master, just building and learning!

---

## Features

- Right-click any `<img>`, `<video>`, `<audio>`, or direct media link → **Download to Index**
- Confirm the URL and add comma-separated tags in a small modal
- Floating progress pill per upload (download → upload → server processing)
- Up to 2 uploads run in parallel; the rest queue automatically
- Smart fallbacks: looks past transparent overlays, walks media containers, follows `<source>` elements, reads CSS background-images
- Special handling for **Telegram Web** and **WhatsApp Web** (bypasses the `nojs.mp4` placeholder by fetching from the page's own service-worker context)
- Optional `yt-dlp` native helper resolves streaming URLs (HLS/DASH and supported video sites) into direct downloadable media

## Requirements

- Firefox **128** or later
- A running instance of the [companion server](https://github.com/Houdini99/media_index)
- *(Optional)* `yt-dlp` and the bundled native messaging helper for streaming-site support

## Install

### From MOZILLA ADDON STORE

1. [https://addons.mozilla.org/en-US/firefox/addon/download-to-index/](https://addons.mozilla.org/en-US/firefox/addon/download-to-index/) — DOWNLOAD HERE.

### From source (temporary, for development)

1. Clone this repo:
   ```sh
   git clone https://github.com/Houdini99/<this-repo>.git
   cd <this-repo>
   ```
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select `manifest.json`.

The extension stays loaded until Firefox restarts.

### Packaged `.xpi`

```sh
zip -r download-to-index.xpi manifest.json background.js content.js content.css \
    page_helper.js options.html options.js options.css icons
```

Then drag the resulting `.xpi` onto Firefox, or install it via the AMO listing once published.

## Configure

1. Click the toolbar icon (or open `about:addons` → **Download to Index** → **Preferences**) to open Settings.
2. Enter your server URL (e.g. `https://media.example.com`) and click **Save**.
3. Firefox prompts for access to that host — accept.
4. Open your server in a tab and log in.
5. Right-click any media on any page and choose **Download to Index**.

The extension only requests host access for the server you configure. Switching servers automatically revokes the previous host's permission.

## Native messaging helper (optional)

The bundled [native-host/dl_helper.py](native-host/dl_helper.py) is a thin `yt-dlp` wrapper that resolves streaming page URLs into direct media URLs. Without it, only directly downloadable media works.

All three platforms need **Python 3** and **yt-dlp** on `PATH`, plus the host manifest registered where Firefox looks for it. The host name is `download_to_index.dl_helper` — to use a different name, edit [native-host/download_to_index.dl_helper.json](native-host/download_to_index.dl_helper.json) and the matching field in the extension's Settings page.

### Linux

```sh
# 1. Install yt-dlp
pip install --user yt-dlp     # or: pacman -S yt-dlp / apt install yt-dlp

# 2. Register the host (writes manifest to ~/.mozilla/native-messaging-hosts/)
cd native-host
./install.sh
```

### macOS

```sh
# 1. Install yt-dlp
brew install yt-dlp

# 2. Register the host (override the manifest path for Firefox on macOS)
cd native-host
MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ./install.sh
```

### Windows

Firefox on Windows reads the manifest path from the registry instead of a folder. Run in **PowerShell** from the repo root:

```powershell
# 1. Install yt-dlp (pick one)
pip install --user yt-dlp
winget install yt-dlp.yt-dlp

# 2. Point the manifest at the absolute path of dl_helper.py
$host_path = (Resolve-Path .\native-host\dl_helper.py).Path
$manifest  = (Resolve-Path .\native-host\download_to_index.dl_helper.json).Path
(Get-Content $manifest) -replace 'REPLACED_AT_INSTALL_TIME', ($host_path -replace '\\','\\') |
    Set-Content $manifest

# 3. Register the manifest with Firefox
New-Item -Path 'HKCU:\Software\Mozilla\NativeMessagingHosts\download_to_index.dl_helper' -Force |
    Set-ItemProperty -Name '(Default)' -Value $manifest
```

Because `dl_helper.py` is invoked directly, ensure `.py` files are associated with the Python launcher (the standard Python installer does this), or wrap the call in a `dl_helper.bat` that runs `python dl_helper.py %*` and point the manifest's `path` at the `.bat` instead.

## Project layout

```
.
├── manifest.json           Manifest V3 entrypoint
├── background.js           Context menu, upload queue, settings, webRequest header rewrite
├── content.js              Right-click probe, modal, progress pill
├── content.css             Modal & pill styles
├── page_helper.js          Page-world fetch helper (Telegram/WhatsApp service workers)
├── options.html / .js / .css   Settings page
├── icons/
└── native-host/            Optional yt-dlp native messaging helper (separate install)
    ├── dl_helper.py
    ├── download_to_index.dl_helper.json
    └── install.sh
```

## Permissions

| Permission | Used for |
|---|---|
| `contextMenus` | The "Download to Index" right-click entry |
| `notifications` | Success / failure toasts |
| `storage` | Saving your server URL and helper name (`browser.storage.local`) |
| `cookies` | Reading the session cookie for **your own configured server** so cross-origin uploads stay logged in |
| `webRequest` + `webRequestBlocking` | Setting `Referer` / `Origin` on POSTs to **your own server** to satisfy Flask-WTF's strict CSRF check (these headers are forbidden for `fetch()` and can only be set via `webRequest`) |
| `nativeMessaging` | Optional yt-dlp helper for streaming-site URL resolution |
| `optional_host_permissions: <all_urls>` | **Not granted at install.** The extension calls `permissions.request()` only when you save a server URL, scoped to that single host |
| `content_scripts` matching `<all_urls>` | Required so the right-click menu can detect media on any page; the script only acts on right-click |

## Privacy

- No analytics, no telemetry, no third-party requests
- Uploads go only to the server URL you configure
- Cookies are read only for that server
- Settings stay in `browser.storage.local`

## License

MIT — see [LICENSE](LICENSE).
