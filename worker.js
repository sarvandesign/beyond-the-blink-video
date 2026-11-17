// ============================================================
// BEYOND THE BLINK — Cloudflare Worker
//
// The only manual step: tap ✅ Approve on an idea in Telegram.
//
// Approve → GitHub workflow "produce-short.yml" makes ONE Short:
//   /script-one → Tamil short story in 6 beats (narration + English
//                 stock-footage search words + a fallback image prompt)
//   /voice-one  → Tamil voice    → voice-N.wav
//   /script-beats → the beats as JSON (GitHub uses it to find footage)
//   /visual-one → AI image fallback (only for beats with no stock clip;
//                 GitHub asks for the bytes with raw=1)
//   (GitHub finds real stock clips, then FFmpeg builds the video)
//   /upload     → YouTube upload + schedule (one per day, 7 pm IST)
//                 → then starts the next approved idea
//   /notify     → failure message from the workflow (pauses the queue)
//   /tick       → hourly safety check from "queue-check.yml"
//
// When every idea in the list is approved/rejected and made,
// 7 new ideas are sent automatically.
//
// Optional commands: /status, /make (retry), /ideas
// ============================================================

const WORKER_URL =
  "https://beyond-the-blink.beyondtheblink-creator.workers.dev";

const GITHUB_REPO =
  "sarvandesign/beyond-the-blink-video";

const WEEK_TTL_SECONDS = 2592000;         // 30 days
const SHORT_STATE_TTL_SECONDS = 2592000;  // 30 days
const PUBLISH_HOUR_IST = 19;              // 7:00 pm
const PRODUCTION_LOCK_MINUTES = 45;

const TTS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent";

const SCRIPT_MODEL_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

const processedUpdates = new Set();

// A story is told in this many beats; each beat gets one video clip.
const BEAT_COUNT = 6;

// Choose once per story, then keep the choice through TTS/build retries.
const STORY_VOICES = ["Kore", "Puck", "Charon", "Aoede", "Leda", "Orus", "Sulafat", "Achird"];

// Topics for the Tamil short stories. Every list of ideas uses
// different categories so the channel never feels repetitive.
const STORY_CATEGORIES = [
  { emoji: "🎬", name: "Cinema",
    hint: "the culture around movies: first-day-first-show, tent talkies, poster painters, a theatre projectionist, a fan, a small-time actor or assistant director (fictional people only)" },
  { emoji: "🍛", name: "Food",
    hint: "a dish, a street stall, a grandmother's kitchen, a hotel's old recipe, festival food, a tea shop" },
  { emoji: "🏺", name: "Culture",
    hint: "a Tamil tradition, craft, art form, folk music, kolam, silk weaving, temple town life, old customs and what they mean" },
  { emoji: "🌱", name: "Growth",
    hint: "a person improving through effort: failing and trying again, a first job, learning a skill, a small habit that changes a life" },
  { emoji: "🎉", name: "Festivals",
    hint: "Pongal, Deepavali, a village festival, a neighbourhood celebration and the people behind it" },
  { emoji: "🏡", name: "Family",
    hint: "grandparents, parents, siblings, a family secret, a letter, a promise, a reunion" },
  { emoji: "🌾", name: "Village life",
    hint: "farming, a well, monsoon, a bus that comes twice a day, a village school, delta fields" },
  { emoji: "🏙️", name: "City life",
    hint: "Chennai, Madurai, Coimbatore: trains, buses, small shops, night workers, a stranger's kindness" },
  { emoji: "🎒", name: "Childhood",
    hint: "school days, summer holidays, games like goli and pallanguzhi, a teacher, a first friend" },
  { emoji: "🎶", name: "Music",
    hint: "a street singer, a radio, a nadaswaram player, a lullaby, a song that connects two people" },
  { emoji: "🤝", name: "Friendship",
    hint: "a friend who stays, a rivalry that turns into respect, helping someone unexpectedly" },
  { emoji: "💪", name: "Struggle",
    hint: "a worker, an auto driver, a vendor, a student from a small town, and a small moment of hope" },
  { emoji: "🧭", name: "Travel",
    hint: "a journey by bus or train, a hill station, a temple trip, a place that surprised someone" },
  { emoji: "😄", name: "Humour",
    hint: "a gentle, clean funny situation from everyday Tamil life with a warm ending" },
];


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Beyond the Blink bot is running! Covers + voice rotation — 17 Nov 2026.");
    }

    // Called by the GitHub workflows
    if (request.method === "GET" && url.pathname === "/script-one") {
      return handleScriptOne(env, url);
    }

    if (request.method === "GET" && url.pathname === "/tick") {
      return handleTick(env, url);
    }

    if (request.method === "GET" && url.pathname === "/script-text") {
      return handleScriptText(env, url);
    }

    if (request.method === "GET" && url.pathname === "/script-beats") {
      return handleScriptBeats(env, url);
    }

    if (request.method === "GET" && url.pathname === "/voice-one") {
      return handleVoiceOne(env, url);
    }

    if (request.method === "GET" && url.pathname === "/visual-one") {
      return handleVisualOne(env, url);
    }

    if (request.method === "GET" && url.pathname === "/upload") {
      return handleUpload(env, url);
    }

    if (request.method === "GET" && url.pathname === "/thumbnail-one") {
      return handleThumbnailOne(env, url);
    }

    if (request.method === "GET" && url.pathname === "/notify") {
      return handleNotify(env, url);
    }

    // YouTube OAuth — start authorization
    if (request.method === "GET" && url.pathname === "/youtube") {
      if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
        return new Response("YouTube OAuth credentials are missing.", {
          status: 500,
        });
      }

      const state = crypto.randomUUID();

      await env.BEYOND_THE_BLINK_DATA.put(
        "youtube_oauth_state",
        state,
        { expirationTtl: 600 }
      );

      const redirectUri = `${url.origin}/youtube/callback`;

      const googleUrl = new URL(
        "https://accounts.google.com/o/oauth2/v2/auth"
      );

      googleUrl.searchParams.set("client_id", env.YOUTUBE_CLIENT_ID);
      googleUrl.searchParams.set("redirect_uri", redirectUri);
      googleUrl.searchParams.set("response_type", "code");
      googleUrl.searchParams.set(
        "scope",
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl"
      );
      googleUrl.searchParams.set("access_type", "offline");
      googleUrl.searchParams.set("prompt", "consent");
      googleUrl.searchParams.set("state", state);

      return Response.redirect(googleUrl.toString(), 302);
    }

    // YouTube OAuth — Google callback
    if (request.method === "GET" && url.pathname === "/youtube/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const savedState = await env.BEYOND_THE_BLINK_DATA.get(
        "youtube_oauth_state"
      );

      if (!state || state !== savedState) {
        return new Response(
          "Invalid OAuth state. Please start again.",
          { status: 400 }
        );
      }

      if (!code) {
        const error =
          url.searchParams.get("error") ||
          "Google authorization was cancelled.";

        return new Response(
          `YouTube authorization failed: ${error}`,
          { status: 400 }
        );
      }

      const redirectUri = `${url.origin}/youtube/callback`;

      const tokenResponse = await fetch(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            code,
            client_id: env.YOUTUBE_CLIENT_ID,
            client_secret: env.YOUTUBE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        }
      );

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok) {
        console.error("YouTube token exchange failed:", tokenData);

        return new Response(
          "YouTube authorization failed while exchanging the code.",
          { status: 500 }
        );
      }

      if (!tokenData.refresh_token) {
        return new Response(
          "Authorization succeeded, but Google did not return a refresh token. Please try again.",
          { status: 500 }
        );
      }

      await env.BEYOND_THE_BLINK_DATA.put(
        "youtube_refresh_token",
        tokenData.refresh_token
      );

      await env.BEYOND_THE_BLINK_DATA.delete("youtube_oauth_state");

      return new Response(
        "✅ YouTube connected successfully! You can close this page.",
        {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }

    // One-time Telegram webhook setup
    if (request.method === "GET" && url.pathname === "/setup") {
      const key = url.searchParams.get("key");

      if (!key || key !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const webhookUrl = `${url.origin}/telegram`;

      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          }),
        }
      );

      const result = await response.json();

      if (!result.ok) {
        return new Response(
          `Webhook setup failed: ${JSON.stringify(result)}`,
          { status: 500 }
        );
      }

      return new Response("Telegram webhook connected successfully!");
    }

    // Telegram webhook
    if (request.method === "POST" && url.pathname === "/telegram") {
      const telegramSecret = request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

      if (telegramSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const update = await request.json();

        if (update.update_id && processedUpdates.has(update.update_id)) {
          return new Response("OK");
        }

        if (update.update_id) {
          processedUpdates.add(update.update_id);

          if (processedUpdates.size > 1000) {
            const first = processedUpdates.values().next().value;
            processedUpdates.delete(first);
          }
        }

        // Normal Telegram messages
        if (update.message) {
          const chatId = update.message.chat.id;
          const text = update.message.text || "";

          const command = (text.trim().split(/\s+/)[0] || "")
            .replace(/@\w+$/, "")
            .toLowerCase();

          if (command === "/start" || command === "/help") {
            ctx.waitUntil(
              sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP_TEXT)
            );
          } else if (command === "/ideas" || command === "/newideas") {
            ctx.waitUntil(
              requestNewIdeas(env, chatId, command === "/newideas")
            );
          } else if (command === "/scripts") {
            ctx.waitUntil(
              sendTelegramMessage(
                env.TELEGRAM_BOT_TOKEN,
                chatId,
                "✍️ Scripts are now written automatically when you tap ✅ Approve.\n\n" +
                "Send /status to see where each Short is."
              )
            );
          } else if (command === "/make" || command === "/voice") {
            ctx.waitUntil(startNextShort(env, chatId, "manual"));
          } else if (command === "/status") {
            ctx.waitUntil(sendStatus(env, chatId));
          } else if (command.startsWith("/")) {
            ctx.waitUntil(
              sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP_TEXT)
            );
          }
        }

        // Telegram inline-button clicks
        if (update.callback_query) {
          ctx.waitUntil(handleCallbackQuery(update.callback_query, env));
        }

        return new Response("OK");
      } catch (error) {
        console.error("Telegram webhook error:", error);
        return new Response("OK");
      }
    }

    return new Response("Not found", { status: 404 });
  },
};


