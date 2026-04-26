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


def main():
    if not shutil.which("yt-dlp"):
        send_message({"kind": "error", "message": "yt-dlp not installed"})
        return

    msg = read_message()
    if not msg:
        return

    target = msg.get("pageUrl") or msg.get("srcUrl")
    if not target:
        send_message({"kind": "passthrough", "reason": "no URL provided"})
        return

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
        send_message({"kind": "passthrough", "reason": "yt-dlp timed out"})
        return
    except Exception as e:
        send_message({"kind": "error", "message": str(e)[:200]})
        return

    if out.returncode != 0 or not out.stdout.strip():
        send_message({
            "kind": "passthrough",
            "reason": (out.stderr.strip() or "no extractor match")[:200],
        })
        return

    lines = out.stdout.strip().splitlines()
    if len(lines) > 1:
        # Two or more URLs means yt-dlp couldn't find a single-file format
        # (e.g. YouTube's separate video+audio streams).  We can't mux them
        # in the extension, so let the upload flow fall back to its normal
        # path — which for HLS/DASH manifests will probably still fail, but
        # at least won't silently produce a video without sound.
        send_message({
            "kind": "passthrough",
            "reason": f"yt-dlp returned {len(lines)} streams; muxing not supported",
        })
        return

    send_message({"kind": "direct", "url": lines[0]})


if __name__ == "__main__":
    main()
