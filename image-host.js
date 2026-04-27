const fs = require("fs");
const path = require("path");
const { createHash } = require("node:crypto");
const { Agent } = require("undici");
const logger = require("./logger");

const CACHE_PATH = path.join(__dirname, "..", "image-cache.json");
const CACHE_WRITE_DEBOUNCE_MS = 750;
const CACHE_MAX_ITEMS = Number(process.env.IMAGE_CACHE_MAX_ITEMS || 1000);
const CACHE_TTL_MS = Number(process.env.IMAGE_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const IMAGE_UPLOAD_MAX_RETRIES = Number(process.env.IMAGE_UPLOAD_MAX_RETRIES || 3);
const IMAGE_UPLOAD_TIMEOUT_MS = Number(process.env.IMAGE_UPLOAD_TIMEOUT_MS || 60_000);
const IMAGE_UPLOAD_RETRY_BASE_MS = Number(process.env.IMAGE_UPLOAD_RETRY_BASE_MS || 1_000);
const UPLOAD_FAILURE_COOLDOWN_MS = Number(process.env.IMAGE_UPLOAD_FAILURE_COOLDOWN_MS || 5 * 60 * 1000);
const NO_BUFFER_FAILURE_COOLDOWN_MS = Number(process.env.IMAGE_UPLOAD_NO_BUFFER_COOLDOWN_MS || 10_000);
const IMAGE_BUFFER_FETCH_RETRIES = Number(process.env.IMAGE_BUFFER_FETCH_RETRIES || 3);
const IMAGE_BUFFER_FETCH_RETRY_MS = Number(process.env.IMAGE_BUFFER_FETCH_RETRY_MS || 1_500);
const IMAGE_URL_FETCH_MAX_BYTES = Number(process.env.IMAGE_URL_FETCH_MAX_BYTES || 8 * 1024 * 1024);
const IMAGE_UPLOAD_CONNECT_TIMEOUT_MS = Number(process.env.IMAGE_UPLOAD_CONNECT_TIMEOUT_MS || 30_000);
const UPLOAD_USER_AGENT = process.env.IMAGE_UPLOAD_USER_AGENT || "curl/8.7.1";
const IMAGE_UPLOAD_PROVIDERS = (process.env.IMAGE_UPLOAD_PROVIDERS || "catbox,litterbox,telegraph,fileio")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const IMAGE_UPLOAD_IMGBB_API_KEY = process.env.IMAGE_UPLOAD_IMGBB_API_KEY || "";
const IMAGE_UPLOAD_IMGUR_CLIENT_ID = process.env.IMAGE_UPLOAD_IMGUR_CLIENT_ID || "";
const IMAGE_UPLOAD_PIXELDRAIN_API_KEY = process.env.IMAGE_UPLOAD_PIXELDRAIN_API_KEY || "";

const fetchDispatcher = new Agent({
  connect: { timeout: IMAGE_UPLOAD_CONNECT_TIMEOUT_MS },
});

let cache = new Map();
let saveTimer = null;
let saveInFlight = false;
let pendingSave = false;
const loggedCacheHits = new Set();
const inFlightUploads = new Map();
const uploadFailures = new Map();
let uploadQueue = Promise.resolve();

const COMMON_UPLOAD_HEADERS = { accept: "*/*" };
const ZEROX0_HEADERS = { ...COMMON_UPLOAD_HEADERS, "user-agent": UPLOAD_USER_AGENT };
const TELEGRAPH_HEADERS = {
  ...COMMON_UPLOAD_HEADERS,
  origin: "https://telegra.ph",
  referer: "https://telegra.ph/",
};

function isExpired(updatedAt, now = Date.now()) {
  return !updatedAt || now - updatedAt > CACHE_TTL_MS;
}

function pruneCache() {
  const now = Date.now();

  for (const [imageKey, entry] of cache) {
    if (!entry?.url || isExpired(entry.updatedAt, now)) {
      cache.delete(imageKey);
      loggedCacheHits.delete(imageKey);
    }
  }

  while (cache.size > CACHE_MAX_ITEMS) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
    loggedCacheHits.delete(oldestKey);
  }
}

function touchCacheEntry(imageKey, entry) {
  cache.delete(imageKey);
  cache.set(imageKey, entry);
}