const HELP_TEXT = `🎬 Beyond the Blink

All you do: tap ✅ Approve on an idea.

Everything else is automatic:
Tamil story → Tamil voice → real video clips → video → YouTube,
scheduled for the next free day at 7:00 pm IST.

Approve several ideas and they're made one after another.
When the list is used up, 7 new ideas arrive automatically.

Optional:
/status — where each Short is
/make — retry a Short that stopped
/ideas — get new ideas now`;


// ============================================================
// SMALL HELPERS
// ============================================================

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function routeKeyOk(url, env) {
  const key = url.searchParams.get("key");
  return Boolean(key) && key === env.TELEGRAM_WEBHOOK_SECRET;
}

function parseShortNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 7
    ? number
    : null;
}

function formatIST(isoString) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoString));
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function bytesToBase64(bytes) {
  const parts = [];

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(
      String.fromCharCode(
        ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length))
      )
    );
  }

  return btoa(parts.join(""));
}

function googleErrorMessage(text) {
  try {
    const data = JSON.parse(text);
    return (
      data?.error?.message ||
      data?.error_description ||
      (typeof data?.error === "string" ? data.error : "") ||
      text.slice(0, 300)
    );
  } catch {
    return String(text || "").slice(0, 300);
  }
}


// ============================================================
// KV — CURRENT WEEK + PER-SHORT STATE
//
// current_week is only written from Telegram actions.
// Each Short's production progress lives in its own key,
// so the GitHub workflow never overwrites your approvals.
// ============================================================

async function getCurrentWeek(kv) {
  const raw = await kv.get("current_week");

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function shortStateKey(week, shortNumber) {
  return `short:${week?.createdAt || "legacy"}:${shortNumber}`;
}

async function getShortState(kv, week, shortNumber) {
  const raw = await kv.get(shortStateKey(week, shortNumber));

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

async function updateShortState(kv, week, shortNumber, change) {
  const state = await getShortState(kv, week, shortNumber);

  change(state);
  state.updatedAt = nowIso();

  await kv.put(
    shortStateKey(week, shortNumber),
    JSON.stringify(state),
    { expirationTtl: SHORT_STATE_TTL_SECONDS }
  );

  return state;
}

// Script for Short N: saved with the Short (new), or in the
// week (written by the older /scripts command).
function getScript(week, state, shortNumber) {
  if (state?.script?.script) {
    return state.script;
  }

  const legacy = week?.scripts?.[shortNumber - 1];

  if (typeof legacy === "string" && legacy) {
    return { script: legacy };
  }

  return legacy?.script ? legacy : null;
}

// done | running | failed | waiting
function shortPhase(state) {
  if (state?.upload?.videoId) {
    return "done";
  }

  const startedAt = Date.parse(state?.production?.startedAt || "");

  if (Number.isNaN(startedAt)) {
    return "waiting";
  }

  const failedAt = Date.parse(state?.failedAt || "");

  if (failedAt >= startedAt) {
    return "failed";
  }

  if (Date.now() - startedAt < PRODUCTION_LOCK_MINUTES * 60000) {
    return "running";
  }

  return "waiting"; // started long ago with no result — safe to retry
}

// Approved ideas in the order they were tapped.
function approvedOrder(week) {
  const rejected = Array.isArray(week?.rejected) ? week.rejected : [];
  const approved = Array.isArray(week?.approved) ? week.approved : [];

  return approved.filter(
    (index, position) =>
      Number.isInteger(index) &&
      week.ideas?.[index] &&
      !rejected.includes(index) &&
      approved.indexOf(index) === position
  );
}

async function getQueueInfo(kv, week) {
  const info = {
    running: null,
    runningSince: null,
    pending: [],
    failed: [],
    states: {},
  };

  for (const index of approvedOrder(week)) {
    const shortNumber = index + 1;
    const state = await getShortState(kv, week, shortNumber);
    const phase = shortPhase(state);

    info.states[shortNumber] = state;

    if (phase === "done") {
      continue;
    }

    info.pending.push(shortNumber);

    if (phase === "failed") {
      info.failed.push(shortNumber);
    }

    if (phase === "running" && !info.running) {
      info.running = shortNumber;
      info.runningSince = state.production.startedAt;
    }
  }

  return info;
}

// Short id for one list of ideas, used in its buttons so a tap on
// an old list can never approve an idea from a newer list.
function weekTag(week) {
  const time = Date.parse(week?.createdAt || "");
  return Number.isNaN(time) ? "" : time.toString(36);
}


// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegramMessage(botToken, chatId, text, extra = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...extra,
      }),
    }
  );

  return response.json();
}

async function answerCallbackQuery(botToken, callbackQueryId, text = "") {
  await fetch(
    `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    }
  );
}

async function editTelegramMessage(botToken, chatId, messageId, text, extra = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/editMessageText`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        ...extra,
      }),
    }
  );

  return response.json();
}

async function sendTelegramPhoto(botToken, chatId, imageBytes, fileName, caption = "") {
  const formData = new FormData();

  formData.append(
    "photo",
    new Blob([imageBytes], { type: "image/jpeg" }),
    fileName
  );

  formData.append("chat_id", String(chatId));

  if (caption) {
    formData.append("caption", caption);
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendPhoto`,
    {
      method: "POST",
      body: formData,
    }
  );

  return response.json();
}

async function sendTelegramAudio(botToken, chatId, audioBytes, fileName, caption = "") {
  const formData = new FormData();

  formData.append(
    "audio",
    new Blob([audioBytes], { type: "audio/wav" }),
    fileName
  );

  formData.append("chat_id", String(chatId));

  if (caption) {
    formData.append("caption", caption);
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendAudio`,
    {
      method: "POST",
      body: formData,
    }
  );

  return response.json();
}

async function sendTelegramVideoByUrl(botToken, chatId, videoUrl, caption = "") {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendVideo`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        video: videoUrl,
        caption,
        supports_streaming: true,
      }),
    }
  );

  return response.json();
}


// ============================================================
// GITHUB
// ============================================================

function githubHeaders(githubToken) {
  return {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Beyond-the-Blink-Bot",
  };
}

// Create or replace one file in the repo. Returns the commit SHA.
async function putGitHubFile(githubToken, path, base64Content, message) {
  const apiUrl =
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let existingSha;

    const existing = await fetch(apiUrl, {
      headers: githubHeaders(githubToken),
    });

    if (existing.ok) {
      existingSha = (await existing.json()).sha;
    } else if (existing.status !== 404) {
      throw new Error(
        `GitHub file check failed for ${path} (${existing.status}): ` +
        (await existing.text()).slice(0, 300)
      );
    }

    const body = {
      message,
      content: base64Content,
      branch: "main",
    };

    if (existingSha) {
      body.sha = existingSha;
    }

    const upload = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        ...githubHeaders(githubToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (upload.ok) {
      const result = await upload.json();
      return result?.commit?.sha || "";
    }

    lastError = new Error(
      `GitHub upload failed for ${path} (${upload.status}): ` +
      (await upload.text()).slice(0, 300)
    );

    // 409/422 = the file changed between check and upload; try once more
    if (upload.status !== 409 && upload.status !== 422) {
      throw lastError;
    }

    await sleep(1500);
  }

  throw lastError;
}

async function dispatchGitHubEvent(githubToken, eventType, payload) {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(githubToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: eventType,
        client_payload: payload,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub could not start the workflow (${response.status}): ` +
      (await response.text()).slice(0, 300)
    );
  }
}


// ============================================================
// /ideas
// ============================================================

function ideaKeyboard(count, tag) {
  const keyboard = [];
  const suffix = tag ? `_${tag}` : "";

  for (let i = 0; i < count; i++) {
    keyboard.push([
      {
        text: `✅ Approve ${i + 1}`,
        callback_data: `approve_${i}${suffix}`,
      },
      {
        text: `❌ Reject ${i + 1}`,
        callback_data: `reject_${i}${suffix}`,
      },
    ]);
  }

  return keyboard;
}

