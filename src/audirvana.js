const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { open, readdir, readFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const logger = require("./logger");

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 500;
const SEEK_BUCKET_SECONDS = Math.max(1, Number(process.env.AUDIRVANA_SEEK_BUCKET_SECONDS || 10));
const APP_NAME = "Audirvana Studio";
const APP_PATH = `/Applications/${APP_NAME}.app`;
const ERROR_LOG_COOLDOWN_MS = 30_000;
const REMOTE_ARTWORK_TIMEOUT_MS = 8_000;
const REMOTE_ARTWORK_MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const REMOTE_IMAGE_FETCH_LOG_LIMIT = 4;
const REMOTE_ARTWORK_CANDIDATE_LIMIT = Math.max(1, Number(process.env.AUDIRVANA_REMOTE_ARTWORK_CANDIDATE_LIMIT || 20));
const LOCAL_TRACK_ARTWORK_SCAN_BYTES = 8 * 1024 * 1024;
const SQLITE_READ_TIMEOUT_MS = 2_500;
const SQLITE_MAX_OUTPUT = 1024 * 1024;
const AUDIRVANA_DB_PATH = path.join(homedir(), "Library", "Application Support", "Audirvana", "AudirvanaDatabase.sqlite");
const WEBKIT_CACHE_DIR = path.join(homedir(), "Library", "Caches", "com.audirvana.Audirvana-Studio");
const WEBKIT_CACHE_DB = path.join(WEBKIT_CACHE_DIR, "Cache.db");
const WEBKIT_CACHE_FS_DIR = path.join(WEBKIT_CACHE_DIR, "fsCachedData");
const WEBKIT_CACHE_ROW_LIMIT = 25;
const LOCAL_ARTWORK_NAMES = [
  "cover.jpg",
  "cover.jpeg",
  "cover.png",
  "folder.jpg",
  "folder.jpeg",
  "folder.png",
  "front.jpg",
  "front.jpeg",
  "front.png",
  "album.jpg",
  "album.jpeg",
  "album.png",
];

function buildJxaScript(appSpecifier) {
  return [
    "function safeCall(fn, fallback) {",
    "  try {",
    "    var value = fn();",
    "    return value === undefined || value === null ? fallback : value;",
    "  } catch (e) {",
    "    return fallback;",
    "  }",
    "}",
    "(function () {",
    "  try {",
    `    var app = Application(${JSON.stringify(appSpecifier)});`,
    "    if (!safeCall(function () { return app.running(); }, false)) {",
    "      return JSON.stringify({ running: false, state: \"\", title: \"\", artist: \"\", albumName: \"\", trackUrl: \"\", length: null, seekPosition: null });",
    "    }",
    "    return JSON.stringify({",
    "      running: true,",
    "      state: String(safeCall(function () { return app.playerState(); }, \"\")),",
    "      title: String(safeCall(function () { return app.playingTrackTitle(); }, \"\")),",
    "      artist: String(safeCall(function () { return app.playingTrackArtist(); }, \"\")),",
    "      albumName: String(safeCall(function () { return app.playingTrackAlbum(); }, \"\")),",
    "      trackUrl: String(safeCall(function () { return app.playingTrackUrl(); }, \"\")),",
    "      length: safeCall(function () { return app.playingTrackDuration(); }, null),",
    "      seekPosition: safeCall(function () { return app.playerPosition(); }, null)",
    "    });",
    "  } catch (e) {",
    "    return JSON.stringify({ running: false, state: \"\", title: \"\", artist: \"\", albumName: \"\", trackUrl: \"\", length: null, seekPosition: null });",
    "  }",
    "})();",
  ].join("\n");
}

function buildJxaArtworkScript(appSpecifier, expectedTrackUrl = "") {
  return [
    "ObjC.import('Foundation');",
    "function safeCall(fn, fallback) {",
    "  try {",
    "    var value = fn();",
    "    return value === undefined || value === null ? fallback : value;",
    "  } catch (e) {",
    "    return fallback;",
    "  }",
    "}",
    "function asText(value) {",
    "  try { return String(value || ''); } catch (e) { return ''; }",
    "}",
    "function readMember(obj, name) {",
    "  try {",
    "    if (!obj) return null;",
    "    var member = obj[name];",
    "    if (typeof member === 'function') return member.call(obj);",
    "    return member;",
    "  } catch (e) {",
    "    return null;",
    "  }",
    "}",
    "function unwrapUrlLike(value) {",
    "  try {",
    "    if (!value) return '';",
    "    if (typeof value.absoluteString === 'function') {",
    "      return asText(ObjC.unwrap(value.absoluteString()));",
    "    }",
    "    return asText(value);",
    "  } catch (e) {",
    "    return asText(value);",
    "  }",
    "}",
    "function firstArtworkUrl(app) {",
    "  var candidateKeys = [",
    "    'playingTrackArtworkUrl',",
    "    'playingTrackArtworkURL',",
    "    'playingTrackAlbumArtUrl',",
    "    'playingTrackAlbumArtURL',",
    "    'playingTrackCoverUrl',",
    "    'playingTrackCoverURL',",
    "    'playingTrackImageUrl',",
    "    'playingTrackImageURL',",
    "    'artworkUrl',",
    "    'artworkURL',",
    "    'coverUrl',",
    "    'coverURL',",
    "    'imageUrl',",
    "    'imageURL'",
    "  ];",
    "  var objects = [",
    "    app,",
    "    readMember(app, 'currentTrack'),",
    "    readMember(app, 'playingTrack'),",
    "    readMember(app, 'currentTrackObject'),",
    "    readMember(app, 'playingTrackObject')",
    "  ];",
    "  for (var oi = 0; oi < objects.length; oi += 1) {",
    "    var obj = objects[oi];",
    "    for (var ki = 0; ki < candidateKeys.length; ki += 1) {",
    "      var raw = readMember(obj, candidateKeys[ki]);",
    "      var text = unwrapUrlLike(raw).trim();",
    "      if (!text) continue;",
    "      if (text.indexOf('http://') === 0 || text.indexOf('https://') === 0 || text.indexOf('file://') === 0 || text.indexOf('data:image/') === 0) {",
    "        return text;",
    "      }",
    "    }",
    "  }",
    "  return '';",
    "}",
    "function normalizeTrackUrl(value) {",
    "  var url = asText(value).trim();",
    "  if (!url) return '';",
    "  var lowered = url.toLowerCase();",
    "  if (lowered.indexOf('http://') === 0 || lowered.indexOf('https://') === 0) {",
    "    var hashIndex = url.indexOf('#');",
    "    if (hashIndex >= 0) url = url.slice(0, hashIndex);",
    "    var queryIndex = url.indexOf('?');",
    "    if (queryIndex >= 0) url = url.slice(0, queryIndex);",
    "  }",
    "  return url;",
    "}",
    "function toNSData(value) {",
    "  try {",
    "    if (!value) return null;",
    "    if (typeof value.base64EncodedStringWithOptions === 'function') return value;",
    "    if (typeof value.TIFFRepresentation === 'function') {",
    "      var tiff = value.TIFFRepresentation();",
    "      if (tiff && typeof tiff.base64EncodedStringWithOptions === 'function') return tiff;",
    "    }",
    "    if (typeof value.dataUsingEncoding === 'function') {",
    "      var encoded = value.dataUsingEncoding($.NSUTF8StringEncoding);",
    "      if (encoded && typeof encoded.base64EncodedStringWithOptions === 'function') return encoded;",
    "    }",
    "    return null;",
    "  } catch (e) {",
    "    return null;",
    "  }",
    "}",
    "function toBase64(dataValue) {",
    "  try {",
    "    var data = toNSData(dataValue);",
    "    if (!data || typeof data.base64EncodedStringWithOptions !== 'function') return '';",
    "    return ObjC.unwrap(data.base64EncodedStringWithOptions(0)) || '';",
    "  } catch (e) {",
    "    return '';",
    "  }",
    "}",
    "(function () {",
    "  try {",
    `    var app = Application(${JSON.stringify(appSpecifier)});`,
    "    if (!safeCall(function () { return app.running(); }, false)) {",
    "      return JSON.stringify({ running: false, trackUrl: '', base64: '' });",
    "    }",
    "    var currentTrackUrl = asText(safeCall(function () { return app.playingTrackUrl(); }, ''));",
    `    var expectedTrackUrl = ${JSON.stringify(expectedTrackUrl || "")};`,
    "    if (expectedTrackUrl && currentTrackUrl && normalizeTrackUrl(expectedTrackUrl) !== normalizeTrackUrl(currentTrackUrl)) {",
    "      return JSON.stringify({ running: true, trackUrl: currentTrackUrl, base64: '' });",
    "    }",
    "    var artData = safeCall(function () { return app.playingTrackAirfoillogo(); }, null);",
    "    var artworkUrl = firstArtworkUrl(app);",
    "    return JSON.stringify({ running: true, trackUrl: currentTrackUrl, artworkUrl: artworkUrl, base64: toBase64(artData) });",
    "  } catch (e) {",
    "    return JSON.stringify({ running: false, trackUrl: '', artworkUrl: '', base64: '' });",
    "  }",
    "})();",
  ].join("\n");
}

let pollTimer = null;
let inFlight = false;
let lastSnapshotKey = null;
let lastErrorLogAt = 0;
let remoteImageFetchLogCount = 0;

function init(config, onSnapshot) {
  stop();
  const intervalMs = resolvePollIntervalMs(config?.audirvana_poll_interval_ms);
  lastErrorLogAt = 0;

  const poll = async () => {
    if (inFlight) return;
    inFlight = true;

    try {
      const snapshot = await readSnapshot();
      const snapshotKey = buildSnapshotKey(snapshot);
      if (snapshotKey === lastSnapshotKey) return;

      lastSnapshotKey = snapshotKey;
      onSnapshot(snapshot);
    } catch (err) {
      const errorMessage = extractErrorMessage(err);
      if (err?.code === "ENOENT") {
        logger.error("Audirvana source requires osascript (macOS), but it is not available.");
        stop();
        return;
      }
      if (isAppNotFoundError(errorMessage)) {
        logger.error("Audirvana Studio.app was not found. Install it in /Applications or update app detection.");
        stop();
        return;
      }

      const now = Date.now();
      if (now - lastErrorLogAt >= ERROR_LOG_COOLDOWN_MS) {
        lastErrorLogAt = now;
        logger.warn("Failed to read Audirvana playback state", { error: errorMessage });
      }
    } finally {
      inFlight = false;
    }
  };

  void poll();
  pollTimer = setInterval(() => {
    void poll();
  }, intervalMs);

  logger.info("Audirvana polling started", { intervalMs });
}

function stop() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  inFlight = false;
  lastSnapshotKey = null;
}

