#!/usr/bin/env python3
"""Render a portrait Tamil cover from the Short's footage; no image API needed."""
import io
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps, features

WIDTH, HEIGHT = 1080, 1920


def font_file(family):
    result = subprocess.check_output(
        ["fc-match", "-f", "%{file}", family], text=True
    ).strip()
    if not result or not Path(result).is_file():
        raise RuntimeError(f"Font unavailable: {family}")
    return result


def clusters(text):
    # Keep Tamil vowel signs/virama attached when a long word must be wrapped.
    out = []
    for char in text:
        if out and (unicodedata.category(char).startswith("M") or char in "\u200c\u200d"):
            out[-1] += char
        else:
            out.append(char)
    return out


def wrap_title(text, draw, font, max_width):
    lines, line = [], ""
    for word in text.split():
        candidate = (line + " " + word).strip()
        if draw.textlength(candidate, font=font) <= max_width:
            line = candidate
            continue
        if line:
            lines.append(line)
            line = ""
        if draw.textlength(word, font=font) <= max_width:
            line = word
            continue
        for cluster in clusters(word):
            if line and draw.textlength(line + cluster, font=font) > max_width:
                lines.append(line)
                line = ""
            line += cluster
    if line:
        lines.append(line)
    return lines


def render_cover(frame, title, output):
    if not features.check("raqm"):
        raise RuntimeError("Pillow needs RAQM for correctly shaped Tamil text.")
    title = re.sub(r"\s+", " ", str(title)).strip() or "ஒரு சிறிய கதை"
    title = "".join(c for c in title if not unicodedata.category(c).startswith("C"))
    title = title[:180]
    image = ImageOps.fit(frame.convert("RGB"), (WIDTH, HEIGHT))
    shade = Image.new("RGBA", image.size)
    draw = ImageDraw.Draw(shade)
    for y in range(HEIGHT):
        bottom = int(245 * max(0, (y - 600) / (HEIGHT - 600)))
        top = int(135 * max(0, 1 - y / 450))
        draw.line((0, y, WIDTH, y), fill=(6, 17, 27, max(top, bottom)))
    image = Image.alpha_composite(image.convert("RGBA"), shade)
    draw = ImageDraw.Draw(image)
    gold = "#F4C870"
    latin_path = font_file("DejaVu Sans:style=Bold")
    tamil_path = font_file("Noto Sans Tamil:style=Bold")
    brand = ImageFont.truetype(latin_path, 39)
    draw.rounded_rectangle((65, 100, 665, 185), radius=19, fill=(7, 19, 30, 220))
    draw.text((90, 118), "BEYOND THE BLINK", font=brand, fill=gold)
    # Use measured shaped text, rather than character counts, for Tamil wrapping.
    for size in range(112, 31, -2):
        font = ImageFont.truetype(tamil_path, size, layout_engine=ImageFont.Layout.RAQM)
        lines = wrap_title(title, draw, font, 900)
        asc, desc = font.getmetrics()
        step = asc + desc + 18
        if len(lines) * step <= 580:
            break
    else:
        raise RuntimeError("Title is too long for the thumbnail.")
    y = 1470 - len(lines) * step
    draw.rounded_rectangle((82, y - 45, 220, y - 33), radius=6, fill=gold)
    for line in lines:
        draw.text((80, y), line, font=font, fill="white", stroke_width=1,
                  stroke_fill=(255, 255, 255), anchor="lt")
        y += step
    label = ImageFont.truetype(tamil_path, 35, layout_engine=ImageFont.Layout.RAQM)
    draw.text((82, 1565), "தமிழில் ஒரு சிறுகதை", font=label, fill=gold)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output, "JPEG", quality=90, optimize=True)
    if output.stat().st_size >= 2_000_000:
        image.convert("RGB").save(output, "JPEG", quality=75, optimize=True)
    if output.stat().st_size >= 2_000_000:
        raise RuntimeError("Thumbnail exceeds 2 MB.")
    print(f"Cover ready: {output.name} — {WIDTH}x{HEIGHT}")


def main():
    short, video, output = sys.argv[1:4]
    query = urllib.parse.urlencode({"key": os.environ["WORKER_KEY"], "short": short})
    request = urllib.request.Request(os.environ["WORKER"].rstrip("/") + "/script-beats?" + query)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            title = json.load(response).get("title", "")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Could not get cover title (HTTP {error.code}).") from None
    except urllib.error.URLError:
        raise RuntimeError("Could not reach the Worker for the cover title.") from None
    # joined.mp4 contains the real footage before captions are burned in.
    frame = subprocess.check_output([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", video,
        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-threads", "1", "-"
    ])
    render_cover(Image.open(io.BytesIO(frame)), title, output)


if __name__ == "__main__":
    main()