// /ideas (asks first if approved ideas are still waiting)
// /newideas (replaces the list anyway)
async function requestNewIdeas(env, chatId, force) {
  const kv = env.BEYOND_THE_BLINK_DATA;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    const week = await getCurrentWeek(kv);

    if (week) {
      const queue = await getQueueInfo(kv, week);

      if (queue.running) {
        await sendTelegramMessage(
          token,
          chatId,
          `⏳ Short ${queue.running} is being made right now.\n\n` +
          "Send /ideas again after its video arrives."
        );
        return;
      }

      if (queue.pending.length > 0 && !force) {
        await sendTelegramMessage(
          token,
          chatId,
          `⚠️ Approved but not made yet: Short ${queue.pending.join(", ")}.\n\n` +
          "They'll be made automatically. To replace the list anyway " +
          "(dropping them), send /newideas."
        );
        return;
      }
    }

    await generateAndSendIdeas(token, env.GEMINI_API_KEY, kv, chatId);
  } catch (error) {
    console.error("New ideas error:", error);

    await sendTelegramMessage(
      token,
      chatId,
      `❌ I couldn't create new ideas.\n\n${error.message}`
    );
  }
}

// When every idea in the list has been approved or rejected and
// nothing is waiting, send a fresh list automatically.
async function maybeStartNewWeek(env, chatId, week, queue) {
  const approved = Array.isArray(week?.approved) ? week.approved : [];
  const rejected = Array.isArray(week?.rejected) ? week.rejected : [];

  const allReviewed =
    Array.isArray(week?.ideas) &&
    week.ideas.length > 0 &&
    week.ideas.every((_, index) => approved.includes(index) || rejected.includes(index));

  if (!allReviewed || queue.pending.length > 0) {
    return false;
  }

  await generateAndSendIdeas(
    env.TELEGRAM_BOT_TOKEN,
    env.GEMINI_API_KEY,
    env.BEYOND_THE_BLINK_DATA,
    chatId
  );

  return true;
}

async function generateAndSendIdeas(botToken, geminiApiKey, kv, chatId) {
  await sendTelegramMessage(
    botToken,
    chatId,
    "💡 Creating 7 fresh Beyond the Blink ideas..."
  );

  try {
    // Remember the outgoing list (and which of its ideas were made)
    // so the new list never repeats them.
    let history = await getTopicHistory(kv);
    const oldWeek = await getCurrentWeek(kv);

    if (Array.isArray(oldWeek?.ideas) && oldWeek.ideas.length) {
      const entries = [];

      for (let i = 0; i < oldWeek.ideas.length; i++) {
        const state = await getShortState(kv, oldWeek, i + 1);
        const script = getScript(oldWeek, state, i + 1);

        entries.push({
          idea: oldWeek.ideas[i],
          title: script?.title,
          status: state.upload?.videoId ? "made" : "suggested",
        });
      }

      history = mergeTopics(history, entries);
    }

    const ideas = await generateIdeas(geminiApiKey, history);

    history = mergeTopics(
      history,
      ideas.map((idea) => ({ idea, status: "suggested" }))
    );

    await saveTopicHistory(kv, history);

    const week = {
      ideas,
      approved: [],
      rejected: [],
      scripts: [],
      buttonsTagged: true,
      createdAt: nowIso(),
    };

    await kv.put("current_week", JSON.stringify(week), {
      expirationTtl: WEEK_TTL_SECONDS,
    });

    let message = "🎬 NEW BEYOND THE BLINK IDEAS\n\n";

    ideas.forEach((idea, index) => {
      message += `${index + 1}. ${idea}\n\n`;
    });

    message += IDEAS_FOOTER;

    await sendTelegramMessage(botToken, chatId, message, {
      reply_markup: {
        inline_keyboard: ideaKeyboard(ideas.length, weekTag(week)),
      },
    });
  } catch (error) {
    console.error("Idea generation error:", error);

    await sendTelegramMessage(
      botToken,
      chatId,
      `❌ I couldn't generate the ideas.\n\n${error.message}`
    );
  }
}

function pickCategories(count, usedNames = []) {
  // Random, no repeats inside one list. If we run out, start again.
  const pool = STORY_CATEGORIES.filter((c) => !usedNames.includes(c.name));
  const source = pool.length >= count ? pool : STORY_CATEGORIES;
  const shuffled = [...source];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, count);
}

function ideasPrompt(categories, avoidList) {
  const count = categories.length;

  const list = categories
    .map((c, i) => `${i + 1}. ${c.name} — ${c.hint}`)
    .join("\n");

  return `
You are the story editor for a Tamil YouTube Shorts channel called
"Beyond the Blink". The channel tells short, emotional, true-to-life
stories from Tamil life, narrated in Tamil over real video footage.

Write exactly ${count} ORIGINAL story ideas, ONE for each category below,
in the same order:

${list}

Rules for every idea:
- One sentence in plain English (max 30 words) that names a specific
  person, place or moment, so a story can be written from it.
- Ideas must be fiction or common everyday experiences. Never use real
  named people, real celebrities, real politicians, real film plots,
  film dialogue or brand names.
- Set it in Tamil Nadu or in Tamil life anywhere in the world.
- It must be filmable with generic stock footage (kitchens, streets,
  fields, buses, temples, hands, rain, crowds), no special effects.
- Warm, human, believable. A small turn or surprise at the end.
- Avoid politics, religion disputes, caste, violence and anything
  that could hurt a community.
- The ${count} ideas must be clearly different from each other.
${avoidList ? `
ALREADY USED OR SUGGESTED BEFORE — do NOT repeat any of these,
including close variations of the same core idea:
${avoidList}
` : ""}
Return ONLY a valid JSON array of ${count} strings (the ideas only,
no category names), like:

["idea 1", "idea 2", "idea 3"]
`;
}

// Asks Gemini for 10 ideas (one per random category), drops any that
// repeat an earlier topic, and asks once more if fewer than 7 are left.
async function generateIdeas(apiKey, history = []) {
  const pastIdeas = history.map((entry) => entry.idea);
  const accepted = [];
  const repeats = [];
  const usedCategories = [];

  for (let round = 0; round < 2 && accepted.length < 7; round++) {
    const made = history.filter((h) => h.status === "made").map((h) => h.idea).reverse();
    const suggested = history.filter((h) => h.status !== "made").map((h) => h.idea).reverse();

    const avoid = [...new Set([...made, ...suggested, ...accepted, ...repeats])]
      .slice(0, 150)
      .map((topic) => `- ${String(topic).slice(0, 140)}`)
      .join("\n");

    const count = round === 0 ? 10 : Math.max(5, 7 - accepted.length + 3);
    const categories = pickCategories(count, usedCategories);
    const result = await callGemini(apiKey, ideasPrompt(categories, avoid));

    const candidates = parseJsonArray(result)
      .map((item) => String(item).trim())
      .filter(Boolean);

    for (let i = 0; i < candidates.length; i++) {
      if (accepted.length >= 7) {
        break;
      }

      const category = categories[i] || categories[categories.length - 1];
      const idea = `${category.emoji} ${category.name}: ${candidates[i]}`;

      if (isRepeatTopic(idea, [...pastIdeas, ...accepted])) {
        repeats.push(idea);
        continue;
      }

      accepted.push(idea);
      usedCategories.push(category.name);
    }
  }

  if (repeats.length) {
    console.log(`Dropped ${repeats.length} repeated idea(s):`, repeats);
  }

  if (accepted.length === 0) {
    throw new Error(
      "Gemini only suggested topics that were already used. Send /ideas to try again."
    );
  }

  return accepted.slice(0, 7);
}


// ============================================================
// TOPIC HISTORY — every idea ever suggested or made, so new
// lists never repeat an old topic.
// ============================================================

const TOPIC_HISTORY_KEY = "topic_history";
const TOPIC_HISTORY_MAX = 400;
const TOPIC_SIMILARITY_LIMIT = 0.6;

const TOPIC_STOPWORDS = new Set(
  (
    "a an the of to in on at by for from with into onto and or but if " +
    "what would happen happens happened could can will is are was were be " +
    "been being it its this that these those every all any some no not " +
    "when where who how why do does did suddenly instantly world everyone " +
    "everything people humans human earth planet day one become became " +
    "becomes start started starts stop stopped stops your you our their " +
    "they them just only than then there here like overnight daily forever " +
    "whole entire began begin begins again ever each never always"
  ).split(" ")
);

// Spellings and common "what if" verbs folded into one word
const TOPIC_SYNONYMS = {
  colour: "color", grey: "gray", centre: "center", metre: "meter",
  disappear: "vanish", gone: "vanish", lost: "vanish", erase: "vanish",
  backward: "reverse", backwards: "reverse",
  speak: "talk", spoke: "talk", spoken: "talk",
  frozen: "freeze", froze: "freeze", halt: "freeze",
  shown: "show", reveal: "show", display: "show",
  huge: "giant", enormous: "giant", gigantic: "giant",
  tiny: "shrink", smaller: "shrink",
  immortal: "forever", die: "death", dying: "death", dead: "death",
};

function foldTopicWord(word) {
  if (TOPIC_SYNONYMS[word]) {
    return TOPIC_SYNONYMS[word];
  }

  // mirrors → mirror, vanished → vanish (but red, speed, seed stay)
  const trimmed = word.replace(/(ing|ed|es|s)$/, "");
  const stem = trimmed.length >= 4 ? trimmed : word;
  return TOPIC_SYNONYMS[stem] || stem;
}

