#!/usr/bin/env python3
"""Poll the Worker until YouTube processing allows the cover to be applied."""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def main():
    short, ref = sys.argv[1:3]
    query = urllib.parse.urlencode({"key": os.environ["WORKER_KEY"], "short": short, "ref": ref})
    url = os.environ["WORKER"].rstrip("/") + "/thumbnail-one?" + query
    for attempt in range(20):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                result = json.load(response)
            if result.get("status") == "done":
                print("✅ YouTube thumbnail applied.")
                return
            if result.get("status") == "failed":
                print("::warning::Thumbnail needs attention: " + result.get("message", "See Worker status."))
                return
            print(f"Thumbnail pending — YouTube processing check {attempt + 1}/20.")
        except urllib.error.HTTPError as error:
            if error.code in (400, 401, 404):
                print(f"::warning::Thumbnail endpoint returned HTTP {error.code}. Check that the updated Worker is deployed.")
                return
            print(f"Thumbnail check will retry (HTTP {error.code}).")
        except (urllib.error.URLError, TimeoutError, ValueError):
            # Never print urllib exceptions: their URL can include the Worker key.
            print("Thumbnail service temporarily unavailable; retrying.")
        if attempt < 19:
            time.sleep(15)
    print("::warning::Thumbnail still pending. The hourly safety check will retry it. The video remains scheduled.")


if __name__ == "__main__":
    main()
