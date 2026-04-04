const { Client } = require("@xhayper/discord-rpc");
const { ActivityType } = require("discord-api-types/v10");
const logger = require("./logger");

let client = null;
let clientId = null;
let ready = false;
let lastUpdate = 0;
let lastTrack = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let shouldReconnect = true;
const RATE_LIMIT_MS = 15_000;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

async function init(id) {
  clientId = id;
  shouldReconnect = true;
  await connect();
}

function calculateReconnectDelay(attempt) {
  const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** attempt));
  const jitter = Math.floor(Math.random() * 1_000);
  return backoff + jitter;
}

function teardownClient(target = client) {
  if (!target) return;

  target.removeAllListeners();
  target.destroy();

  if (target === client) {
    client = null;
    ready = false;
  }
}

async function connect() {
  teardownClient();
  const nextClient = new Client({ clientId });
  client = nextClient;

  nextClient.on("ready", () => {
    if (client !== nextClient) return;
    ready = true;
    reconnectAttempt = 0;
    logger.info("Discord RPC connected", { user: nextClient.user?.username ?? clientId });
  });

  nextClient.on("disconnected", () => {
    if (client !== nextClient) return;
    ready = false;
    logger.warn("Discord RPC disconnected");
    scheduleReconnect();
  });

  nextClient.on("error", (err) => {
    if (client !== nextClient) return;
    ready = false;
    logger.warn("Discord RPC client error", { error: err.message });
    scheduleReconnect();
  });

  try {
    await nextClient.login();
  } catch (err) {
    logger.error("Discord RPC connection failed", { error: err.message });
    teardownClient(nextClient);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!shouldReconnect) return;
  if (reconnectTimer) return;
  const delay = calculateReconnectDelay(reconnectAttempt);
  reconnectAttempt += 1;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    logger.info("Attempting Discord RPC reconnect");
    await connect();
  }, delay);

  logger.info("Scheduled Discord RPC reconnect", { delayMs: delay, attempt: reconnectAttempt });
}

function pad(value) {
  return value && value.length >= 2 ? value : (value || "").padEnd(2, " ");
}

function buildTrackKey({ title, artist, albumName, imageKey, albumArtUrl }) {
  return `${title || ""}|${artist || ""}|${albumName || ""}|${imageKey || ""}|${albumArtUrl || ""}`;
}

function buildActivityPayload({ title, artist, albumName, albumArtUrl, seekPosition, length, zoneName, imageKey }, nowMs = Date.now()) {
  const activity = {
    type: ActivityType.Listening,
    details: pad(title) || "Unknown Title",
    state: pad(artist) || "Unknown Artist",
  };

  if (albumArtUrl) {
    activity.largeImageKey = albumArtUrl;
    activity.largeImageText = albumName || "Unknown Album";
  }

  if (zoneName) {
    activity.smallImageText = `Zone: ${zoneName}`;
  }

  if (typeof seekPosition === "number" && typeof length === "number" && length > 0) {
    const startTimestamp = Math.floor(nowMs / 1000) - seekPosition;
    const endTimestamp = startTimestamp + length;
    activity.startTimestamp = startTimestamp;
    activity.endTimestamp = endTimestamp;
  }

  return { activity, trackKey: buildTrackKey({ title, artist, albumName, imageKey, albumArtUrl }) };
}

async function updateActivity({ title, artist, albumName, imageKey, albumArtUrl, seekPosition, length, zoneName }) {
  if (!ready) return;

  const now = Date.now();
  const { activity, trackKey } = buildActivityPayload({
    title,
    artist,
    albumName,
    imageKey,
    albumArtUrl,
    seekPosition,
    length,
    zoneName,
  }, now);

  const trackChanged = trackKey !== lastTrack;
  if (!trackChanged && now - lastUpdate < RATE_LIMIT_MS) return;
  lastUpdate = now;
  lastTrack = trackKey;

  try {
    await client.user?.setActivity(activity);
  } catch (err) {
    logger.error("Discord activity update error", { error: err.message });
  }
}

async function clearActivity() {
  if (!ready) return;
  lastUpdate = 0;
  lastTrack = null;
  try {
    await client.user?.clearActivity();
  } catch (err) {
    logger.error("Discord clear activity error", { error: err.message });
  }
}

function destroy() {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  teardownClient();
}

module.exports = {
  init,
  updateActivity,
  clearActivity,
  destroy,
  __test: {
    buildActivityPayload,
    buildTrackKey,
    calculateReconnectDelay,
  },
};