function normalizeTopic(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function topicWords(text) {
  return new Set(
    normalizeTopic(text)
      .split(" ")
      .filter((word) => word.length > 2 && !TOPIC_STOPWORDS.has(word))
      .map(foldTopicWord)
      .filter((word) => word.length > 2)
  );
}

// Share of the shorter idea's key words that also appear in the other.
function topicSimilarity(a, b) {
  const wordsA = topicWords(a);
  const wordsB = topicWords(b);

  if (wordsA.size < 2 || wordsB.size < 2) {
    return normalizeTopic(a) === normalizeTopic(b) ? 1 : 0;
  }

  let shared = 0;

  for (const word of wordsA) {
    if (wordsB.has(word)) {
      shared++;
    }
  }

  return shared / Math.min(wordsA.size, wordsB.size);
}

function isRepeatTopic(idea, pastIdeas) {
  return pastIdeas.some(
    (past) => topicSimilarity(idea, past) >= TOPIC_SIMILARITY_LIMIT
  );
}

async function getTopicHistory(kv) {
  try {
    const list = JSON.parse((await kv.get(TOPIC_HISTORY_KEY)) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function mergeTopics(history, entries) {
  const list = history.map((entry) => ({ ...entry }));

  for (const entry of entries) {
    const key = normalizeTopic(entry?.idea);

    if (!key) {
      continue;
    }

    const existing = list.find((h) => normalizeTopic(h.idea) === key);

    if (existing) {
      if (entry.status === "made" && existing.status !== "made") {
        existing.status = "made";
        existing.madeAt = nowIso();
      }
      if (entry.title && !existing.title) {
        existing.title = entry.title;
      }
      continue;
    }

    list.push({
      idea: String(entry.idea).slice(0, 300),
      ...(entry.title ? { title: String(entry.title).slice(0, 200) } : {}),
      status: entry.status === "made" ? "made" : "suggested",
      at: nowIso(),
    });
  }

  // Too long: forget the oldest ideas that were only suggested first
  while (list.length > TOPIC_HISTORY_MAX) {
    const index = list.findIndex((h) => h.status !== "made");
    list.splice(index === -1 ? 0 : index, 1);
  }

  return list;
}

async function saveTopicHistory(kv, list) {
  await kv.put(TOPIC_HISTORY_KEY, JSON.stringify(list));
}

async function recordMadeTopic(kv, script) {
  if (!script?.idea) {
    return;
  }

  try {
    const history = await getTopicHistory(kv);

    await saveTopicHistory(
      kv,
      mergeTopics(history, [
        { idea: script.idea, title: script.title, status: "made" },
      ])
    );
  } catch (error) {
    console.error("Topic history error:", error);
  }
}

async function callGemini(apiKey, prompt) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(SCRIPT_MODEL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.9,
          },
        }),
      });

      const data = await response.json();

      if (response.ok) {
        return (
          (data.candidates?.[0]?.content?.parts || [])
            .filter((part) => !part.thought)
            .map((part) => part.text || "")
            .join("") || ""
        );
      }

      lastError = new Error(
        data?.error?.message ||
          `Gemini request failed with status ${response.status}`
      );

      if (response.status !== 429 && response.status !== 503) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < 2) {
      await sleep(1500 * (attempt + 1));
    }
  }

  throw lastError || new Error("Gemini request failed.");
}

function parseJsonArray(text) {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start === -1 || end === -1) {
    throw new Error("Gemini did not return a valid JSON array.");
  }

  const parsed = JSON.parse(cleaned.slice(start, end + 1));

  if (!Array.isArray(parsed)) {
    throw new Error("Gemini response was not an array.");
  }

  return parsed;
}


// ============================================================
// APPROVE / REJECT BUTTONS
// Approve = the only manual step. It queues the idea and starts
// production straight away if nothing else is being made.
// ============================================================

const IDEAS_FOOTER =
  "Tap ✅ Approve on the ideas you want.\n" +
  "Each one is written, voiced, filmed with real clips, built and scheduled on YouTube automatically.";

async function handleCallbackQuery(callbackQuery, env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const kv = env.BEYOND_THE_BLINK_DATA;
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data || "";

  if (!chatId) {
    return;
  }

  try {
    const match = /^(approve|reject)_(\d+)(?:_([a-z0-9]+))?$/.exec(data);

    if (match) {
      const isApprove = match[1] === "approve";
      const index = Number(match[2]);
      const tag = match[3] || "";
      const week = await getCurrentWeek(kv);

      if (!week || !Array.isArray(week.ideas) || !week.ideas[index]) {
        await answerCallbackQuery(
          botToken,
          callbackQuery.id,
          "This ideas list is no longer available."
        );
        return;
      }

      if ((tag && tag !== weekTag(week)) || (!tag && week.buttonsTagged)) {
        await answerCallbackQuery(
          botToken,
          callbackQuery.id,
          "This list is out of date — use the newest ideas message. " +
          "(If it just arrived, wait a minute and tap again.)"
        );
        return;
      }

      if (!Array.isArray(week.approved)) {
        week.approved = [];
      }

      if (!Array.isArray(week.rejected)) {
        week.rejected = [];
      }

      if (isApprove) {
        if (!week.approved.includes(index)) {
          week.approved.push(index);
        }
        week.rejected = week.rejected.filter((item) => item !== index);
      } else {
        if (!week.rejected.includes(index)) {
          week.rejected.push(index);
        }
        week.approved = week.approved.filter((item) => item !== index);
      }

      await kv.put("current_week", JSON.stringify(week), {
        expirationTtl: WEEK_TTL_SECONDS,
      });

      await answerCallbackQuery(
        botToken,
        callbackQuery.id,
        isApprove
          ? `Idea ${index + 1} approved — it will be made automatically.`
          : `Idea ${index + 1} rejected.`
      );

      await refreshIdeaMessage(botToken, chatId, messageId, week);

      if (isApprove) {
        await startNextShort(env, chatId, "approve", index + 1);
      } else {
        const queue = await getQueueInfo(kv, week);
        await maybeStartNewWeek(env, chatId, week, queue);
      }

      return;
    }

    // Button from older idea messages
    if (data === "approve_week") {
      await answerCallbackQuery(
        botToken,
        callbackQuery.id,
        "Not needed any more — just tap ✅ Approve on the ideas you want."
      );
      return;
    }

    await answerCallbackQuery(botToken, callbackQuery.id, "Unknown button.");
  } catch (error) {
    console.error("Callback error:", error);

    await answerCallbackQuery(
      botToken,
      callbackQuery.id,
      "Something went wrong."
    );
  }
}

async function refreshIdeaMessage(botToken, chatId, messageId, week) {
  let message = "🎬 BEYOND THE BLINK IDEAS\n\n";

  week.ideas.forEach((idea, index) => {
    let status = "⬜";

    if (week.approved.includes(index)) {
      status = "✅";
    }

    if (week.rejected.includes(index)) {
      status = "❌";
    }

    message += `${status} ${index + 1}. ${idea}\n\n`;
  });

  message += IDEAS_FOOTER;

  await editTelegramMessage(botToken, chatId, messageId, message, {
    reply_markup: {
      inline_keyboard: ideaKeyboard(week.ideas.length, weekTag(week)),
    },
  });
}


// ============================================================
// TAMIL SCRIPT
// Written by /script-one (called by GitHub), saved with the Short.
// ============================================================
async function writeTamilScript(apiKey, idea) {
  const prompt = `
You are the head writer for a Tamil YouTube Shorts channel called
"Beyond the Blink". The channel tells short, emotional, true-to-life
stories from Tamil life. The narration is spoken in Tamil over real
stock video clips.

Write ONE original short story for this approved idea:

"${idea}"

LANGUAGE:
- Write the title in natural Tamil.
- Write the narration in natural, conversational, modern Tamil that
  Tamil-speaking viewers enjoy. Sound like a real storyteller, not a
  translation from English.
- Keep a few everyday English words when that sounds natural
  (bus, hotel, phone).

STORY:
- A tiny story with a named character, a moment, a problem and a turn.
- First beat: a hook that makes the viewer curious within 3 seconds.
- Middle beats: build the situation with specific, concrete details
  (smells, sounds, objects, small actions), not general statements.
- Last beat: a quiet, memorable ending. Show it, do not lecture.
  No moral stated outright.
- Characters and events are fictional. No real people, celebrities,
  politicians, film dialogue, film plots or brand names.
- Treat every culture, religion and community with respect.
- Short spoken sentences. No filler. No stage directions, sound cues,
  brackets or emojis.

STRUCTURE — exactly ${BEAT_COUNT} beats, each 1–3 short sentences:
Total length 35–55 seconds spoken (about ${BEAT_COUNT * 2 + 2}–${BEAT_COUNT * 3} sentences).

FOOTAGE (this matters):
Each beat is shown with ONE real stock video clip found by searching
a stock library (Pixabay). For every beat write:
- "stock_search": 2–4 ENGLISH words naming something concrete that
  a camera would actually film (for example "tea shop steam",
  "village bus road", "hands cooking kitchen", "rain street night").
  Not abstract ideas, not names, not Tamil words.
- "alt_search": a broader 1–3 word English backup search
  (for example "street food", "bus", "rain").
- "image_prompt": a 1–2 sentence ENGLISH description of a single
  realistic scene for an AI image generator, used only if no stock clip
  is found. Subject centred for a vertical 9:16 frame. No text, logos
  or real people.

Return ONLY valid JSON in exactly this format:

{
  "title": "தமிழ் தலைப்பு",
  "beats": [
    {
      "text": "Tamil narration for this beat",
      "stock_search": "english words",
      "alt_search": "english word",
      "image_prompt": "english scene description"
    }
  ]
}

The "beats" array must contain exactly ${BEAT_COUNT} items.
`;

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(SCRIPT_MODEL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.9,
            responseMimeType: "application/json",
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data?.error?.message ||
          `Gemini script request failed with status ${response.status}`
        );
      }

      const text = (data.candidates?.[0]?.content?.parts || [])
        .filter((part) => !part.thought)
        .map((part) => part.text || "")
        .join("");

      return parseStoryJson(text);
    } catch (error) {
      lastError = error;

      if (attempt === 0) {
        await sleep(1500);
      }
    }
  }

  throw lastError || new Error("Script generation failed.");
}

