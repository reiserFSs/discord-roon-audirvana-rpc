const roon = require("./roon");
const audirvana = require("./audirvana");
const discord = require("./discord");
const imageHost = require("./image-host");
const logger = require("./logger");

let config = null;
let currentZoneId = null;
let zonesById = new Map();
let updateVersion = 0;

async function start(cfg) {
  config = cfg;

  await discord.init(config.discord_application_id);
  const player = (config.player || "roon").toLowerCase();

  if (player === "audirvana") {
    logger.info("Using Audirvana Studio as playback source");
    audirvana.init(config, handleAudirvanaSnapshot);
    return;
  }

  if (player !== "roon") {
    logger.warn("Unknown player configured, falling back to Roon", { player });
  }

  roon.init(config, handleZoneEvent);
}

function stop() {
  audirvana.stop();
}

function handleZoneEvent(event, data) {
  switch (event) {
    case "Subscribed":
    case "Snapshot":
      replaceZones(data?.zones || []);
      processSelectedZone();
      break;

    case "Changed":
      applyZoneDelta(
        [...(data?.zones_added || []), ...(data?.zones_changed || [])],
        data?.zones_seek_changed || [],
        data?.zones_removed || [],
      );
      processSelectedZone();
      break;

    case "Unsubscribed":
    case "Unpaired":
      currentZoneId = null;
      zonesById.clear();
      updateVersion += 1;
      discord.clearActivity();
      break;

    default:
      break;
  }
}

function handleAudirvanaSnapshot(snapshot) {
  if (!snapshot?.running) {
    currentZoneId = null;
    updateVersion += 1;
    discord.clearActivity();
    return;
  }

  processZone(createAudirvanaZone(snapshot, config?.zone_name));
}

function replaceZones(zones) {
  zonesById = new Map();
  for (const zone of zones) {
    if (zone?.zone_id) {
      zonesById.set(zone.zone_id, zone);
    }
  }
}

function applyZoneDelta(changedZones, seekChangedZones, removedZones) {
  for (const zone of changedZones) {
    if (zone?.zone_id) {
      zonesById.set(zone.zone_id, zone);
    }
  }

  for (const seekChange of seekChangedZones) {
    if (!seekChange?.zone_id) continue;
    const existing = zonesById.get(seekChange.zone_id);
    if (!existing) continue;

    const nextZone = { ...existing };
    nextZone.queue_time_remaining = seekChange.queue_time_remaining;

    if (nextZone.now_playing) {
      nextZone.now_playing = {
        ...nextZone.now_playing,
        seek_position: seekChange.seek_position,
      };
    }

    zonesById.set(seekChange.zone_id, nextZone);
  }

  for (const zone of removedZones) {
    const zoneId = typeof zone === "string" ? zone : zone?.zone_id;
    if (zoneId) {
      zonesById.delete(zoneId);
    }
  }
}

function processSelectedZone() {
  const zone = selectZone(Array.from(zonesById.values()), {
    zoneName: config?.zone_name,
    currentZoneId,
  });
  if (zone) {
    logger.debug("Processing selected zone", { zoneId: zone.zone_id, zoneName: zone.display_name, state: zone.state });
    processZone(zone);
    return;
  }

  discord.clearActivity();
}

function selectZone(zones, options = {}) {
  if (!zones || zones.length === 0) return null;

  if (options.zoneName) {
    return zones.find((z) => z.display_name === options.zoneName) || null;
  }

  // If we're already tracking a zone, prefer it
  if (options.currentZoneId) {
    const tracked = zones.find((z) => z.zone_id === options.currentZoneId);
    if (tracked) return tracked;
  }

  // Pick the first playing zone
  const playing = zones.find((z) => z.state === "playing");
  return playing || zones[0];
}

function buildAudirvanaImageKey(snapshot) {
  const rawTrackUrl = typeof snapshot.trackUrl === "string" ? snapshot.trackUrl.trim() : "";
  const normalizedTrackUrl = rawTrackUrl
    ? rawTrackUrl.split("#")[0].split("?")[0]
    : "";
  const artist = String(snapshot.artist || "").trim();
  const albumName = String(snapshot.albumName || "").trim();
  const title = String(snapshot.title || "").trim();

  if (/^https?:\/\//i.test(normalizedTrackUrl)) {
    let host = "";
    try {
      host = new URL(normalizedTrackUrl).host.toLowerCase();
    } catch {
      host = "";
    }

    const albumIdentity = [albumName.toLowerCase(), artist.toLowerCase()]
      .filter(Boolean)
      .join("|");
    if (albumIdentity) {
      return `audirvana-stream-album:${host}:${albumIdentity}`;
    }
  }

  if (normalizedTrackUrl) return normalizedTrackUrl;

  const fallbackTrackIdentity = `${title}|${artist}|${albumName}`;
  return (title || artist || albumName) ? fallbackTrackIdentity : null;
}