function resolvePollIntervalMs(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(parsed));
}

function normalizeState(rawValue) {
  const state = String(rawValue || "").trim().toLowerCase();
  if (state === "playing" || state === "paused" || state === "stopped") return state;
  return "stopped";
}

function parseNumber(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === "number") return Number.isFinite(rawValue) ? rawValue : null;

  const normalized = String(rawValue).trim();
  if (!normalized) return null;

  const numeric = Number(normalized.replace(",", "."));
  if (Number.isFinite(numeric)) return numeric;

  const parts = normalized.split(":").map((part) => Number(part));
  if (parts.length >= 2 && parts.length <= 3 && parts.every((part) => Number.isFinite(part))) {
    if (parts.length === 2) {
      return (parts[0] * 60) + parts[1];
    }
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }

  return null;
}

function parseSnapshotOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim() || "{}");
  } catch {
    parsed = {};
  }

  return {
    running: Boolean(parsed.running),
    state: normalizeState(parsed.state),
    title: String(parsed.title || "").trim(),
    artist: String(parsed.artist || "").trim(),
    albumName: String(parsed.albumName || "").trim(),
    trackUrl: String(parsed.trackUrl || "").trim(),
    length: parseNumber(parsed.length),
    seekPosition: parseNumber(parsed.seekPosition),
  };
}