// Turns Gemini's JSON text into { title, script, scenes, beats }.
// script = all beats joined (voice, captions and YouTube use it);
// scenes = the image prompts (the old /visual-one still reads them).
function parseStoryJson(rawText) {
  const text = String(rawText || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("Gemini did not return a JSON object.");
  }

  const parsed = JSON.parse(text.slice(start, end + 1));
  const title = String(parsed?.title ?? "").trim();

  const beats = (Array.isArray(parsed?.beats) ? parsed.beats : [])
    .map((beat) => ({
      text: String(beat?.text ?? "").replace(/\s+/g, " ").trim(),
      stock_search: cleanSearch(beat?.stock_search),
      alt_search: cleanSearch(beat?.alt_search),
      image_prompt: String(beat?.image_prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    }))
    .filter((beat) => beat.text);

  if (!title) {
    throw new Error("Gemini returned a story without a title.");
  }

  if (beats.length !== BEAT_COUNT) {
    throw new Error(`Gemini returned ${beats.length} beats instead of ${BEAT_COUNT}.`);
  }

  beats.forEach((beat, i) => {
    if (!beat.stock_search) {
      throw new Error(`Beat ${i + 1} has no stock_search words.`);
    }

    if (!beat.alt_search) {
      beat.alt_search = beat.stock_search.split(" ")[0];
    }

    if (!beat.image_prompt) {
      beat.image_prompt = `Realistic scene of ${beat.stock_search}, vertical frame, no text.`;
    }
  });

  return {
    title,
    script: beats.map((beat) => beat.text).join(" "),
    scenes: beats.map((beat) => beat.image_prompt),
    beats,
  };
}

// English search words only: letters, digits, spaces; max 60 characters.
function cleanSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

// Beats for any Short, including Shorts written before beats existed
// (those get 3 beats split from their sentences and old scene prompts).
function getBeats(script) {
  if (Array.isArray(script?.beats) && script.beats.length) {
    return script.beats;
  }

  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  const sentences = cleanNarration(script?.script)
    .split(/(?<=[.!?।])\s+/)
    .filter(Boolean);
  const parts = Math.max(1, Math.min(3, scenes.length || 3));
  const size = Math.ceil(sentences.length / parts) || 1;

  return Array.from({ length: parts }, (_, i) => {
    const scene = String(scenes[i] || "").trim();
    const text = sentences.slice(i * size, (i + 1) * size).join(" ");

    return {
      text: text || cleanNarration(script?.script),
      stock_search: cleanSearch(scene.split(/\s+/).slice(0, 4).join(" ")) || "cinematic landscape",
      alt_search: cleanSearch(scene.split(/\s+/).slice(0, 2).join(" ")) || "landscape",
      image_prompt: scene || "Cinematic realistic scene, vertical frame, no text.",
    };
  });
}


// ============================================================
// START THE NEXT SHORT
//
// mode:
//   "approve" — you tapped Approve (tappedShort = that idea)
//   "chain"   — the previous Short just finished uploading
//   "tick"    — hourly safety check
//   "manual"  — /make (also retries Shorts that stopped)
//
// Only one Short is made at a time; the rest wait in the queue
// (in the order you approved them).
// ============================================================

async function startNextShort(env, chatId, mode, tappedShort = null) {
  const kv = env.BEYOND_THE_BLINK_DATA;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    const week = await getCurrentWeek(kv);

    if (!week || !Array.isArray(week.ideas) || week.ideas.length === 0) {
      if (mode === "manual") {
        await sendTelegramMessage(token, chatId, "⚠️ No ideas found. Send /ideas first.");
      }
      return null;
    }

    const queue = await getQueueInfo(kv, week);

    if (queue.running) {
      const minutes = Math.max(
        0,
        Math.round((Date.now() - Date.parse(queue.runningSince)) / 60000)
      );

      if (mode === "manual") {
        await sendTelegramMessage(
          token,
          chatId,
          `⏳ Short ${queue.running} is being made right now (started ${minutes} min ago).\n\n` +
          "Everything else you approved will follow automatically.\n\n" +
          "If it already stopped with an error, wait a minute and send /make again."
        );
      }

      if (mode === "approve" && tappedShort) {
        await sendTelegramMessage(
          token,
          chatId,
          tappedShort === queue.running
            ? `⏳ Short ${tappedShort} is being made right now.`
            : `✅ Short ${tappedShort} is in the queue.\n\n` +
              `It starts automatically after Short ${queue.running} is finished.`
        );
      }

      return null;
    }

    if (mode === "tick" && (await kv.get("auto_paused"))) {
      return null; // a Short stopped with an error — wait for you
    }

    // Shorts that stopped with an error are only retried by /make,
    // or when you tap Approve on that same idea again.
    const next = queue.pending.find(
      (shortNumber) =>
        mode === "manual" ||
        shortNumber === tappedShort ||
        !queue.failed.includes(shortNumber)
    );

    if (!next) {
      if (mode === "manual") {
        await sendTelegramMessage(
          token,
          chatId,
          "✅ Every approved idea is already on YouTube.\n\n" +
          "Tap ✅ Approve on another idea."
        );
        return null;
      }

      await maybeStartNewWeek(env, chatId, week, queue);
      return null;
    }

    const state = queue.states[next] || {};
    const script = getScript(week, state, next);
    const fullRunAt = Date.parse(state.production?.fullRunAt || "");
    const videoAt = Date.parse(state.video?.at || "");

    let from = "voice";

    if (!script?.script) {
      from = "script";
    } else if (!Number.isNaN(fullRunAt) && videoAt >= fullRunAt) {
      from = "upload"; // the last full run already built the video
    }

    await dispatchGitHubEvent(env.GITHUB_TOKEN, "produce_short", {
      short: next,
      from,
    });

    const now = nowIso();

    await updateShortState(kv, week, next, (s) => {
      s.production = {
        startedAt: now,
        from,
        fullRunAt: from === "upload" ? s.production?.fullRunAt || now : now,
      };
      s.failedAt = null;
    });

    await kv.delete("auto_paused");

    const lead =
      mode === "chain" ? "🎬 Next up: Short" :
      mode === "tick" ? "🔄 Starting queued Short" :
      "🎬 Making Short";

    let message;

    if (from === "upload") {
      message =
        `📺 Short ${next}'s video is already built.\n\n` +
        "Retrying just the YouTube upload...";
    } else {
      message =
        `${lead} ${next}\n\n` +
        `${script?.title || week.ideas[next - 1]}\n\n` +
        (from === "script" ? "Script → voice" : "Voice") +
        " → real video clips → video → YouTube.\n" +
        "I'll send each piece here as it's ready (about 5–10 minutes).";
    }

    await sendTelegramMessage(token, chatId, message);

    return next;
  } catch (error) {
    console.error("Start production error:", error);

    if (mode !== "tick") {
      await sendTelegramMessage(
        token,
        chatId,
        `❌ Couldn't start the next Short.\n\n${error.message}`
      );
    }

    return null;
  }
}


// ============================================================
// /status
// ============================================================

async function sendStatus(env, chatId) {
  const kv = env.BEYOND_THE_BLINK_DATA;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    const week = await getCurrentWeek(kv);

    if (!week || !Array.isArray(week.ideas) || week.ideas.length === 0) {
      await sendTelegramMessage(token, chatId, "⚠️ No ideas found. Send /ideas first.");
      return;
    }

    const rejected = Array.isArray(week.rejected) ? week.rejected : [];
    const order = approvedOrder(week);
    const lines = [];
    const notReviewed = [];

    for (let index = 0; index < week.ideas.length; index++) {
      if (!order.includes(index) && !rejected.includes(index)) {
        notReviewed.push(index + 1);
      }
    }

    for (const index of order) {
      const shortNumber = index + 1;
      const state = await getShortState(kv, week, shortNumber);
      const script = getScript(week, state, shortNumber);
      const phase = shortPhase(state);

      let youtube = "🕒 waiting in the queue";

      if (phase === "done") {
        youtube = state.upload.publishAt
          ? `✅ ${formatIST(state.upload.publishAt)}`
          : "✅ uploaded";
      } else if (phase === "failed") {
        youtube = "⛔ stopped — send /make to retry";
      } else if (phase === "running") {
        youtube = "⏳ being made now";
      }

      lines.push(
        `Short ${shortNumber}: ` +
        `script ${script?.script ? "✅" : "—"} · ` +
        `voice ${state.voice ? "✅" + (state.voice.name ? ` ${state.voice.name}` : "") : "—"} · ` +
        `video ${state.video ? "✅" : "—"}\n` +
        `   YouTube: ${youtube}` +
        (state.thumbnail ? `\n   Cover: ${state.thumbnail.status === "done" ? "✅" : state.thumbnail.status === "failed" ? "⚠️ needs attention" : "⏳ processing"}` : "")
      );
    }

    let message = "📋 STATUS\n\n";

    message += lines.length
      ? lines.join("\n\n")
      : "No approved ideas yet.";

    if (notReviewed.length) {
      message += `\n\nNot reviewed yet: ${notReviewed.join(", ")}`;
    }

    if (await kv.get("auto_paused")) {
      message += "\n\n⚠️ The queue is paused after an error. Send /make to continue.";
    }

    await sendTelegramMessage(token, chatId, message);
  } catch (error) {
    console.error("Status error:", error);

    await sendTelegramMessage(token, chatId, `❌ Couldn't read status.\n\n${error.message}`);
  }
}


