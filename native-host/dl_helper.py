#!/usr/bin/env python3
"""yt-dlp native-messaging host for the Download to Index extension.

The extension sends `{srcUrl, pageUrl}`; we run `yt-dlp --get-url` against the
page URL and reply with one of:
  - {"kind": "direct", "url": "<resolved mp4/webm URL>"}
  - {"kind": "passthrough", "reason": "..."}   # extension keeps original srcUrl
  - {"kind": "error", "message": "..."}        # surfaced to the user
"""
import json
import shutil
import struct
import subprocess
import sys


def read_message():
    raw = sys.stdin.buffer.read(4)
    if not raw:
        return None
    length = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(msg):
    data = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def run_yt_dlp(target):
    """Run yt-dlp --get-url against `target`.

    Returns (kind, payload) where:
      ("direct", url)              — yt-dlp resolved a single playable URL
      ("multi",  count)            — yt-dlp returned multiple streams (no mux)
      ("none",   reason)           — yt-dlp didn't recognise this URL
      ("error",  message)          — yt-dlp couldn't be invoked at all
    """
    try:
        out = subprocess.run(
            # Format selectors, in priority order:
            #   b[acodec!=none][vcodec!=none]  — best single file with both A+V
            #   b                              — best single file (any kind)
            # We deliberately AVOID `bv*+ba` because that selector makes
            # --get-url print two URLs (video stream and audio stream); we
            # can't merge them ourselves without ffmpeg, and silently using
            # only the first line drops audio entirely.
            ["yt-dlp", "--no-warnings", "--get-url",
             "--format", "b[acodec!=none][vcodec!=none]/b",
             target],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except subprocess.TimeoutExpired:
        return ("none", "yt-dlp timed out")
    except Exception as e:
        return ("error", str(e)[:200])

    if out.returncode != 0 or not out.stdout.strip():
        return ("none", (out.stderr.strip() or "no extractor match")[:200])

    lines = out.stdout.strip().splitlines()
    if len(lines) > 1:
        return ("multi", len(lines))
    return ("direct", lines[0])


def main():
    if not shutil.which("yt-dlp"):
        send_message({"kind": "error", "message": "yt-dlp not installed"})
        return

    msg = read_message()
    if not msg:
        return

    src_url = msg.get("srcUrl") or ""
    page_url = msg.get("pageUrl") or ""

    # Try srcUrl first — for embedded media on a generic content page (e.g. a
    # CDN HLS manifest dropped onto an article), srcUrl is the actual stream
    # and pageUrl is just the surrounding context.  Falling back to pageUrl
    # covers the opposite shape (e.g. a YouTube watch page where srcUrl is
    # something blob/MSE-derived that yt-dlp can't recognise).
    targets = [t for t in (src_url, page_url) if t]
    if not targets:
        send_message({"kind": "passthrough", "reason": "no URL provided"})
        return

    last_reason = "no URL provided"
    for target in targets:
        kind, payload = run_yt_dlp(target)
        if kind == "direct":
            send_message({"kind": "direct", "url": payload})
            return
        if kind == "error":
            send_message({"kind": "error", "message": payload})
            return
        if kind == "multi":
            # Two or more URLs means yt-dlp couldn't find a single-file format
            # (e.g. YouTube's separate video+audio streams).  We can't mux them
            # in the extension, so let the upload flow fall back to its normal
            # path — which for HLS/DASH manifests will probably still fail, but
            # at least won't silently produce a video without sound.
            last_reason = f"yt-dlp returned {payload} streams; muxing not supported"
            continue
        last_reason = payload

    send_message({"kind": "passthrough", "reason": last_reason})


if __name__ == "__main__":
    main()