function normalizeHash(hash) {
  const value = String(hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return value;
}

function hashImageBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function findCachedUrlByHash(hash) {
  const normalizedHash = normalizeHash(hash);
  if (!normalizedHash) return null;

  const now = Date.now();
  for (const [imageKey, entry] of cache) {
    if (!entry?.url) continue;
    if (isExpired(entry.updatedAt, now)) continue;
    if (normalizeHash(entry.hash) !== normalizedHash) continue;
    touchCacheEntry(imageKey, { ...entry, updatedAt: now });
    return entry.url;
  }

  return null;
}

function getCachedUrl(imageKey) {
  const entry = cache.get(imageKey);
  if (!entry) return null;

  if (isExpired(entry.updatedAt)) {
    cache.delete(imageKey);
    loggedCacheHits.delete(imageKey);
    scheduleSave();
    return null;
  }

  touchCacheEntry(imageKey, { ...entry, updatedAt: Date.now() });
  if (!loggedCacheHits.has(imageKey)) {
    loggedCacheHits.add(imageKey);
    logger.info("Album art cache hit", { imageKey, url: entry.url });
  }
  return entry.url;
}

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    for (const [imageKey, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        cache.set(imageKey, { url: value, updatedAt: Date.now() });
      } else if (value && typeof value.url === "string") {
        cache.set(imageKey, {
          url: value.url,
          updatedAt: Number(value.updatedAt) || Date.now(),
          hash: normalizeHash(value.hash) || undefined,
        });
      }
    }

    pruneCache();
    logger.info("Loaded image cache", { entries: cache.size });
  } catch {
    // Cache file may not exist yet.
  }
}

async function flushCache() {
  if (saveInFlight) {
    pendingSave = true;
    return;
  }

  saveInFlight = true;
  pruneCache();

  try {
    const payload = JSON.stringify(Object.fromEntries(cache), null, 2);
    const tempPath = `${CACHE_PATH}.tmp`;
    await fs.promises.writeFile(tempPath, payload);
    await fs.promises.rename(tempPath, CACHE_PATH);
  } catch (err) {
    logger.error("Failed to persist image cache", { error: err.message });
  } finally {
    saveInFlight = false;
    if (pendingSave) {
      pendingSave = false;
      scheduleSave();
    }
  }
}

function scheduleSave() {
  if (saveTimer) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushCache();
  }, CACHE_WRITE_DEBOUNCE_MS);
}