// ============================================================
// /script-one — Tamil script for one Short (called by GitHub)
// ============================================================

async function handleScriptOne(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const chatId = url.searchParams.get("chat");
  const shortNumber = parseShortNumber(url.searchParams.get("short"));

  if (!chatId) {
    return textResponse("Missing chat.", 400);
  }

  if (!shortNumber) {
    return textResponse("Invalid short number.", 400);
  }

  const kv = env.BEYOND_THE_BLINK_DATA;

  try {
    const week = await getCurrentWeek(kv);
    const idea = week?.ideas?.[shortNumber - 1];

    if (!idea) {
      throw new Error(`Idea ${shortNumber} not found in the current list.`);
    }

    const state = await getShortState(kv, week, shortNumber);
    const existing = getScript(week, state, shortNumber);

    if (existing?.script) {
      return textResponse(`Script ${shortNumber} already exists.`);
    }

    const result = await writeTamilScript(env.GEMINI_API_KEY, String(idea));

    await updateShortState(kv, week, shortNumber, (s) => {
      s.script = {
        idea: String(idea),
        title: result.title,
        script: result.script,
        scenes: result.scenes,
        beats: result.beats,
        createdAt: nowIso(),
      };
    });

    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `✍️ SCRIPT ${shortNumber}\n\n${result.title}\n\n${result.script}`
    );

    return textResponse(`✅ Script ${shortNumber} ready.`);
  } catch (error) {
    console.error("Script error:", error);

    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `❌ Short ${shortNumber} — script failed.\n\n${error.message}`
    );

    return textResponse(`Script failed: ${error.message}`, 500);
  }
}


// ============================================================
// /script-text — the narration as plain text, for the captions
// (called by GitHub while building the video)
// ============================================================

