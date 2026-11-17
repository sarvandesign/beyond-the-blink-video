#!/usr/bin/env python3
"""
build_segments.py - finds one real video clip per story beat and cuts it to length.

Runs in GitHub Actions (see produce-short.yml).

    python3 scripts/build_segments.py SHORT VOICE_WAV OUT_DIR USED_CLIPS_FILE

For every beat of the story it:
  1. searches Pixabay (stock video) with the beat's English words,
     then with the broader backup words;
  2. downloads the best clip it has not used before;
  3. cuts it to the beat's share of the narration (1080x1920, 30 fps);
  4. if nothing suitable is found, asks the Worker for an AI image
     (the old way) and gives it a slow zoom instead.

Output: OUT_DIR/seg-01.mp4 ... seg-NN.mp4 and OUT_DIR/segments.txt
(the list FFmpeg joins). Every segment has identical settings, so they
can be joined without re-encoding.

Environment:
    WORKER, WORKER_KEY, CHAT      the Cloudflare Worker (required)
    PIXABAY_API_KEY               optional - without it every beat uses an AI image
    PIXABAY_BASE                  optional - only for tests
"""

import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

W, H, FPS = 1080, 1920, 30
MIN_BEAT_SECONDS = 2.0
TAIL_SECONDS = 0.4          # video runs slightly past the voice; -shortest trims it
MAX_DOWNLOAD_MB = 150       # skip a 4K file bigger than this and use 1080p instead
MAX_STRETCH = 1.6           # slow a short clip down by up to this much before looping it

PIXABAY_BASE = os.environ.get("PIXABAY_BASE", "https://pixabay.com/api/videos/")
USER_AGENT = "BeyondTheBlinkBot/1.0 (personal YouTube Shorts tool)"


def log(message):
    print(message, flush=True)


