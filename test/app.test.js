const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../src/app");

const zones = [
  { zone_id: "z1", display_name: "Kitchen", state: "stopped" },
  { zone_id: "z2", display_name: "Office", state: "playing" },
  { zone_id: "z3", display_name: "Living Room", state: "paused" },
];

test("selectZone returns named zone when configured", () => {
  const selected = __test.selectZone(zones, { zoneName: "Living Room" });
  assert.equal(selected.zone_id, "z3");
});

test("selectZone prefers currently tracked zone", () => {
  const selected = __test.selectZone(zones, { currentZoneId: "z1" });
  assert.equal(selected.zone_id, "z1");
});

test("selectZone falls back to first playing zone", () => {
  const selected = __test.selectZone(zones, {});
  assert.equal(selected.zone_id, "z2");
});

test("selectZone falls back to first zone when none are playing", () => {
  const selected = __test.selectZone([
    { zone_id: "a", display_name: "A", state: "paused" },
    { zone_id: "b", display_name: "B", state: "stopped" },
  ]);
  assert.equal(selected.zone_id, "a");
});

test("selectZone returns null for empty zone list", () => {
  assert.equal(__test.selectZone([]), null);
});

test("applyZoneDelta merges seek changes without losing now_playing", () => {
  __test.replaceZones([
    {
      zone_id: "seek-zone",
      display_name: "Desk",
      state: "playing",
      queue_time_remaining: 100,
      now_playing: {
        seek_position: 10,
        three_line: { line1: "Song", line2: "Artist", line3: "Album" },
      },
    },
  ]);

  __test.applyZoneDelta([], [{ zone_id: "seek-zone", seek_position: 55, queue_time_remaining: 45 }], []);
  const zone = __test.getZone("seek-zone");

  assert.equal(zone.now_playing.seek_position, 55);
  assert.equal(zone.queue_time_remaining, 45);
  assert.equal(zone.now_playing.three_line.line1, "Song");
});

test("createAudirvanaZone maps snapshot fields", () => {
  const zone = __test.createAudirvanaZone({
    state: "playing",
    title: "Track",
    artist: "Artist",
    albumName: "Album",
    trackUrl: "file:///music/track.flac",
    seekPosition: 42,
    length: 300,
  });

  assert.equal(zone.zone_id, "audirvana");
  assert.equal(zone.state, "playing");
  assert.equal(zone.display_name, "Audirvana Studio");
  assert.equal(zone.now_playing.three_line.line1, "Track");
  assert.equal(zone.now_playing.three_line.line2, "Artist");
  assert.equal(zone.now_playing.three_line.line3, "Album");
  assert.equal(zone.seek_position, 42);
  assert.equal(zone.now_playing.length, 300);
  assert.equal(zone.now_playing.image_key, "file:///music/track.flac");
});

test("createAudirvanaZone prefers configured zone name and fallback values", () => {
  const zone = __test.createAudirvanaZone({ state: "playing" }, "Desk");

  assert.equal(zone.display_name, "Desk");
  assert.equal(zone.now_playing.three_line.line1, "Unknown Title");
  assert.equal(zone.now_playing.three_line.line2, "Unknown Artist");
  assert.equal(zone.now_playing.three_line.line3, "Unknown Album");
  assert.equal(zone.seek_position, 0);
  assert.equal(zone.now_playing.length, null);
  assert.equal(zone.now_playing.image_key, null);
});

test("normalizeSeconds handles raw seconds, milliseconds and fractional hours", () => {
  assert.equal(__test.normalizeSeconds(120), 120);
  assert.equal(__test.normalizeSeconds(121000), 121);
  assert.equal(__test.normalizeSeconds(1 / 60), 60);
  assert.equal(__test.normalizeSeconds(-3), null);
  assert.equal(__test.normalizeSeconds(0, { allowZero: true }), 0);
});

test("createAudirvanaZone strips HTTP query/hash from image identity key", () => {
  const zone = __test.createAudirvanaZone({
    state: "playing",
    title: "Track",
    artist: "Artist",
    albumName: "Album",
    trackUrl: "https://example.com/track.flac?token=abc#frag",
    seekPosition: 42,
    length: 300,
  });

  assert.equal(zone.now_playing.track_url, "https://example.com/track.flac?token=abc#frag");
  assert.equal(zone.now_playing.image_key, "audirvana-stream-album:example.com:album|artist");
});

test("buildAudirvanaImageKey falls back to normalized http track url when album identity is missing", () => {
  const imageKey = __test.buildAudirvanaImageKey({
    trackUrl: "https://example.com/track.flac?token=abc#frag",
    title: "Track",
    artist: "",
    albumName: "",
  });

  assert.equal(imageKey, "https://example.com/track.flac");
});

test("buildAudirvanaImageKey includes artist to avoid album-title collisions", () => {
  const first = __test.buildAudirvanaImageKey({
    trackUrl: "https://lgf.audio.tidal.com/mediatracks/abc/0.flac?token=one",
    artist: "Artist A, Artist B",
    albumName: "Compilation Album",
    title: "Song 1",
  });
  const second = __test.buildAudirvanaImageKey({
    trackUrl: "https://lgf.audio.tidal.com/mediatracks/def/0.flac?token=two",
    artist: "Artist C",
    albumName: "Compilation Album",
    title: "Song 2",
  });

  assert.equal(first, "audirvana-stream-album:lgf.audio.tidal.com:compilation album|artist a, artist b");
  assert.equal(second, "audirvana-stream-album:lgf.audio.tidal.com:compilation album|artist c");
  assert.notEqual(second, first);
});
