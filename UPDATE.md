# Beyond the Blink — covers and voice rotation

GitHub's production workflow now generates a 1080 × 1920 JPEG cover from the story's real footage, adds the Tamil title and channel branding, saves it beside the video, and waits for YouTube processing before setting the cover. A delayed cover does not stop video scheduling. The existing hourly queue check retries pending covers for up to 48 hours.

The updated Worker selects a random narrator from eight Gemini preset voices for each new story. It avoids the previous story's voice and saves the choice before generating audio, so production retries keep the same narrator. The voice name appears in the audio message and `/status`.

## One-time Cloudflare update

1. Open `worker.js` in this repository. Use the **Copy raw file** button to copy the entire code.
2. Open Cloudflare → **Workers & Pages** → **beyond-the-blink** → **Edit code**.
3. Select `worker.js` in the editor. Click inside the code, press **Cmd+A**, and paste the complete replacement with **Cmd+V**.
4. Click **Deploy**. Keep the existing secrets, KV namespace, and AI binding.
5. Open https://beyond-the-blink.beyondtheblink-creator.workers.dev — it should include **Covers + voice rotation — 17 Nov 2026**.
6. Open the accompanying GitHub pull request → **Merge pull request** → **Confirm merge**.
7. Approve the next fresh idea in Telegram. Check its voice name and, after processing, its cover in YouTube Studio.

No new API key is needed. After deploying the Worker, merge the accompanying GitHub pull request to enable the updated workflow. There is nothing to paste into GitHub. The original Worker is preserved in the earlier attachment; this repository also keeps version history.

## What changes when

These changes apply to newly produced Shorts after the Worker deployment. Previously scheduled videos are not regenerated or reuploaded. Covers appear after YouTube finishes processing; a thumbnail permission rejection is recorded in `/status` and the Actions log without disrupting the video's schedule.

Voice variety is per story. Connected seasons and episode memory have not been enabled; they need a chosen storyline and a separate continuity update. Existing ideas/approvals remain as they are.

## Verification and limits

- 17 Worker behavior checks passed with mock KV, Gemini, GitHub-media, and YouTube responses.
- Three Tamil cover layouts were rendered, including long titles; a preview was visually checked.
- A local mock Worker test extracted a real video frame, generated its JPEG, and exercised delayed-processing polling.
- JavaScript/Python syntax and every workflow shell step passed checks.
- Live Gemini pronunciation and live YouTube thumbnail acceptance have not been tested by this update. Review the first new Short after deployment.