# ------------------------------------------------------------------ http
def http_get(url, params=None, timeout=60, retries=3):
    """GET with retries. Returns (bytes, headers). Raises on final failure."""
    if params:
        url = f"{url}{'&' if '?' in url else '?'}{urllib.parse.urlencode(params)}"

    last = None
    for attempt in range(1, retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(), response.headers
        except urllib.error.HTTPError as error:
            body = error.read()[:200].decode("utf-8", "replace")
            last = RuntimeError(f"HTTP {error.code} from {url.split('?')[0]}: {body}")
            if error.code == 429:
                time.sleep(min(30, 10 * attempt))
            elif 400 <= error.code < 500:
                raise last  # a wrong key or bad request will not fix itself
        except Exception as error:  # timeouts, connection resets
            last = error
        time.sleep(2 * attempt)

    raise last


def download(url, dest, max_mb=300):
    """Streams a file to disk. Refuses anything larger than max_mb."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp = Path(str(dest) + ".part")
    written = 0

    with urllib.request.urlopen(request, timeout=90) as response, open(tmp, "wb") as out:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            written += len(chunk)
            if written > max_mb * (1 << 20):
                raise RuntimeError(f"file bigger than {max_mb} MB")
            out.write(chunk)

    tmp.rename(dest)


def worker_url(path, **params):
    base = os.environ["WORKER"].rstrip("/")
    params.update(key=os.environ["WORKER_KEY"], chat=os.environ.get("CHAT", ""))
    return f"{base}{path}?{urllib.parse.urlencode(params)}"


# ---------------------------------------------------------------- ffmpeg
def run(cmd):
    result = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[-600:] or "ffmpeg failed")
    return result.stdout


def media_seconds(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", path])
    return float(out.strip())


ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
          "-r", FPS, "-g", FPS, "-an", "-movflags", "+faststart"]


def finish(tmp, final):
    """A stopped render must never leave a file that looks finished."""
    Path(tmp).replace(final)


def cut_clip(src, frames, out):
    """Real video clip -> exactly `frames` frames of 1080x1920."""
    clip_seconds = media_seconds(src)
    need_seconds = frames / FPS
    loop = []
    stretch = ""

    if clip_seconds < need_seconds:
        ratio = need_seconds / clip_seconds
        if ratio <= MAX_STRETCH:
            stretch = f"setpts={ratio:.4f}*PTS,"   # gentle slow motion
        else:
            loop = ["-stream_loop", "-1"]          # too short: repeat it

    flt = (f"{stretch}fps={FPS},tpad=stop_mode=clone:stop_duration=0.5,"
           f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
           f"crop={W}:{H},setsar=1,format=yuv420p")

    tmp = Path(out).with_suffix(".tmp.mp4")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *loop, "-i", src,
         "-vf", flt, "-frames:v", frames, *ENCODE, tmp])
    finish(tmp, out)


def cut_image(src, frames, out, zoom_in):
    """AI image -> exactly `frames` frames with a slow zoom (the old look)."""
    cover = "scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840"
    z = (f"1+0.12*on/{frames}" if zoom_in else f"1.12-0.12*on/{frames}")
    pan = f"x=iw/2-(iw/zoom/2):y=ih/2-(ih/zoom/2):d={frames}:s={W}x{H}:fps={FPS}"

    tmp = Path(out).with_suffix(".tmp.mp4")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", src,
         "-vf", f"{cover},zoompan=z='{z}':{pan},setsar=1,format=yuv420p",
         "-frames:v", frames, *ENCODE, tmp])
    finish(tmp, out)


# ------------------------------------------------------------- planning
def letters(text):
    return max(1, len(re.sub(r"[\s.,!?।:;\"'“”‘’—–-]", "", text)))


def plan_frames(beats, total_seconds):
    """Frames per beat, proportional to the spoken length, summing exactly."""
    weights = [letters(b["text"]) for b in beats]
    floor = round(MIN_BEAT_SECONDS * FPS)
    total_frames = round(total_seconds * FPS)

    shares = [total_frames * w / sum(weights) for w in weights]
    locked = [s < floor for s in shares]

    for _ in range(len(beats)):          # raise short beats, shrink the rest
        free = [i for i, l in enumerate(locked) if not l]
        if not free:
            break
        remaining = total_frames - floor * sum(locked)
        free_weight = sum(weights[i] for i in free)
        shares = [floor if locked[i] else remaining * weights[i] / free_weight
                  for i in range(len(beats))]
        newly = [i for i in free if shares[i] < floor]
        if not newly:
            break
        for i in newly:
            locked[i] = True

    # Cumulative rounding so the frames add up exactly to the total
    frames, done, carried = [], 0, 0.0
    for share in shares:
        carried += share
        target = round(carried)
        frames.append(max(1, target - done))
        done = target
    return frames


# ------------------------------------------------------------- pixabay
def search_pixabay(query, need_seconds, banned_ids):
    """Returns the best candidate dict for this search, or None."""
    key = os.environ.get("PIXABAY_API_KEY", "").strip()
    if not key or not query:
        return None

    data, _ = http_get(PIXABAY_BASE, {
        "key": key, "q": query[:100], "video_type": "film", "safesearch": "true",
        "per_page": 30, "min_width": 1280,
    })
    hits = json.loads(data).get("hits", [])
    best, best_score = None, -1e9

    for rank, hit in enumerate(hits):
        video_id = str(hit.get("id"))
        duration = float(hit.get("duration") or 0)
        renditions = hit.get("videos") or {}

        if video_id in banned_ids or duration < 3:
            continue

        large, medium = renditions.get("large") or {}, renditions.get("medium") or {}
        pick = None
        if large.get("url") and 0 < large.get("size", 0) <= MAX_DOWNLOAD_MB * (1 << 20):
            pick = large          # 4K: crops to vertical without losing sharpness
        elif medium.get("url"):
            pick = medium
        elif (renditions.get("small") or {}).get("url"):
            pick = renditions["small"]
        if not pick:
            continue

        portrait = pick.get("height", 0) > pick.get("width", 0)
        score = (2.0 if portrait else 0.0) + (1.0 if duration >= need_seconds else 0.0) - rank * 0.02
        if score > best_score:
            best, best_score = {
                "id": video_id, "url": pick["url"], "duration": duration,
                "page": hit.get("pageURL", ""), "query": query,
            }, score

    return best


# ------------------------------------------------------------------ main
def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)

    short, voice, out_dir, used_file = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])

    for name in ("WORKER", "WORKER_KEY"):
        if not os.environ.get(name):
            sys.exit(f"❌ {name} is not set.")
    if shutil.which("ffmpeg") is None:
        sys.exit("❌ FFmpeg is not installed.")

    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "downloads"
    work.mkdir(exist_ok=True)

    # 1. the story beats
    body, _ = http_get(worker_url("/script-beats", short=short))
    story = json.loads(body)
    beats = story["beats"]
    if not beats:
        sys.exit("❌ The Worker returned no beats.")

    total = media_seconds(voice) + TAIL_SECONDS
    frames = plan_frames(beats, total)
    log(f"Voice {total - TAIL_SECONDS:.1f}s -> {len(beats)} beats, frames per beat: {frames}")

    # 2. clips used in earlier Shorts are never used again
    used = set()
    if used_file.exists():
        for line in used_file.read_text(encoding="utf-8").splitlines():
            token = line.split(" ")[0]
            if token.startswith("pixabay:"):
                used.add(token.split(":", 1)[1])

    have_key = bool(os.environ.get("PIXABAY_API_KEY", "").strip())
    if not have_key:
        log("⚠️ PIXABAY_API_KEY is empty - every beat will use an AI image.")

    report, new_used = [], []
    last_source = None          # (kind, path) of the last good beat, as a final fallback

    for i, (beat, n_frames) in enumerate(zip(beats, frames), start=1):
        out = out_dir / f"seg-{i:02d}.mp4"
        need = n_frames / FPS
        chosen, source = None, "ai-image"

        # 3a. real stock footage
        for query in ((beat.get("stock_search", ""), beat.get("alt_search", "")) if have_key else ()):
            try:
                chosen = search_pixabay(query, need, used)
            except Exception as error:
                log(f"   beat {i}: Pixabay search '{query}' failed: {error}")
                if "HTTP 4" in str(error) and "429" not in str(error):
                    have_key = False   # bad key etc. - stop asking
                    break
                chosen = None
            if chosen:
                break

        if chosen:
            src = work / f"clip-{i:02d}.mp4"
            try:
                download(chosen["url"], src, max_mb=MAX_DOWNLOAD_MB * 2)
                cut_clip(src, n_frames, out)
                used.add(chosen["id"])
                new_used.append(f"pixabay:{chosen['id']} short-{short} {chosen['page']}")
                last_source, source = ("clip", src), "pixabay"
                log(f"   beat {i}: Pixabay {chosen['id']} ({chosen['query']!r}, {chosen['duration']:.0f}s)")
            except Exception as error:
                log(f"   beat {i}: clip failed ({error}) - using an AI image instead")
                chosen = None

        # 3b. AI image fallback
        if not chosen:
            img = work / f"image-{i:02d}.jpg"
            try:
                data, _ = http_get(worker_url("/visual-one", short=short, visual=i, raw=1),
                                   timeout=120, retries=2)
                if data[:2] != b"\xff\xd8":
                    raise RuntimeError("the Worker did not return a JPEG")
                img.write_bytes(data)
                cut_image(img, n_frames, out, zoom_in=(i % 2 == 1))
                last_source, source = ("image", img), "ai-image"
                log(f"   beat {i}: AI image (no stock clip for {beat.get('stock_search')!r})")
            except Exception as error:
                # 3c. last resort: reuse the previous beat's picture or clip
                if not last_source:
                    sys.exit(f"❌ Beat {i}: no clip, no AI image, and nothing to reuse ({error})")
                kind, path = last_source
                log(f"   beat {i}: ⚠️ AI image failed ({error}) - repeating the previous visual")
                (cut_clip(path, n_frames, out) if kind == "clip"
                 else cut_image(path, n_frames, out, zoom_in=(i % 2 == 1)))
                source = "repeat"

        report.append(source)

    # 4. the list FFmpeg joins, and the log of used clips
    (out_dir / "segments.txt").write_text(
        "".join(f"file '{(out_dir / f'seg-{i:02d}.mp4').resolve()}'\n" for i in range(1, len(beats) + 1)),
        encoding="utf-8")

    if new_used:
        used_file.parent.mkdir(parents=True, exist_ok=True)
        with open(used_file, "a", encoding="utf-8") as f:
            f.write("\n".join(new_used) + "\n")

    shutil.rmtree(work, ignore_errors=True)

    stock, ai, again = report.count("pixabay"), report.count("ai-image"), report.count("repeat")
    summary = (f"🎞 Short {short} footage: {stock} stock clip{'s' if stock != 1 else ''}, "
               f"{ai} AI image{'s' if ai != 1 else ''}" +
               (f", {again} repeated" if again else "") +
               f" (of {len(beats)} beats).")
    log(summary)

    try:  # tell Telegram; never fail the build over a message
        http_get(worker_url("/notify", short=short, text=summary), retries=1, timeout=20)
    except Exception as error:
        log(f"(could not send the Telegram note: {error})")


if __name__ == "__main__":
    main()