function cleanNarration(text) {
  return String(text || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .trim();
}

async function handleScriptText(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const shortNumber = parseShortNumber(url.searchParams.get("short"));

  if (!shortNumber) {
    return textResponse("Invalid short number.", 400);
  }

  const kv = env.BEYOND_THE_BLINK_DATA;
  const week = await getCurrentWeek(kv);
  const state = await getShortState(kv, week, shortNumber);
  const script = getScript(week, state, shortNumber);

  if (!script?.script) {
    return textResponse("Script not found.", 404);
  }

  return textResponse(cleanNarration(script.script));
}


// ============================================================
// /script-beats — the story beats as JSON, for finding footage
// (called by GitHub while building the video)
// ============================================================

async function handleScriptBeats(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const shortNumber = parseShortNumber(url.searchParams.get("short"));

  if (!shortNumber) {
    return textResponse("Invalid short number.", 400);
  }

  const kv = env.BEYOND_THE_BLINK_DATA;
  const week = await getCurrentWeek(kv);
  const state = await getShortState(kv, week, shortNumber);
  const script = getScript(week, state, shortNumber);

  if (!script?.script) {
    return textResponse("Script not found.", 404);
  }

  const beats = getBeats(script).map((beat) => ({
    ...beat,
    text: cleanNarration(beat.text),
  }));

  return new Response(
    JSON.stringify({ title: script.title || "", beats }),
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}


// ============================================================
// /tick — hourly safety check (called by queue-check.yml)
// Starts the next approved Short if nothing is being made.
// ============================================================

async function handleTick(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const chatId = url.searchParams.get("chat");

  if (!chatId) {
    return textResponse("Missing chat.", 400);
  }

  // Cover retries are independent: a delayed preview must not pause production.
  await retryPendingThumbnails(env);
  const started = await startNextShort(env, chatId, "tick");

  return textResponse(
    started ? `Started Short ${started}.` : "Nothing to start."
  );
}


// ============================================================
// /voice-one — Tamil voice for one Short (called by GitHub)
// ============================================================

async function handleVoiceOne(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const chatId = url.searchParams.get("chat");
  const shortNumber = parseShortNumber(url.searchParams.get("short"));

  if (!chatId) {
    return textResponse("Missing chat.", 400);
  }

  if (!shortNumber) {
    return textResponse("Invalid short number.", 400);
  }

  const kv = env.BEYOND_THE_BLINK_DATA;

  try {
    const week = await getCurrentWeek(kv);
    const state = await getShortState(kv, week, shortNumber);
    const script = getScript(week, state, shortNumber);
    const narration = script?.script || "";

    if (!narration) {
      throw new Error(`Script ${shortNumber} not found.`);
    }

    const voiceText = cleanNarration(narration);

    const voiceName = await chooseStoryVoice(kv, week, shortNumber, state);
    const voice = await createTamilVoice(env.GEMINI_API_KEY, voiceText, voiceName);
    const fileName = `voice-${shortNumber}.wav`;

    await putGitHubFile(
      env.GITHUB_TOKEN,
      fileName,
      voice.base64,
      `Add Tamil voice ${shortNumber}`
    );

    const seconds = Math.round(voice.seconds);

    await updateShortState(kv, week, shortNumber, (s) => {
      s.voice = { file: fileName, seconds, name: voiceName, at: nowIso() };
    });

    const warning =
      seconds < 30 || seconds > 62
        ? `\n\n⚠️ ${seconds}s is outside the 35–60s target.`
        : "";

    const sent = await sendTelegramAudio(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      voice.bytes,
      fileName,
      `🎙️ Short ${shortNumber} — Tamil voice: ${voiceName} (${seconds}s)\n\n` +
      `${script?.title || ""}${warning}`
    );

    if (!sent?.ok) {
      console.error("Telegram audio failed:", sent);
    }

    return textResponse(`✅ Voice ${shortNumber} ready: ${voiceName} (${seconds}s).`);
  } catch (error) {
    console.error("Voice error:", error);

    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `❌ Short ${shortNumber} — voice failed.\n\n${error.message}`
    );

    return textResponse(`Voice failed: ${error.message}`, 500);
  }
}

async function chooseStoryVoice(kv, week, shortNumber, state) {
  const existing = state?.voiceChoice?.name || state?.voice?.name;
  if (STORY_VOICES.includes(existing)) return existing;
  // The workflow serializes Shorts, so the previous choice is from the last story.
  const previous = (await kv.get("last_story_voice")) || "Kore";
  const pool = STORY_VOICES.filter((name) => name !== previous);
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const name = pool[Math.floor((random[0] / 4294967296) * pool.length)];
  // Persist BEFORE the external request; timeouts keep the same narrator.
  await updateShortState(kv, week, shortNumber, (s) => {
    s.voiceChoice = { name, at: nowIso() };
  });
  await kv.put("last_story_voice", name);
  return name;
}

async function createTamilVoice(apiKey, text, voiceName = "Kore") {
  if (!text) {
    throw new Error("Script text is empty.");
  }

  const response = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Speak the following narration naturally in Tamil. " +
                "Use a cinematic, clear and engaging storytelling voice. " +
                "Do not translate names or technical terms unnecessarily. " +
                "Narration:\n\n" +
                text,
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gemini TTS failed (${response.status}): ${googleErrorMessage(errorText)}`
    );
  }

  const data = await response.json();

  const audioPart = (data?.candidates?.[0]?.content?.parts || []).find(
    (part) => part?.inlineData?.data
  );

  if (!audioPart) {
    throw new Error("Gemini TTS returned no audio.");
  }

  const audioBase64 = audioPart.inlineData.data;
  const mimeType = audioPart.inlineData.mimeType || "";

  // Already a WAV file
  if (audioBase64.startsWith("UklGR")) {
    const bytes = base64ToBytes(audioBase64);
    return { bytes, base64: audioBase64, seconds: wavSeconds(bytes) };
  }

  // Raw PCM (audio/L16) — add a WAV header
  const sampleRate = Number(/rate=(\d+)/i.exec(mimeType)?.[1]) || 24000;
  const pcm = base64ToBytes(audioBase64);
  const bytes = pcmToWav(pcm, sampleRate);

  return {
    bytes,
    base64: bytesToBase64(bytes),
    seconds: pcm.length / (sampleRate * 2),
  };
}

function pcmToWav(pcm, sampleRate, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);

  const ascii = (offset, value) => {
    for (let i = 0; i < value.length; i++) {
      out[offset + i] = value.charCodeAt(i);
    }
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);

  return out;
}

function wavSeconds(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate = 0;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );

    const size = view.getUint32(offset + 4, true);

    if (id === "fmt " && offset + 20 <= bytes.length) {
      byteRate = view.getUint32(offset + 16, true);
    }

    if (id === "data") {
      const dataSize = Math.min(size, bytes.length - offset - 8);
      return byteRate ? dataSize / byteRate : 0;
    }

    offset += 8 + size + (size % 2);
  }

  return 0;
}


// ============================================================
// /visual-one — one AI image for one Short (called by GitHub)
//   Fallback only: used for a beat when no stock clip was found.
//   raw=1 → returns the JPEG itself; nothing is saved or sent.
// ============================================================

async function handleVisualOne(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const chatId = url.searchParams.get("chat");
  const shortNumber = parseShortNumber(url.searchParams.get("short"));
  const visualNumber = Number(url.searchParams.get("visual"));

  if (!chatId) {
    return textResponse("Missing chat.", 400);
  }

  if (!shortNumber) {
    return textResponse("Invalid short number.", 400);
  }

  const rawMode = url.searchParams.get("raw") === "1";

  if (!Number.isInteger(visualNumber) || visualNumber < 1 || visualNumber > 12) {
    return textResponse("Invalid visual number.", 400);
  }

  const kv = env.BEYOND_THE_BLINK_DATA;

  try {
    const week = await getCurrentWeek(kv);
    const state = await getShortState(kv, week, shortNumber);
    const script = getScript(week, state, shortNumber);
    const narration = script?.script || "";

    if (!narration) {
      throw new Error(`Script ${shortNumber} not found.`);
    }

    const scene = Array.isArray(script?.scenes)
      ? String(script.scenes[visualNumber - 1] || "").trim()
      : "";

    const sceneNames = ["Opening scene", "Middle scene", "Final scene"];
    const sceneName = sceneNames[visualNumber - 1] || `Scene ${visualNumber}`;

    const prompt = (
      scene
        ? "Cinematic photorealistic vertical shot. " +
          scene +
          " Dramatic realistic lighting, atmospheric, high detail, " +
          "sharp focus, main subject centred. " +
          "No text, no captions, no logos, no watermark."
        : "Cinematic photorealistic scene for a YouTube Short. " +
          "Dramatic realistic lighting, atmospheric, high detail, " +
          "no text, no captions, no logos. " +
          "Strong vertical-friendly composition. " +
          `${sceneName}. ` +
          narration
    ).slice(0, 2000);

    const result = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt,
      steps: 4,
    });

    if (!result || !result.image) {
      throw new Error("FLUX did not return an image.");
    }

    const imageBytes = base64ToBytes(result.image);
    const fileName = `visual-${shortNumber}-${visualNumber}.jpg`;

    if (rawMode) {
      return new Response(imageBytes, {
        headers: { "Content-Type": "image/jpeg" },
      });
    }

    await putGitHubFile(
      env.GITHUB_TOKEN,
      fileName,
      result.image,
      `Add Short ${shortNumber} visual ${visualNumber}`
    );

    await updateShortState(kv, week, shortNumber, (s) => {
      s.visuals = { ...(s.visuals || {}), [visualNumber]: nowIso() };
    });

    const sent = await sendTelegramPhoto(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      imageBytes,
      fileName,
      `🖼️ Short ${shortNumber} — Visual ${visualNumber}`
    );

    if (!sent?.ok) {
      console.error("Telegram photo failed:", sent);
    }

    return textResponse(`✅ Visual ${shortNumber}-${visualNumber} ready.`);
  } catch (error) {
    console.error("Visual error:", error);

    if (!rawMode) {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `❌ Short ${shortNumber} — visual ${visualNumber} failed.\n\n${error.message}`
      );
    }

    return textResponse(`Visual failed: ${error.message}`, 500);
  }
}


// ============================================================
// /upload — YouTube upload + schedule (called by GitHub)
// ============================================================

async function handleUpload(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const shortNumber = parseShortNumber(url.searchParams.get("i"));

  if (!shortNumber) {
    return textResponse("Invalid Short number. Use i=1 through i=7.", 400);
  }

  const chatId = url.searchParams.get("chat");
  const ref = (url.searchParams.get("ref") || "main").trim();
  const force = url.searchParams.get("force") === "1";

  if (!/^(main|[0-9a-f]{7,40})$/i.test(ref)) {
    return textResponse("Invalid ref.", 400);
  }

  const kv = env.BEYOND_THE_BLINK_DATA;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    const week = await getCurrentWeek(kv);

    if (!week) {
      throw new Error("No current week found.");
    }

    const state = await getShortState(kv, week, shortNumber);

    if (state.upload?.videoId && !force) {
      // An upload retry repairs a missing cover job without uploading twice.
      await queueThumbnail(env, week, shortNumber, state.upload.videoId, state.video?.ref || ref);
      return textResponse(
        `Short #${shortNumber} is already on YouTube ` +
        `(video ${state.upload.videoId}). Nothing to do.`
      );
    }

    await updateShortState(kv, week, shortNumber, (s) => {
      s.video = { ref, at: nowIso() };
    });

    const script = getScript(week, state, shortNumber);
    const title = buildYouTubeTitle(script, shortNumber);
    const description = buildYouTubeDescription(script);
    const publishAt = await getNextPublishSlot(kv);

    const video = await uploadShortToYouTube(env, {
      title,
      description,
      shortNumber,
      ref,
      publishAt,
    });

    // Save straight away so a retry never uploads twice
    await updateShortState(kv, week, shortNumber, (s) => {
      s.upload = {
        videoId: video.id,
        publishAt: video.status?.publishAt || null,
        at: nowIso(),
      };
      s.failedAt = null;
    });

    // Keep the exact upload commit and week. The approval list can advance
    // before YouTube finishes processing, so never resolve a cover by Short N alone.
    await queueThumbnail(env, week, shortNumber, video.id, ref);

    let scheduledFor = video.status?.publishAt;

    if (!scheduledFor) {
      const scheduled = await scheduleYouTubeVideo(env, video.id, publishAt);
      scheduledFor = scheduled.status?.publishAt || publishAt;

      await updateShortState(kv, week, shortNumber, (s) => {
        s.upload = { ...(s.upload || {}), publishAt: scheduledFor };
      });
    }

    await kv.put("last_publish_at", scheduledFor);

    // Never suggest this topic again
    await recordMadeTopic(kv, script);

    if (chatId) {
      const caption =
        `📺 Short ${shortNumber} is on YouTube\n\n` +
        `${title}\n\n` +
        `Goes public: ${formatIST(scheduledFor)}\n\n` +
        `Review it before then:\nhttps://studio.youtube.com/video/${video.id}/edit`;

      const videoUrl =
        `https://raw.githubusercontent.com/${GITHUB_REPO}/${ref}/` +
        `beyond-the-blink-short-${shortNumber}.mp4`;

      const sent = await sendTelegramVideoByUrl(token, chatId, videoUrl, caption);

      if (!sent?.ok) {
        await sendTelegramMessage(token, chatId, caption);
      }

      // Start the next approved idea (or send new ideas if all are done)
      await startNextShort(env, chatId, "chain");
    }

    return textResponse(
      `✅ Short #${shortNumber} uploaded.\n\n` +
      `Video ID: ${video.id}\n` +
      `Scheduled for: ${scheduledFor}`
    );
  } catch (error) {
    console.error(`YouTube upload error for Short #${shortNumber}:`, error);

    if (chatId) {
      await sendTelegramMessage(
        token,
        chatId,
        `❌ Short ${shortNumber} — YouTube upload failed.\n\n${error.message}`
      );
    }

    return textResponse(
      `❌ Short #${shortNumber} upload failed.\n\n${error.message}`,
      500
    );
  }
}

function buildYouTubeTitle(script, shortNumber) {
  const base = String(script?.title || `Beyond the Blink — Short #${shortNumber}`).trim();
  const withTag = `${base} #Shorts`;
  return withTag.length <= 100 ? withTag : base.slice(0, 100);
}

// ============================================================
// Covers: upload only after YouTube processing succeeds.
// Jobs are keyed by immutable Git commit + Short number, not current_week.
// ============================================================

function thumbnailJobKey(ref, shortNumber) {
  return `thumbnail-job:${ref}:${shortNumber}`;
}

function thumbnailPendingKey(job) {
  return `thumbnail-pending:${job.ref}:${job.shortNumber}`;
}

async function queueThumbnail(env, week, shortNumber, videoId, ref) {
  const kv = env.BEYOND_THE_BLINK_DATA;
  try {
    const key = thumbnailJobKey(ref, shortNumber);
    const existing = await kv.get(key);
    if (existing && JSON.parse(existing).videoId === videoId) return;
    const job = {
      ref, shortNumber, videoId, weekCreatedAt: week.createdAt,
      status: "pending", createdAt: nowIso(),
    };
    await kv.put(key, JSON.stringify(job), { expirationTtl: SHORT_STATE_TTL_SECONDS });
    await kv.put(thumbnailPendingKey(job), key, { expirationTtl: 172800 });
    await updateShortState(kv, week, shortNumber, (s) => {
      s.thumbnail = { status: "pending", videoId, ref, at: nowIso() };
    });
  } catch (error) {
    // Video is already saved; a cover issue must not masquerade as upload failure.
    console.error("Could not queue cover:", error.message);
  }
}

async function saveThumbnailJob(env, job) {
  const kv = env.BEYOND_THE_BLINK_DATA;
  job.updatedAt = nowIso();
  await kv.put(thumbnailJobKey(job.ref, job.shortNumber), JSON.stringify(job),
    { expirationTtl: SHORT_STATE_TTL_SECONDS });
  await updateShortState(kv, { createdAt: job.weekCreatedAt }, job.shortNumber, (s) => {
    s.thumbnail = {
      status: job.status, videoId: job.videoId, ref: job.ref,
      message: job.message || "", at: job.updatedAt,
    };
  });
  if (job.status !== "pending") await kv.delete(thumbnailPendingKey(job));
  return { status: job.status, message: job.message || "" };
}