function normalizeTrackUrlForIdentity(trackUrl) {
  const value = String(trackUrl || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return value;

  const hashIndex = value.indexOf("#");
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutHash.indexOf("?");
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
}

function getTrackUrlToken(trackUrl) {
  const value = String(trackUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return String(parsed.searchParams.get("token") || "").trim();
  } catch {
    return "";
  }
}

function appendTokenToUrl(url, token) {
  const value = String(url || "").trim();
  const tokenValue = String(token || "").trim();
  if (!value || !tokenValue || !/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (!parsed.searchParams.get("token")) {
      parsed.searchParams.set("token", tokenValue);
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function expandArtworkUrlsWithTrackToken(urls, trackUrl) {
  const token = getTrackUrlToken(trackUrl);
  if (!token) return uniqueStrings(urls || []);
  const expanded = [];
  for (const url of (urls || [])) {
    expanded.push(url);
    expanded.push(appendTokenToUrl(url, token));
  }
  return uniqueStrings(expanded);
}

function rankArtworkUrl(url) {
  const value = String(url || "").toLowerCase();
  let score = 0;
  if (value.includes("resources.tidal.com")) score += 80;
  else if (value.includes("resources.wimpmusic.com")) score += 40;
  if (value.endsWith(".jpg") || value.includes(".jpg?")) score += 20;
  if (value.includes("/320x320.")) score += 18;
  else if (value.includes("/640x640.")) score += 14;
  else if (value.includes("/750x750.")) score += 12;
  else if (value.includes("/1280x1280.")) score += 10;
  else if (value.includes("/160x160.")) score += 8;
  else if (value.includes("/80x80.")) score += 6;
  if (value.includes("token=")) score += 4;
  return score;
}

function limitArtworkUrls(urls, limit = REMOTE_ARTWORK_CANDIDATE_LIMIT) {
  const unique = uniqueStrings(urls || []);
  if (unique.length <= limit) return unique;
  return unique
    .map((url) => ({ url, score: rankArtworkUrl(url) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.url);
}

async function readSnapshot() {
  const appSpecifier = existsSync(APP_PATH) ? APP_PATH : APP_NAME;
  const script = buildJxaScript(appSpecifier);

  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 4_000,
    maxBuffer: 1024 * 1024,
  });
  return parseSnapshotOutput(stdout);
}

function parseArtworkOutput(stdout) {
  return parseArtworkResponse(stdout).buffer;
}

function parseArtworkResponse(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim() || "{}");
  } catch {
    parsed = {};
  }

  let buffer = null;
  const base64 = String(parsed.base64 || "").trim();
  if (base64) {
    try {
      const decoded = Buffer.from(base64, "base64");
      buffer = decoded.length > 0 ? decoded : null;
    } catch {
      buffer = null;
    }
  }

  return {
    trackUrl: String(parsed.trackUrl || "").trim(),
    artworkUrl: String(parsed.artworkUrl || "").trim(),
    buffer,
  };
}

async function getImage(context = "") {
  const imageContext = typeof context === "string"
    ? { trackUrl: context }
    : (context || {});
  const expectedTrackUrl = String(imageContext.trackUrl || "").trim();
  const appSpecifier = existsSync(APP_PATH) ? APP_PATH : APP_NAME;
  const script = buildJxaArtworkScript(appSpecifier, expectedTrackUrl);
  let artworkInfo = {
    trackUrl: expectedTrackUrl,
    buffer: null,
  };
  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 4_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    artworkInfo = parseArtworkResponse(stdout);
  } catch (err) {
    logger.debug("Failed to query Audirvana artwork object", { error: extractErrorMessage(err) });
  }
  const artworkFromAudirvana = artworkInfo.buffer;
  if (artworkFromAudirvana) {
    logger.debug("Audirvana artwork source hit", { source: "audirvana-object" });
    return artworkFromAudirvana;
  }

  const normalizedExpected = normalizeTrackUrlForIdentity(expectedTrackUrl);
  const normalizedCurrent = normalizeTrackUrlForIdentity(artworkInfo.trackUrl);
  if (expectedTrackUrl && artworkInfo.trackUrl && normalizedExpected && normalizedCurrent && normalizedExpected !== normalizedCurrent) {
    logger.debug("Audirvana artwork lookup skipped for stale track", {
      expectedTrackUrl: normalizedExpected,
      currentTrackUrl: normalizedCurrent,
    });
    return null;
  }
  let candidateTrackUrl = artworkInfo.trackUrl || expectedTrackUrl;
  if (expectedTrackUrl && normalizedExpected && normalizedExpected === normalizedCurrent) {
    // Preserve signed query params from expected URL (Audirvana may strip them).
    candidateTrackUrl = expectedTrackUrl;
  }
  logger.debug("Audirvana artwork source miss", {
    source: "audirvana-object",
    expectedTrackUrl: normalizeTrackUrlForIdentity(expectedTrackUrl),
    currentTrackUrl: normalizeTrackUrlForIdentity(artworkInfo.trackUrl),
  });

  const artworkFromAudirvanaUrl = await readArtworkFromUrl(artworkInfo.artworkUrl);
  if (artworkFromAudirvanaUrl) {
    logger.debug("Audirvana artwork source hit", { source: "audirvana-url" });
    return artworkFromAudirvanaUrl;
  }

  if (artworkInfo.artworkUrl) {
    logger.debug("Audirvana artwork source miss", {
      source: "audirvana-url",
      artworkUrl: artworkInfo.artworkUrl,
    });
  }

  const artworkFromLocal = await readLocalArtworkFromTrackUrl(candidateTrackUrl);
  if (artworkFromLocal) {
    logger.debug("Audirvana artwork source hit", { source: "local-file" });
    return artworkFromLocal;
  }

  logger.debug("Audirvana artwork source miss", {
    source: "local-file",
    trackUrl: normalizeTrackUrlForIdentity(candidateTrackUrl),
  });

  const artworkFromWebkitCache = await readWebkitCachedArtworkFromContext({
    ...imageContext,
    trackUrl: candidateTrackUrl,
  });
  if (artworkFromWebkitCache) {
    logger.debug("Audirvana artwork source hit", { source: "webkit-cache" });
    return artworkFromWebkitCache;
  }

  logger.debug("Audirvana artwork source miss", {
    source: "webkit-cache",
    trackUrl: normalizeTrackUrlForIdentity(candidateTrackUrl),
  });

  const artworkFromDbUrl = await readRemoteArtworkFromContext(imageContext, candidateTrackUrl);
  if (artworkFromDbUrl) {
    logger.debug("Audirvana artwork source hit", { source: "audirvana-db-url" });
    return artworkFromDbUrl;
  }

  logger.debug("Audirvana artwork source miss", {
    source: "audirvana-db-url",
    trackUrl: normalizeTrackUrlForIdentity(candidateTrackUrl),
  });

  const artworkFromRemote = await readRemoteArtworkFromTrackUrl(candidateTrackUrl);
  if (artworkFromRemote) {
    logger.debug("Audirvana artwork source hit", { source: "remote-flac-embedded" });
    return artworkFromRemote;
  }

  logger.debug("Audirvana artwork source miss", {
    source: "remote-flac-embedded",
    trackUrl: normalizeTrackUrlForIdentity(candidateTrackUrl),
  });
  return null;
}

function decodeFileTrackPath(trackUrl) {
  if (!trackUrl || typeof trackUrl !== "string" || !trackUrl.toLowerCase().startsWith("file://")) return null;

  const raw = trackUrl.slice("file://".length);
  if (raw) {
    try {
      const decodedRaw = decodeURIComponent(raw);
      if (decodedRaw.startsWith("/")) return decodedRaw;
    } catch {
      // Fall through to URL parsing.
    }
  }

  try {
    const parsed = new URL(trackUrl);
    const pathname = decodeURIComponent(parsed.pathname || "");
    return pathname || null;
  } catch {
    return null;
  }
}

function buildLocalArtworkCandidates(trackPath) {
  const directory = path.dirname(trackPath);
  const basename = path.basename(trackPath, path.extname(trackPath));
  return [
    `${basename}.jpg`,
    `${basename}.jpeg`,
    `${basename}.png`,
    ...LOCAL_ARTWORK_NAMES,
  ].map((name) => path.join(directory, name));
}

async function readFirstExistingFile(candidates) {
  for (const candidate of candidates) {
    try {
      const buffer = await readFile(candidate);
      if (buffer?.length) return buffer;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

async function readFilePrefix(filePath, maxBytes) {
  let fileHandle = null;
  try {
    fileHandle = await open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
    if (!bytesRead) return null;
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
}

async function readEmbeddedArtworkFromLocalTrackPath(trackPath) {
  const ext = path.extname(trackPath).toLowerCase();
  if (ext !== ".flac") return null;

  const prefix = await readFilePrefix(trackPath, LOCAL_TRACK_ARTWORK_SCAN_BYTES);
  if (!prefix) return null;

  const parsed = parseFlacArtworkInfo(prefix);
  return parsed.picture || null;
}

async function readLocalArtworkFromTrackUrl(trackUrl) {
  const trackPath = decodeFileTrackPath(trackUrl);
  if (!trackPath) return null;

  const candidates = buildLocalArtworkCandidates(trackPath);
  const directMatch = await readFirstExistingFile(candidates);
  if (directMatch) return directMatch;

  // Last resort: case-insensitive match against known filenames.
  try {
    const directory = path.dirname(trackPath);
    const entries = await readdir(directory);
    const byLowercase = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
    const resolvedCandidates = LOCAL_ARTWORK_NAMES
      .map((name) => byLowercase.get(name))
      .filter(Boolean)
      .map((name) => path.join(directory, name));

    const resolvedMatch = await readFirstExistingFile(resolvedCandidates);
    if (resolvedMatch) return resolvedMatch;
  } catch {
    // Continue to embedded artwork fallback.
  }

  return readEmbeddedArtworkFromLocalTrackPath(trackPath);
}

async function readResponsePrefix(response, maxBytes) {
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

function parseFlacPictureBlock(block) {
  let offset = 0;
  const readU32 = () => {
    if (offset + 4 > block.length) return null;
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  };

  const pictureType = readU32();
  if (pictureType === null) return null;

  const mimeLength = readU32();
  if (mimeLength === null || offset + mimeLength > block.length) return null;
  offset += mimeLength;

  const descriptionLength = readU32();
  if (descriptionLength === null || offset + descriptionLength > block.length) return null;
  offset += descriptionLength;

  // width, height, depth, colors
  for (let i = 0; i < 4; i += 1) {
    if (readU32() === null) return null;
  }

  const imageLength = readU32();
  if (imageLength === null || imageLength <= 0 || offset + imageLength > block.length) return null;

  return Buffer.from(block.subarray(offset, offset + imageLength));
}

function parseFlacVorbisCommentPicture(block) {
  const parsed = parseFlacVorbisCommentData(block);
  return parsed.picture;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function isLikelyImageBuffer(buffer) {
  if (!buffer || buffer.length < 4) return false;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true; // JPEG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return true; // GIF
  if (
    buffer.length >= 12
    && buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) {
    return true; // WEBP
  }

  return false;
}

function isLikelyUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function extractHttpUrls(value) {
  const matches = String(value || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return uniqueStrings(matches.map((url) => url.trim().replace(/[),.;]+$/, "")));
}

function normalizeTidalCoverId(value) {
  const input = String(value || "").trim().toLowerCase();
  if (!input) return null;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input)) {
    return input;
  }

  if (/^[0-9a-f]{32}$/.test(input)) {
    return `${input.slice(0, 8)}-${input.slice(8, 12)}-${input.slice(12, 16)}-${input.slice(16, 20)}-${input.slice(20, 32)}`;
  }

  return null;
}

function buildTidalCoverUrls(value) {
  const coverId = normalizeTidalCoverId(value);
  if (!coverId) return [];

  const noDash = coverId.replace(/-/g, "");
  const pathPart = coverId.replace(/-/g, "/");
  const hosts = ["resources.tidal.com", "resources.wimpmusic.com"];
  const sizes = ["1280x1280", "750x750", "640x640", "320x320", "160x160", "80x80"];
  const formats = ["jpg", "webp", "png"];
  const variants = [];

  for (const host of hosts) {
    for (const size of sizes) {
      for (const format of formats) {
        variants.push(`https://${host}/images/${pathPart}/${size}.${format}`);
        variants.push(`https://${host}/images/${coverId}/${size}.${format}`);
        variants.push(`https://${host}/images/${noDash}/${size}.${format}`);
      }
    }
  }

  return uniqueStrings(variants);
}

function extractTidalIdsFromText(value) {
  const text = String(value || "");
  const ids = [];
  const pushMatches = (regex) => {
    for (const match of text.matchAll(regex)) {
      if (match?.[0]) ids.push(match[0]);
    }
  };

  pushMatches(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  pushMatches(/[0-9a-f]{32}/gi);

  return uniqueStrings(ids);
}

function decodeBase64UrlText(value) {
  const input = String(value || "").trim();
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input) || input.length < 8) return null;

  try {
    let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4 !== 0) {
      normalized += "=";
    }
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    return decoded || null;
  } catch {
    return null;
  }
}

function extractArtworkUrlsFromTrackUrl(trackUrl) {
  const normalized = String(trackUrl || "").trim();
  if (!normalized) return [];
  if (!/audio\.tidal\.com/i.test(normalized)) return [];

  const ids = [];
  ids.push(...extractTidalIdsFromText(normalized));

  try {
    const decodedUrl = decodeURIComponent(normalized);
    ids.push(...extractTidalIdsFromText(decodedUrl));
  } catch {
    // Ignore decode errors.
  }

  try {
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split("/").filter(Boolean);
    for (const part of parts) {
      const decoded = decodeBase64UrlText(part);
      if (decoded) ids.push(...extractTidalIdsFromText(decoded));
    }
  } catch {
    // Ignore URL parse errors.
  }

  const coverUrls = [];
  for (const id of uniqueStrings(ids)) {
    coverUrls.push(...buildTidalCoverUrls(id));
  }

  return uniqueStrings(coverUrls);
}

function extractTidalCoverIdFromArtworkUrl(url) {
  const value = String(url || "").trim().toLowerCase();
  if (!value) return null;

  const matchSplit = value.match(/\/images\/([0-9a-f]{8})\/([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{12})\//i);
  if (matchSplit) {
    return normalizeTidalCoverId(`${matchSplit[1]}${matchSplit[2]}${matchSplit[3]}${matchSplit[4]}${matchSplit[5]}`);
  }

  const matchUuid = value.match(/\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
  if (matchUuid) {
    return normalizeTidalCoverId(matchUuid[1]);
  }

  const matchHex = value.match(/\/images\/([0-9a-f]{32})\//i);
  if (matchHex) {
    return normalizeTidalCoverId(matchHex[1]);
  }

  return null;
}

function getDirectArtworkUrlFromTrackUrl(trackUrl) {
  const urls = extractArtworkUrlsFromTrackUrl(trackUrl);
  const expanded = expandArtworkUrlsWithTrackToken(urls, trackUrl);
  return expanded[0] || null;
}

function extractArtworkUrlsFromVorbisComment(key, value) {
  const normalizedKey = String(key || "").toUpperCase();
  const rawValue = String(value || "").trim();
  if (!rawValue) return [];

  const urls = [];
  urls.push(...extractHttpUrls(rawValue));
  if (isLikelyUrl(rawValue)) {
    urls.push(rawValue);
  }

  if (normalizedKey.includes("COVER") || normalizedKey.includes("ART")) {
    urls.push(...buildTidalCoverUrls(rawValue));
  }
  // Some streams expose cover IDs in non-obvious keys (album id/resource id/etc).
  for (const id of extractTidalIdsFromText(rawValue)) {
    urls.push(...buildTidalCoverUrls(id));
  }

  return uniqueStrings(urls);
}

function parseFlacVorbisCommentData(block) {
  let offset = 0;
  const readU32LE = () => {
    if (offset + 4 > block.length) return null;
    const value = block.readUInt32LE(offset);
    offset += 4;
    return value;
  };

  const vendorLength = readU32LE();
  if (vendorLength === null || offset + vendorLength > block.length) {
    return { picture: null, artworkUrls: [] };
  }
  offset += vendorLength;

  const commentCount = readU32LE();
  if (commentCount === null) return { picture: null, artworkUrls: [] };

  let picture = null;
  const artworkUrls = [];

  for (let i = 0; i < commentCount; i += 1) {
    const commentLength = readU32LE();
    if (commentLength === null || offset + commentLength > block.length) {
      return { picture, artworkUrls: uniqueStrings(artworkUrls) };
    }

    const comment = block.subarray(offset, offset + commentLength).toString("utf8");
    offset += commentLength;

    const separator = comment.indexOf("=");
    if (separator <= 0) continue;

    const key = comment.slice(0, separator).trim().toUpperCase();
    const value = comment.slice(separator + 1).trim();
    if (!value) continue;

    artworkUrls.push(...extractArtworkUrlsFromVorbisComment(key, value));

    if (key === "METADATA_BLOCK_PICTURE") {
      try {
        const decoded = Buffer.from(value, "base64");
        const parsedPicture = parseFlacPictureBlock(decoded);
        if (parsedPicture && !picture) picture = parsedPicture;
      } catch {
        // Ignore malformed base64 and continue.
      }
    }

    // Legacy convention sometimes stores raw image bytes directly.
    if (key === "COVERART") {
      try {
        const decoded = Buffer.from(value, "base64");
        if (decoded.length > 0 && !picture) picture = decoded;
      } catch {
        // Ignore malformed base64 and continue.
      }
    }
  }

  return { picture, artworkUrls: uniqueStrings(artworkUrls) };
}

function parseEmbeddedFlacArtwork(buffer) {
  const parsed = parseFlacArtworkInfo(buffer);
  return parsed.picture;
}

function parseDataImageUrl(imageUrl) {
  const value = String(imageUrl || "").trim();
  const match = value.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

async function readArtworkFromUrl(imageUrl) {
  const value = String(imageUrl || "").trim();
  if (!value) return null;

  const dataImage = parseDataImageUrl(value);
  if (dataImage) return dataImage;

  if (value.toLowerCase().startsWith("file://")) {
    const localPath = decodeFileTrackPath(value);
    if (!localPath) return null;
    try {
      const fileBuffer = await readFile(localPath);
      return isLikelyImageBuffer(fileBuffer) ? fileBuffer : null;
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(value)) {
    return fetchRemoteImage(value);
  }

  return null;
}

function parseFlacArtworkInfo(buffer) {
  if (!buffer || buffer.length < 8) return { picture: null, artworkUrls: [] };
  const flacMarker = Buffer.from("fLaC");
  const markerIndex = buffer.indexOf(flacMarker);
  if (markerIndex < 0) return { picture: null, artworkUrls: [] };

  let picture = null;
  const artworkUrls = [];

  let offset = markerIndex + 4;
  while (offset + 4 <= buffer.length) {
    const header = buffer[offset];
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockLength = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    offset += 4;

    if (offset + blockLength > buffer.length) {
      return { picture, artworkUrls: uniqueStrings(artworkUrls) };
    }

    if (blockType === 6) {
      const parsedPicture = parseFlacPictureBlock(buffer.subarray(offset, offset + blockLength));
      if (parsedPicture && !picture) picture = parsedPicture;
    }
    if (blockType === 4) {
      const parsedComment = parseFlacVorbisCommentData(buffer.subarray(offset, offset + blockLength));
      if (parsedComment.picture && !picture) picture = parsedComment.picture;
      if (parsedComment.artworkUrls?.length) artworkUrls.push(...parsedComment.artworkUrls);
    }

    offset += blockLength;
    if (isLast) break;
  }

  return { picture, artworkUrls: uniqueStrings(artworkUrls) };
}

async function fetchRemoteImage(url) {
  if (!isLikelyUrl(url)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_ARTWORK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "image/*,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (remoteImageFetchLogCount < REMOTE_IMAGE_FETCH_LOG_LIMIT) {
        remoteImageFetchLogCount += 1;
        logger.debug("Remote artwork candidate rejected by HTTP status", { url, status: response.status });
      }
      return null;
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      if (remoteImageFetchLogCount < REMOTE_IMAGE_FETCH_LOG_LIMIT) {
        remoteImageFetchLogCount += 1;
        logger.debug("Remote artwork candidate rejected by content type", { url, contentType });
      }
      return null;
    }

    const bytes = await readResponsePrefix(response, REMOTE_IMAGE_MAX_BYTES);
    return bytes?.length ? bytes : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readRemoteArtworkFromTrackUrl(trackUrl) {
  if (!trackUrl || !/^https?:\/\//i.test(trackUrl)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_ARTWORK_TIMEOUT_MS);

  try {
    const response = await fetch(trackUrl, {
      headers: {
        range: `bytes=0-${REMOTE_ARTWORK_MAX_BYTES - 1}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;
    const prefix = await readResponsePrefix(response, REMOTE_ARTWORK_MAX_BYTES);
    const parsed = parseFlacArtworkInfo(prefix);
    if (parsed.picture) return parsed.picture;
    logger.debug("Remote FLAC artwork metadata parsed", {
      trackUrl: normalizeTrackUrlForIdentity(trackUrl),
      coverUrlCandidates: parsed.artworkUrls?.length || 0,
    });

    const fallbackTrackUrls = extractArtworkUrlsFromTrackUrl(trackUrl);
    if (fallbackTrackUrls.length > 0) {
      logger.debug("Remote FLAC track-url fallback candidates", {
        trackUrl: normalizeTrackUrlForIdentity(trackUrl),
        coverUrlCandidates: fallbackTrackUrls.length,
      });
    }

    const allArtworkUrls = limitArtworkUrls(expandArtworkUrlsWithTrackToken(
      uniqueStrings([...(parsed.artworkUrls || []), ...fallbackTrackUrls]),
      trackUrl,
    ));
    for (const url of allArtworkUrls) {
      const fetched = await fetchRemoteImage(url);
      if (fetched) return fetched;
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readRemoteArtworkFromContext(context = {}, trackUrl = "") {
  const artworkUrls = [];
  const directArtworkUrl = String(context.directAlbumArtUrl || "").trim();
  if (isLikelyUrl(directArtworkUrl)) {
    artworkUrls.push(directArtworkUrl);
    const directCoverId = extractTidalCoverIdFromArtworkUrl(directArtworkUrl);
    if (directCoverId) {
      artworkUrls.push(...buildTidalCoverUrls(directCoverId));
    }
  }

  const dbCoverInfo = await queryAudirvanaCoverInfoByMetadata(context);
  for (const row of dbCoverInfo) {
    if (isLikelyUrl(row.dataUrl)) {
      artworkUrls.push(row.dataUrl);
      const coverIdFromDataUrl = extractTidalCoverIdFromArtworkUrl(row.dataUrl);
      if (coverIdFromDataUrl) {
        artworkUrls.push(...buildTidalCoverUrls(coverIdFromDataUrl));
      }
    }

    const coverIdFromService = normalizeTidalCoverId(row.serviceImageId);
    if (coverIdFromService) {
      artworkUrls.push(...buildTidalCoverUrls(coverIdFromService));
    }
  }

  const tokenizedArtworkUrls = limitArtworkUrls(expandArtworkUrlsWithTrackToken(uniqueStrings(artworkUrls), trackUrl));
  for (const url of tokenizedArtworkUrls) {
    const fetched = await fetchRemoteImage(url);
    if (fetched) return fetched;
  }

  return null;
}

function getSqliteImmutableUri(filePath) {
  return `file:${encodeURI(filePath)}?immutable=1`;
}

async function queryWebkitCacheReceiverKeysByCoverId(coverId) {
  if (!coverId || !existsSync(WEBKIT_CACHE_DB)) return [];

  const noDash = coverId.replace(/-/g, "");
  const pathPart = coverId.replace(/-/g, "/");
  const variants = uniqueStrings([pathPart, coverId, noDash]);
  if (variants.length === 0) return [];

  const whereClause = variants
    .map((variant) => `r.request_key LIKE '%/images/${variant}/%'`)
    .join(" OR ");
  const sql = [
    "SELECT d.isDataOnFS, d.receiver_data, r.request_key",
    "FROM cfurl_cache_response r",
    "JOIN cfurl_cache_receiver_data d USING(entry_ID)",
    `WHERE (${whereClause})`,
    "ORDER BY r.entry_ID DESC",
    `LIMIT ${WEBKIT_CACHE_ROW_LIMIT};`,
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("sqlite3", [
      "-readonly",
      "-separator",
      "\t",
      getSqliteImmutableUri(WEBKIT_CACHE_DB),
      sql,
    ], {
      timeout: SQLITE_READ_TIMEOUT_MS,
      maxBuffer: SQLITE_MAX_OUTPUT,
    });

    return String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [isDataOnFS, receiverKey, requestKey] = line.split("\t");
        return {
          isDataOnFS: Number(isDataOnFS) === 1,
          receiverKey: String(receiverKey || "").trim(),
          requestKey: String(requestKey || "").trim(),
        };
      })
      .filter((row) => row.receiverKey);
  } catch {
    return [];
  }
}

function extractTidalCoverIdsFromTrackUrl(trackUrl) {
  const urls = extractArtworkUrlsFromTrackUrl(trackUrl);
  const ids = [];

  for (const url of urls) {
    const fromUrl = extractTidalCoverIdFromArtworkUrl(url);
    if (fromUrl) ids.push(fromUrl);
  }

  for (const rawId of extractTidalIdsFromText(trackUrl)) {
    const normalized = normalizeTidalCoverId(rawId);
    if (normalized) ids.push(normalized);
  }

  return uniqueStrings(ids);
}

function escapeSqlLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function escapeSqlLike(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/'/g, "''");
}

async function queryAudirvanaCoverInfoByMetadata(context = {}) {
  if (!existsSync(AUDIRVANA_DB_PATH)) return [];

  const title = String(context.title || "").trim();
  const titleCollated = title.toLowerCase();
  const titleLike = `%${escapeSqlLike(title.toLowerCase())}%`;
  const albumName = String(context.albumName || "").trim();
  const albumCollated = albumName.toLowerCase();
  const albumLike = `%${escapeSqlLike(albumName.toLowerCase())}%`;
  if (!title && !albumName) return [];

  const stages = [];
  if (title && albumName) {
    stages.push({
      name: "exact-title-and-album",
      where: [
        `t.title = '${escapeSqlLiteral(title)}'`,
        `(a.title = '${escapeSqlLiteral(albumName)}' OR a.title_collated = '${escapeSqlLiteral(albumCollated)}')`,
      ],
    });
    stages.push({
      name: "collated-title-and-album",
      where: [
        `t.title_collated = '${escapeSqlLiteral(titleCollated)}'`,
        `(a.title = '${escapeSqlLiteral(albumName)}' OR a.title_collated = '${escapeSqlLiteral(albumCollated)}')`,
      ],
    });
  }
  if (albumName) {
    stages.push({
      name: "album-only",
      where: [
        `(a.title = '${escapeSqlLiteral(albumName)}' OR a.title_collated = '${escapeSqlLiteral(albumCollated)}')`,
      ],
    });
  }
  if (title) {
    stages.push({
      name: "title-only",
      where: [
        `(t.title = '${escapeSqlLiteral(title)}' OR t.title_collated = '${escapeSqlLiteral(titleCollated)}')`,
      ],
    });
  }
  if (title && albumName) {
    stages.push({
      name: "like-title-and-album",
      where: [
        `(lower(t.title) LIKE '${titleLike}' ESCAPE '\\' OR lower(t.title_collated) LIKE '${titleLike}' ESCAPE '\\')`,
        `(lower(a.title) LIKE '${albumLike}' ESCAPE '\\' OR lower(a.title_collated) LIKE '${albumLike}' ESCAPE '\\')`,
      ],
    });
  }
  if (albumName) {
    stages.push({
      name: "like-album-only",
      where: [
        `(lower(a.title) LIKE '${albumLike}' ESCAPE '\\' OR lower(a.title_collated) LIKE '${albumLike}' ESCAPE '\\')`,
      ],
    });
  }
  if (title) {
    stages.push({
      name: "like-title-only",
      where: [
        `(lower(t.title) LIKE '${titleLike}' ESCAPE '\\' OR lower(t.title_collated) LIKE '${titleLike}' ESCAPE '\\')`,
      ],
    });
  }

  const mergedRows = [];
  const seenRows = new Set();
  const stageHits = [];

  for (const stage of stages) {
    const filters = ["t.service_id = 2", "i.isDataUrl = 1", ...stage.where];
    const sql = [
      "SELECT i.service_image_id, CAST(i.data AS TEXT)",
      "FROM TRACKS t",
      "JOIN ALBUMS a ON a.album_id = t.album_id",
      "JOIN IMAGES i ON i.image_id = a.frontcover_image_id",
      `WHERE ${filters.join(" AND ")}`,
      "ORDER BY t.last_played_date DESC",
      `LIMIT ${WEBKIT_CACHE_ROW_LIMIT};`,
    ].join(" ");

    try {
      const { stdout } = await execFileAsync("sqlite3", [
        "-readonly",
        "-separator",
        "\t",
        getSqliteImmutableUri(AUDIRVANA_DB_PATH),
        sql,
      ], {
        timeout: SQLITE_READ_TIMEOUT_MS,
        maxBuffer: SQLITE_MAX_OUTPUT,
      });

      const rows = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [serviceImageId, dataUrl] = line.split("\t");
          return {
            serviceImageId: String(serviceImageId || "").trim(),
            dataUrl: String(dataUrl || "").trim(),
          };
        })
        .filter((row) => row.serviceImageId || row.dataUrl);

      if (rows.length > 0) {
        stageHits.push({ stage: stage.name, rows: rows.length });
        for (const row of rows) {
          const dedupeKey = `${row.serviceImageId}||${row.dataUrl}`;
          if (seenRows.has(dedupeKey)) continue;
          seenRows.add(dedupeKey);
          mergedRows.push(row);
          if (mergedRows.length >= WEBKIT_CACHE_ROW_LIMIT) break;
        }
        if (mergedRows.length >= WEBKIT_CACHE_ROW_LIMIT) break;
      }
    } catch {
      // Continue to next stage.
    }
  }

  if (stageHits.length > 0) {
    logger.debug("Audirvana DB cover query stage hit", { stages: stageHits, mergedRows: mergedRows.length });
  }
  return mergedRows;
}

async function readWebkitCachedArtworkFromContext(context = {}) {
  const trackUrl = String(context.trackUrl || "").trim();
  if (!trackUrl || !/audio\.tidal\.com/i.test(trackUrl)) return null;
  if (!existsSync(WEBKIT_CACHE_FS_DIR)) return null;

  const coverIds = extractTidalCoverIdsFromTrackUrl(trackUrl);
  const dbCoverInfo = await queryAudirvanaCoverInfoByMetadata(context);
  for (const row of dbCoverInfo) {
    const fromServiceId = normalizeTidalCoverId(row.serviceImageId);
    if (fromServiceId) coverIds.push(fromServiceId);
    const fromDataUrl = extractTidalCoverIdFromArtworkUrl(row.dataUrl);
    if (fromDataUrl) coverIds.push(fromDataUrl);
  }
  const normalizedCoverIds = uniqueStrings(coverIds);

  logger.debug("Audirvana DB cover lookup", {
    title: String(context.title || ""),
    albumName: String(context.albumName || ""),
    dbRows: dbCoverInfo.length,
    coverIds: normalizedCoverIds.length,
  });

  if (normalizedCoverIds.length === 0) return null;

  for (const coverId of normalizedCoverIds) {
    const cacheRows = await queryWebkitCacheReceiverKeysByCoverId(coverId);
    for (const row of cacheRows) {
      if (!row.isDataOnFS) continue;
      if (!/^[A-Za-z0-9-]{16,64}$/.test(row.receiverKey)) continue;

      const cacheFilePath = path.join(WEBKIT_CACHE_FS_DIR, row.receiverKey);
      try {
        const fileBuffer = await readFile(cacheFilePath);
        if (isLikelyImageBuffer(fileBuffer)) return fileBuffer;
      } catch {
        // Try next candidate.
      }
    }
  }

  return null;
}

async function readWebkitCachedArtworkFromTrackUrl(trackUrl) {
  const context = { trackUrl: String(trackUrl || "").trim() };
  return readWebkitCachedArtworkFromContext(context);
}

function isAppNotFoundError(message) {
  return /application can't be found/i.test(message);
}

function extractErrorMessage(err) {
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  if (stderr) return stderr;
  return err?.message || "Unknown error";
}

function buildSnapshotKey(snapshot) {
  if (!snapshot?.running) return "stopped";
  const seekBucket = typeof snapshot.seekPosition === "number"
    ? Math.floor(snapshot.seekPosition / SEEK_BUCKET_SECONDS)
    : "na";

  return [
    snapshot.running ? "1" : "0",
    snapshot.state || "",
    snapshot.title || "",
    snapshot.artist || "",
    snapshot.albumName || "",
    normalizeTrackUrlForIdentity(snapshot.trackUrl),
    snapshot.length ?? "",
    seekBucket,
  ].join("|");
}

module.exports = {
  init,
  stop,
  getImage,
  getDirectArtworkUrlFromTrackUrl,
  __test: {
    resolvePollIntervalMs,
    normalizeState,
    parseNumber,
    parseSnapshotOutput,
    normalizeTrackUrlForIdentity,
    parseArtworkOutput,
    parseArtworkResponse,
    decodeFileTrackPath,
    buildLocalArtworkCandidates,
    parseFlacPictureBlock,
    parseFlacVorbisCommentData,
    extractArtworkUrlsFromVorbisComment,
    extractArtworkUrlsFromTrackUrl,
    getTrackUrlToken,
    appendTokenToUrl,
    expandArtworkUrlsWithTrackToken,
    extractTidalCoverIdFromArtworkUrl,
    extractTidalCoverIdsFromTrackUrl,
    getDirectArtworkUrlFromTrackUrl,
    extractTidalIdsFromText,
    decodeBase64UrlText,
    buildTidalCoverUrls,
    parseFlacArtworkInfo,
    parseFlacVorbisCommentPicture,
    parseEmbeddedFlacArtwork,
    parseDataImageUrl,
    escapeSqlLike,
    buildSnapshotKey,
    isAppNotFoundError,
    extractErrorMessage,
    buildJxaScript,
    buildJxaArtworkScript,
  },
};