function createAudirvanaZone(snapshot, configuredZoneName) {
  return {
    zone_id: "audirvana",
    display_name: configuredZoneName || "Audirvana Studio",
    state: snapshot.state || "stopped",
    seek_position: snapshot.seekPosition ?? 0,
    now_playing: {
      three_line: {
        line1: snapshot.title || "Unknown Title",
        line2: snapshot.artist || "Unknown Artist",
        line3: snapshot.albumName || "Unknown Album",
      },
      seek_position: snapshot.seekPosition ?? 0,
      length: snapshot.length ?? null,
      track_url: snapshot.trackUrl || null,
      image_key: buildAudirvanaImageKey(snapshot),
    },
  };
}

function normalizeSeconds(rawValue, options = {}) {
  const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (!Number.isFinite(value)) return null;

  let seconds = value;
  if (value > 10_000) {
    // Some integrations expose milliseconds.
    seconds = value / 1000;
  } else if (value > 0 && value < 1) {
    // Some Apple Event bridges surface fractional hours.
    seconds = value * 3600;
  }

  if (!Number.isFinite(seconds)) return null;
  if (options.allowZero) return Math.max(0, Math.round(seconds));
  if (seconds <= 0) return null;
  return Math.round(seconds);
}

async function processZone(zone) {
  const version = ++updateVersion;
  currentZoneId = zone.zone_id;

  if (zone.state !== "playing") {
    discord.clearActivity();
    return;
  }

  const nowPlaying = zone.now_playing;
  if (!nowPlaying) {
    discord.clearActivity();
    return;
  }

  const title = nowPlaying.three_line?.line1 || "Unknown Title";
  const artist = nowPlaying.three_line?.line2 || "Unknown Artist";
  const albumName = nowPlaying.three_line?.line3 || "Unknown Album";
  const imageKey = nowPlaying.image_key;
  const trackUrl = nowPlaying.track_url || null;
  const seekPosition = normalizeSeconds(zone.seek_position ?? nowPlaying.seek_position ?? 0, { allowZero: true }) ?? 0;
  const length = normalizeSeconds(nowPlaying.length);
  const player = (config?.player || "roon").toLowerCase();
  const directAlbumArtUrl = (player === "audirvana")
    ? audirvana.getDirectArtworkUrlFromTrackUrl(trackUrl || "")
    : null;

  const baseActivity = {
    title,
    artist,
    albumName,
    imageKey,
    seekPosition,
    length,
    zoneName: zone.display_name,
  };
  const cachedAlbumArtUrl = imageKey ? imageHost.getCached(imageKey) : null;
  const preferredAlbumArtUrl = cachedAlbumArtUrl || null;

  // Update Discord immediately so status is visible even if image upload is slow/fails.
  discord.updateActivity({
    ...baseActivity,
    albumArtUrl: preferredAlbumArtUrl,
  });

  if (player === "audirvana" && imageKey && !cachedAlbumArtUrl) {
    void (async () => {
      let albumArtUrl = null;
      albumArtUrl = await imageHost.getOrUpload(imageKey, () => audirvana.getImage({
        trackUrl: trackUrl || "",
        title,
        artist,
        albumName,
        directAlbumArtUrl: directAlbumArtUrl || "",
      }));
      if (!albumArtUrl && directAlbumArtUrl) {
        albumArtUrl = await imageHost.getOrUploadFromUrl(imageKey, directAlbumArtUrl);
      }
      if (!albumArtUrl) return;

      if (version !== updateVersion) return;

      discord.updateActivity({
        ...baseActivity,
        albumArtUrl,
      });
    })();
  }

  if (player === "roon" && imageKey && !cachedAlbumArtUrl) {
    void (async () => {
      const albumArtUrl = await imageHost.getOrUpload(imageKey, () => roon.getImage(imageKey));
      if (!albumArtUrl) return;

      // Drop stale async completion if a newer zone update has already been processed.
      if (version !== updateVersion) return;

      discord.updateActivity({
        ...baseActivity,
        albumArtUrl,
      });
    })();
  }

  logger.debug("Updated Discord activity", {
    zoneId: zone.zone_id,
    imageKey,
    trackUrl,
    directAlbumArtUrl,
    preferredAlbumArtUrl,
    seekPosition,
    length,
    title,
    artist,
  });
}

module.exports = {
  start,
  stop,
  __test: {
    selectZone,
    buildAudirvanaImageKey,
    createAudirvanaZone,
    normalizeSeconds,
    replaceZones,
    applyZoneDelta,
    getZone: (zoneId) => zonesById.get(zoneId),
  },
};