loadCache();
logger.info("Image upload providers configured", {
  providers: IMAGE_UPLOAD_PROVIDERS,
  imgbbKeyConfigured: Boolean(IMAGE_UPLOAD_IMGBB_API_KEY),
  imgurClientIdConfigured: Boolean(IMAGE_UPLOAD_IMGUR_CLIENT_ID),
  pixeldrainKeyConfigured: Boolean(IMAGE_UPLOAD_PIXELDRAIN_API_KEY),
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorDetails(err) {
  const cause = err?.cause;
  return {
    error: err?.message,
    cause: cause?.message || undefined,
    code: err?.code || cause?.code || undefined,
    errno: err?.errno || cause?.errno || undefined,
    syscall: err?.syscall || cause?.syscall || undefined,
    hostname: err?.hostname || cause?.hostname || undefined,
  };
}

function getResponseSnippet(text, limit = 240) {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function getRetryDelayMs(attempt) {
  return IMAGE_UPLOAD_RETRY_BASE_MS * attempt;
}

function isAbortError(err) {
  return err?.name === "AbortError"
    || err?.code === "UND_ERR_ABORTED"
    || err?.code === 20
    || err?.code === 23;
}

function mergeSignals(signalA, signalB) {
  if (signalA && signalB && typeof AbortSignal.any === "function") {
    return AbortSignal.any([signalA, signalB]);
  }
  return signalA || signalB;
}

async function readResponseBuffer(response, maxBytes) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    const full = Buffer.from(await response.arrayBuffer());
    return full.subarray(0, Math.min(full.length, maxBytes));
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      const remaining = maxBytes - total;
      const chunk = Buffer.from(value);
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      total += slice.length;

      if (total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

function queueUpload(task) {
  const next = uploadQueue.then(task, task);
  uploadQueue = next.catch(() => {});
  return next;
}

async function resolveImageBufferWithRetries(imageBufferFn, options = {}) {
  let lastBuffer = null;
  const shouldContinue = typeof options.shouldContinue === "function"
    ? options.shouldContinue
    : () => true;
  const attempts = Math.max(1, Number(options.maxAttempts) || IMAGE_BUFFER_FETCH_RETRIES);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!shouldContinue()) {
      return { buffer: null, skipped: true };
    }

    const buffer = await imageBufferFn();
    if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0) {
      return { buffer, skipped: false };
    }
    lastBuffer = buffer;

    if (attempt < attempts) {
      await sleep(IMAGE_BUFFER_FETCH_RETRY_MS);
    }
  }

  return { buffer: lastBuffer, skipped: false };
}

function getFailureState(imageKey) {
  const state = uploadFailures.get(imageKey);
  if (!state) return null;
  if (typeof state === "number") {
    return { at: state, reason: "generic" };
  }
  if (typeof state.at !== "number") return null;
  return {
    at: state.at,
    reason: String(state.reason || "generic"),
  };
}

function getFailureCooldownMs(reason) {
  if (reason === "no-buffer") return NO_BUFFER_FAILURE_COOLDOWN_MS;
  return UPLOAD_FAILURE_COOLDOWN_MS;
}

function shouldSkipForRecentFailure(imageKey, ignoredReasons = []) {
  const state = getFailureState(imageKey);
  if (!state) return false;
  if (ignoredReasons.includes(state.reason)) return false;
  return Date.now() - state.at < getFailureCooldownMs(state.reason);
}

function markFailure(imageKey, reason) {
  uploadFailures.set(imageKey, { at: Date.now(), reason });
}

async function uploadToCatbox(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("fileToUpload", new Blob([buffer], { type: "image/jpeg" }), `${imageKey}.jpg`);

      const res = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        body: form,
        headers: COMMON_UPLOAD_HEADERS,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("Catbox upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const url = (await res.text()).trim();
      if (url && url.startsWith("https://")) {
        logger.info("Album art upload succeeded", { imageKey, provider: "catbox", url });
        return url;
      }

      logger.warn("Catbox returned unexpected response", { imageKey, response: url });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("Catbox upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }
  return null;
}

async function uploadUrlToCatbox(sourceUrl, imageKey, maxRetries, timeoutMs, signal = null) {
  if (!sourceUrl) return null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("reqtype", "urlupload");
      form.append("url", sourceUrl);

      const res = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        body: form,
        headers: COMMON_UPLOAD_HEADERS,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("Catbox URL upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const url = (await res.text()).trim();
      if (url && url.startsWith("https://")) {
        logger.info("Album art URL upload succeeded", { imageKey, provider: "catbox", url });
        return url;
      }

      logger.warn("Catbox URL upload returned unexpected response", { imageKey, response: url });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("Catbox URL upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }

  return null;
}

async function uploadToLitterbox(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("time", "72h");
      form.append("fileToUpload", new Blob([buffer], { type: "image/jpeg" }), `${imageKey}.jpg`);

      const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
        method: "POST",
        body: form,
        headers: COMMON_UPLOAD_HEADERS,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("Litterbox upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const url = (await res.text()).trim();
      if (url && url.startsWith("https://")) {
        logger.info("Album art upload succeeded", { imageKey, provider: "litterbox", url });
        return url;
      }

      logger.warn("Litterbox returned unexpected response", { imageKey, response: url });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("Litterbox upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }
  return null;
}

async function uploadToTelegraph(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: "image/jpeg" }), `${imageKey}.jpg`);

      const res = await fetch("https://telegra.ph/upload", {
        method: "POST",
        body: form,
        headers: TELEGRAPH_HEADERS,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("Telegraph upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const json = await res.json();
      if (Array.isArray(json) && json[0]?.src) {
        const url = `https://telegra.ph${json[0].src}`;
        logger.info("Album art upload succeeded", { imageKey, provider: "telegraph", url });
        return url;
      }

      logger.warn("Telegraph returned unexpected response", { imageKey, response: JSON.stringify(json) });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("Telegraph upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }
  return null;
}

async function uploadTo0x0(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: "image/jpeg" }), `${imageKey}.jpg`);

      const res = await fetch("https://0x0.st", {
        method: "POST",
        body: form,
        headers: ZEROX0_HEADERS,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("0x0 upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const url = (await res.text()).trim();
      if (url && (url.startsWith("https://") || url.startsWith("http://"))) {
        logger.info("Album art upload succeeded", { imageKey, provider: "0x0", url });
        return url;
      }

      logger.warn("0x0 returned unexpected response", { imageKey, response: url });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("0x0 upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }
  return null;
}

async function uploadToFileIo(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: "image/jpeg" }), `${imageKey}.jpg`);

      const res = await fetch("https://file.io", {
        method: "POST",
        body: form,
        headers: COMMON_UPLOAD_HEADERS,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("File.io upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const raw = await res.text();
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        logger.warn("File.io returned non-JSON response", {
          imageKey,
          status: res.status,
          statusText: res.statusText,
          responseBody: getResponseSnippet(raw),
        });
        return null;
      }

      const url = typeof json?.link === "string" ? json.link.trim() : "";
      if (json?.success && url && url.startsWith("http")) {
        logger.info("Album art upload succeeded", { imageKey, provider: "fileio", url });
        return url;
      }

      logger.warn("File.io returned unexpected response", { imageKey, response: JSON.stringify(json) });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("File.io upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }
  return null;
}

async function uploadToImgur(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  if (!IMAGE_UPLOAD_IMGUR_CLIENT_ID) return null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("image", new Blob([buffer], { type: "image/jpeg" }), `${imageKey}.jpg`);
      form.append("type", "file");

      const res = await fetch("https://api.imgur.com/3/image", {
        method: "POST",
        body: form,
        headers: {
          ...COMMON_UPLOAD_HEADERS,
          authorization: `Client-ID ${IMAGE_UPLOAD_IMGUR_CLIENT_ID}`,
        },
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("Imgur upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const json = await res.json();
      const url = typeof json?.data?.link === "string" ? json.data.link.trim() : "";
      if (json?.success && url && url.startsWith("http")) {
        logger.info("Album art upload succeeded", { imageKey, provider: "imgur", url });
        return url;
      }

      logger.warn("Imgur returned unexpected response", { imageKey, response: JSON.stringify(json) });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("Imgur upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }
  return null;
}

async function uploadToImgbb(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  if (!IMAGE_UPLOAD_IMGBB_API_KEY) return null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append("image", new Blob([buffer], { type: "image/jpeg" }), `${imageKey}.jpg`);

      const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(IMAGE_UPLOAD_IMGBB_API_KEY)}`, {
        method: "POST",
        body: form,
        headers: COMMON_UPLOAD_HEADERS,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("ImgBB upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const json = await res.json();
      const url = typeof json?.data?.url === "string" ? json.data.url.trim() : "";
      if (json?.success && url && url.startsWith("http")) {
        logger.info("Album art upload succeeded", { imageKey, provider: "imgbb", url });
        return url;
      }

      logger.warn("ImgBB returned unexpected response", { imageKey, response: JSON.stringify(json) });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("ImgBB upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }
  return null;
}

async function uploadToPixeldrain(buffer, imageKey, maxRetries, timeoutMs, signal = null) {
  if (!IMAGE_UPLOAD_PIXELDRAIN_API_KEY) return null;

  const authHeader = `Basic ${Buffer.from(`:${IMAGE_UPLOAD_PIXELDRAIN_API_KEY}`).toString("base64")}`;
  const endpoint = "https://pixeldrain.com/api/file/cover.jpg";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        body: buffer,
        headers: {
          ...COMMON_UPLOAD_HEADERS,
          authorization: authHeader,
          "content-type": "image/jpeg",
        },
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
        dispatcher: fetchDispatcher,
      });

      if (!res.ok) {
        const responseBody = getResponseSnippet(await res.text());
        logger.warn("Pixeldrain upload failed", { imageKey, status: res.status, statusText: res.statusText, responseBody });
        if (attempt < maxRetries) {
          await sleep(getRetryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const json = await res.json();
      const fileId = typeof json?.id === "string"
        ? json.id.trim()
        : (typeof json?.value?.id === "string" ? json.value.id.trim() : "");

      if (fileId) {
        const url = `https://pixeldrain.com/api/file/${encodeURIComponent(fileId)}`;
        logger.info("Album art upload succeeded", { imageKey, provider: "pixeldrain", url });
        return url;
      }

      logger.warn("Pixeldrain returned unexpected response", { imageKey, response: JSON.stringify(json) });
      return null;
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        return null;
      }
      logger.warn("Pixeldrain upload error", { imageKey, attempt, maxRetries, ...getErrorDetails(err) });
      if (attempt < maxRetries) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  }

  return null;
}

async function uploadToAnyProvider(buffer, imageKey, maxRetries, timeoutMs) {
  const allProviders = [
    { name: "catbox", fn: uploadToCatbox },
    { name: "litterbox", fn: uploadToLitterbox },
    { name: "telegraph", fn: uploadToTelegraph },
    { name: "fileio", fn: uploadToFileIo },
    { name: "imgur", fn: uploadToImgur },
    { name: "imgbb", fn: uploadToImgbb },
    { name: "pixeldrain", fn: uploadToPixeldrain },
    { name: "0x0", fn: uploadTo0x0 },
  ];
  const providers = allProviders.filter((p) => IMAGE_UPLOAD_PROVIDERS.includes(p.name));
  if (providers.length === 0) {
    logger.warn("No upload providers enabled", { imageKey, configuredProviders: IMAGE_UPLOAD_PROVIDERS });
    return null;
  }

  const controllers = new Map();
  for (const provider of providers) {
    controllers.set(provider.name, new AbortController());
  }

  return await new Promise((resolve) => {
    let pending = providers.length;
    let settled = false;

    for (const provider of providers) {
      const controller = controllers.get(provider.name);
      void provider.fn(buffer, imageKey, maxRetries, timeoutMs, controller.signal)
        .then((url) => {
          if (settled) return;
          if (url) {
            settled = true;
            for (const [name, ctrl] of controllers) {
              if (name !== provider.name) {
                ctrl.abort();
              }
            }
            logger.info("Album art provider race won", { imageKey, provider: provider.name });
            resolve(url);
            return;
          }

          pending -= 1;
          if (pending === 0) {
            resolve(null);
          }
        })
        .catch(() => {
          pending -= 1;
          if (!settled && pending === 0) {
            resolve(null);
          }
        });
    }
  });
}

async function uploadUrlToAnyProvider(sourceUrl, imageKey, maxRetries, timeoutMs) {
  const allProviders = [
    { name: "catbox", fn: uploadUrlToCatbox },
  ];
  const providers = allProviders.filter((p) => IMAGE_UPLOAD_PROVIDERS.includes(p.name));
  if (providers.length === 0) {
    return null;
  }

  const controllers = new Map();
  for (const provider of providers) {
    controllers.set(provider.name, new AbortController());
  }

  return await new Promise((resolve) => {
    let pending = providers.length;
    let settled = false;

    for (const provider of providers) {
      const controller = controllers.get(provider.name);
      void provider.fn(sourceUrl, imageKey, maxRetries, timeoutMs, controller.signal)
        .then((url) => {
          if (settled) return;
          if (url) {
            settled = true;
            for (const [name, ctrl] of controllers) {
              if (name !== provider.name) ctrl.abort();
            }
            logger.info("Album art URL provider race won", { imageKey, provider: provider.name });
            resolve(url);
            return;
          }
          pending -= 1;
          if (pending === 0) resolve(null);
        })
        .catch(() => {
          pending -= 1;
          if (!settled && pending === 0) resolve(null);
        });
    }
  });
}

async function fetchImageBufferFromUrl(sourceUrl, imageKey, timeoutMs) {
  const value = String(sourceUrl || "").trim();
  if (!/^https?:\/\//i.test(value)) return null;

  try {
    const res = await fetch(value, {
      headers: {
        accept: "image/*,*/*;q=0.8",
        "user-agent": UPLOAD_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger.warn("Album art source URL fetch failed", {
        imageKey,
        sourceUrl: value,
        status: res.status,
        statusText: res.statusText,
      });
      return null;
    }

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      logger.warn("Album art source URL returned non-image content", {
        imageKey,
        sourceUrl: value,
        contentType,
      });
      return null;
    }

    const buffer = await readResponseBuffer(res, IMAGE_URL_FETCH_MAX_BYTES);
    return buffer?.length ? buffer : null;
  } catch (err) {
    logger.warn("Album art source URL fetch error", { imageKey, sourceUrl: value, ...getErrorDetails(err) });
    return null;
  }
}

async function uploadResolvedImageBuffer(imageKey, buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  const bufferHash = hashImageBuffer(buffer);
  const existingByHash = findCachedUrlByHash(bufferHash);
  if (existingByHash) {
    uploadFailures.delete(imageKey);
    touchCacheEntry(imageKey, { url: existingByHash, updatedAt: Date.now(), hash: bufferHash });
    pruneCache();
    scheduleSave();
    loggedCacheHits.add(imageKey);
    logger.info("Album art hash cache hit", { imageKey, hash: bufferHash, url: existingByHash });
    return existingByHash;
  }

  const url = await uploadToAnyProvider(buffer, imageKey, IMAGE_UPLOAD_MAX_RETRIES, IMAGE_UPLOAD_TIMEOUT_MS);
  if (!url) return null;

  uploadFailures.delete(imageKey);
  touchCacheEntry(imageKey, { url, updatedAt: Date.now(), hash: bufferHash });
  pruneCache();
  scheduleSave();
  return url;
}

async function getOrUpload(imageKey, imageBufferFn, options = {}) {
  if (!imageKey) return null;
  const shouldContinue = typeof options.shouldContinue === "function"
    ? options.shouldContinue
    : () => true;
  const maxBufferAttempts = Math.max(1, Number(options.maxBufferAttempts) || IMAGE_BUFFER_FETCH_RETRIES);
  const ignoredFailureReasons = Array.isArray(options.ignoredFailureReasons)
    ? options.ignoredFailureReasons
    : [];
  const markNoBufferFailure = options.markNoBufferFailure !== false;
  const logNoBuffer = options.logNoBuffer !== false;

  const cached = getCachedUrl(imageKey);
  if (cached) {
    return cached;
  }

  if (shouldSkipForRecentFailure(imageKey, ignoredFailureReasons)) {
    return null;
  }

  const existingUpload = inFlightUploads.get(imageKey);
  if (existingUpload) {
    return existingUpload;
  }

  const uploadPromise = queueUpload(async () => {
    try {
      if (!shouldContinue()) return null;

      const { buffer, skipped } = await resolveImageBufferWithRetries(imageBufferFn, {
        maxAttempts: maxBufferAttempts,
        shouldContinue,
      });
      if (skipped) return null;

      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        if (markNoBufferFailure) {
          markFailure(imageKey, "no-buffer");
        }
        if (logNoBuffer) {
          logger.warn("No usable album art buffer available", { imageKey });
        }
        return null;
      }

      if (!shouldContinue()) return null;

      const url = await uploadResolvedImageBuffer(imageKey, buffer);
      if (url) return url;

      markFailure(imageKey, "upload-failed");
      logger.error("All upload services failed", { imageKey });
      return null;
    } catch (err) {
      markFailure(imageKey, "upload-error");
      logger.error("Album art upload failed", { imageKey, ...getErrorDetails(err) });
      return null;
    }
  });

  inFlightUploads.set(imageKey, uploadPromise);
  try {
    return await uploadPromise;
  } finally {
    if (inFlightUploads.get(imageKey) === uploadPromise) {
      inFlightUploads.delete(imageKey);
    }
  }
}

async function getOrUploadFromUrl(imageKey, sourceUrl, options = {}) {
  if (!imageKey || !sourceUrl) return null;
  const shouldContinue = typeof options.shouldContinue === "function"
    ? options.shouldContinue
    : () => true;

  const cached = getCachedUrl(imageKey);
  if (cached) return cached;

  if (shouldSkipForRecentFailure(imageKey, ["no-buffer"])) {
    return null;
  }

  const existingUpload = inFlightUploads.get(imageKey);
  if (existingUpload) {
    return existingUpload;
  }

  const uploadPromise = queueUpload(async () => {
    try {
      if (!shouldContinue()) return null;

      const buffer = await fetchImageBufferFromUrl(sourceUrl, imageKey, IMAGE_UPLOAD_TIMEOUT_MS);
      if (!shouldContinue()) return null;

      const uploadedBufferUrl = await uploadResolvedImageBuffer(imageKey, buffer);
      if (uploadedBufferUrl) return uploadedBufferUrl;

      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        logger.warn("No usable album art URL buffer available", { imageKey, sourceUrl });
      }

      markFailure(imageKey, "url-upload-failed");
      logger.warn("All album art URL upload services failed", { imageKey });
      return null;
    } catch (err) {
      markFailure(imageKey, "url-upload-error");
      logger.error("Album art URL upload failed", { imageKey, ...getErrorDetails(err) });
      return null;
    }
  });

  inFlightUploads.set(imageKey, uploadPromise);
  try {
    return await uploadPromise;
  } finally {
    if (inFlightUploads.get(imageKey) === uploadPromise) {
      inFlightUploads.delete(imageKey);
    }
  }
}

function getCached(imageKey) {
  return getCachedUrl(imageKey);
}

function resetForTest(entries = []) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveInFlight = false;
  pendingSave = false;
  cache = new Map(entries);
  loggedCacheHits.clear();
  inFlightUploads.clear();
  uploadFailures.clear();
  uploadQueue = Promise.resolve();
}

module.exports = {
  getOrUpload,
  getOrUploadFromUrl,
  getCached,
  __test: {
    resetForTest,
  },
};