async function applyThumbnailJob(env, job) {
  if (job.status !== "pending") return { status: job.status, message: job.message || "" };
  // Some services transiently return errors. Leave those pending for the safety check.
  try {
    const accessToken = await getYouTubeAccessToken(env);
    const processing = await fetch(
      "https://www.googleapis.com/youtube/v3/videos?part=processingDetails&id=" +
        encodeURIComponent(job.videoId),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!processing.ok) {
      return { status: "pending", message: `Processing check returned HTTP ${processing.status}.` };
    }
    const data = await processing.json();
    const status = data.items?.[0]?.processingDetails?.processingStatus;
    if (status === "failed" || status === "terminated") {
      job.status = "failed";
      job.message = `YouTube video processing ${status}.`;
      return saveThumbnailJob(env, job);
    }
    if (status !== "succeeded") return { status: "pending", message: "YouTube is still processing." };

    const cover = await fetch(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/${job.ref}/thumbnail-${job.shortNumber}.jpg`
    );
    if (cover.status === 404) {
      job.status = "failed";
      job.message = "The upload commit does not contain its thumbnail JPG.";
      return saveThumbnailJob(env, job);
    }
    if (!cover.ok) return { status: "pending", message: "Cover download will retry." };
    const bytes = new Uint8Array(await cover.arrayBuffer());
    if (bytes.length > 2_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      job.status = "failed";
      job.message = "Cover must be a JPEG smaller than 2 MB.";
      return saveThumbnailJob(env, job);
    }
    const response = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=" +
        encodeURIComponent(job.videoId),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/jpeg" },
        body: bytes,
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      let reason = "";
      try { reason = JSON.parse(errorText)?.error?.errors?.[0]?.reason || ""; } catch {}
      if ((response.status === 400 || response.status === 403) &&
          !/quota|rateLimit|dailyLimit|uploadRate/i.test(reason)) {
        job.status = "failed";
        job.message = `YouTube cover rejected (${response.status}): ${googleErrorMessage(errorText)}`;
        return saveThumbnailJob(env, job);
      }
      return { status: "pending", message: `Cover upload will retry (HTTP ${response.status}).` };
    }
    job.status = "done";
    job.message = "YouTube cover applied.";
    return saveThumbnailJob(env, job);
  } catch (error) {
    console.error("Cover retry pending:", error.message);
    return { status: "pending", message: "Temporary cover service issue; retry queued." };
  }
}

async function handleThumbnailOne(env, url) {
  if (!routeKeyOk(url, env)) return textResponse("Unauthorized.", 401);
  const shortNumber = parseShortNumber(url.searchParams.get("short"));
  const ref = url.searchParams.get("ref") || "";
  if (!shortNumber || !/^(main|[0-9a-f]{7,40})$/i.test(ref)) {
    return textResponse("Invalid Short or ref.", 400);
  }
  const raw = await env.BEYOND_THE_BLINK_DATA.get(thumbnailJobKey(ref, shortNumber));
  if (!raw) return textResponse("Cover job not found for this upload commit.", 404);
  return new Response(JSON.stringify(await applyThumbnailJob(env, JSON.parse(raw))), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function retryPendingThumbnails(env) {
  const kv = env.BEYOND_THE_BLINK_DATA;
  try {
    // Two at a time keeps this within the Worker's free-plan subrequest budget.
    const pending = await kv.list({ prefix: "thumbnail-pending:", limit: 2 });
    for (const item of pending.keys) {
      const key = await kv.get(item.name);
      const raw = key ? await kv.get(key) : null;
      if (raw) await applyThumbnailJob(env, JSON.parse(raw));
      else await kv.delete(item.name);
    }
  } catch (error) {
    console.error("Cover safety check:", error.message);
  }
}

function buildYouTubeDescription(script) {
  const lines = [];

  if (script?.title) {
    lines.push(script.title, "");
  }

  if (script?.idea) {
    lines.push(script.idea, "");
  }

  lines.push(
    "Beyond the Blink — short Tamil stories from everyday Tamil life.",
    "The story and narration are AI-generated. Video clips are stock footage from Pixabay.",
    "",
    "#Shorts #BeyondTheBlink #Tamil #TamilStory"
  );

  return lines.join("\n").slice(0, 4900);
}

// Next free 7:00 pm IST slot: at least 2 hours from now and
// about a day after the last scheduled Short.
async function getNextPublishSlot(kv) {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const earliest = now + 2 * 60 * 60 * 1000;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));

  const get = (type) => parts.find((part) => part.type === type)?.value;
  const hour = String(PUBLISH_HOUR_IST).padStart(2, "0");

  let slot = Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${hour}:00:00+05:30`
  );

  while (slot < earliest) {
    slot += DAY;
  }

  const last = Date.parse((await kv.get("last_publish_at")) || "");

  if (!Number.isNaN(last)) {
    while (slot < last + DAY - 60 * 60 * 1000) {
      slot += DAY;
    }
  }

  return new Date(slot).toISOString();
}

async function getYouTubeAccessToken(env) {
  const refreshToken = await env.BEYOND_THE_BLINK_DATA.get(
    "youtube_refresh_token"
  );

  if (!refreshToken) {
    throw new Error(
      `YouTube is not connected. Open ${WORKER_URL}/youtube and sign in.`
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("YouTube access token error:", data?.error);

    if (data?.error === "invalid_grant") {
      throw new Error(
        "YouTube sign-in has expired (invalid_grant).\n\n" +
        `Reconnect: open ${WORKER_URL}/youtube and sign in, then send /make.`
      );
    }

    throw new Error(
      `Could not get a YouTube access token: ` +
      `${data?.error || response.status} ${data?.error_description || ""}`.trim()
    );
  }

  return data.access_token;
}

async function uploadShortToYouTube(env, { title, description, shortNumber, ref, publishAt }) {
  const accessToken = await getYouTubeAccessToken(env);

  const videoFile = `beyond-the-blink-short-${shortNumber}.mp4`;
  const videoUrl =
    `https://raw.githubusercontent.com/${GITHUB_REPO}/${ref}/${videoFile}`;

  const videoResponse = await fetch(videoUrl);

  if (!videoResponse.ok) {
    throw new Error(
      `Could not download ${videoFile} from GitHub (${videoResponse.status}).`
    );
  }

  const contentLength = videoResponse.headers.get("content-length");

  if (!contentLength) {
    throw new Error("GitHub did not provide the video file size.");
  }

  const uploadStartResponse = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos" +
      "?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": contentLength,
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          categoryId: "24",
          defaultLanguage: "ta",
          defaultAudioLanguage: "ta",
        },
        status: {
          privacyStatus: "private",
          publishAt,
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: true, // "Altered or synthetic content" label
        },
      }),
    }
  );

  if (!uploadStartResponse.ok) {
    const errorText = await uploadStartResponse.text();
    throw new Error(
      `YouTube could not start the upload (${uploadStartResponse.status}): ` +
      googleErrorMessage(errorText)
    );
  }

  const uploadUrl = uploadStartResponse.headers.get("location");

  if (!uploadUrl) {
    throw new Error("YouTube did not return an upload URL.");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "video/mp4",
      "Content-Length": contentLength,
    },
    body: videoResponse.body,
  });

  const uploadText = await uploadResponse.text();

  if (!uploadResponse.ok) {
    throw new Error(
      `YouTube video upload failed (${uploadResponse.status}): ` +
      googleErrorMessage(uploadText)
    );
  }

  const uploadData = JSON.parse(uploadText);

  if (!uploadData?.id) {
    throw new Error("YouTube accepted the upload but returned no video ID.");
  }

  return uploadData;
}

// Fallback only: used if YouTube ignores publishAt on upload.
async function scheduleYouTubeVideo(env, videoId, publishAt) {
  const accessToken = await getYouTubeAccessToken(env);

  const response = await fetch(
    "https://www.googleapis.com/youtube/v3/videos?part=status",
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: videoId,
        status: {
          privacyStatus: "private",
          publishAt,
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: true, // "Altered or synthetic content" label
        },
      }),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `YouTube scheduling failed (${response.status}): ${googleErrorMessage(text)}`
    );
  }

  return JSON.parse(text);
}


// ============================================================
// /notify — message from the GitHub workflow
// ============================================================

async function handleNotify(env, url) {
  if (!routeKeyOk(url, env)) {
    return textResponse("Unauthorized.", 401);
  }

  const chatId = url.searchParams.get("chat");
  const text = url.searchParams.get("text") || "";
  const shortNumber = parseShortNumber(url.searchParams.get("short"));
  const status = url.searchParams.get("status");

  if (shortNumber && status === "failed") {
    const kv = env.BEYOND_THE_BLINK_DATA;
    const week = await getCurrentWeek(kv);

    if (week) {
      await updateShortState(kv, week, shortNumber, (s) => {
        s.failedAt = nowIso();
      });
    }

    // Pause automatic starts until you send /make or approve an idea
    await kv.put("auto_paused", nowIso(), { expirationTtl: 7 * 86400 });
  }

  if (chatId && text) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text.slice(0, 3500));
  }

  return textResponse("OK");
}
