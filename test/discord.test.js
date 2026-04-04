const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../src/discord");

test("buildTrackKey includes album art URL in identity", () => {
  const a = __test.buildTrackKey({
    title: "Song",
    artist: "Artist",
    albumName: "Album A",
    imageKey: "img1",
    albumArtUrl: null,
  });
  const b = __test.buildTrackKey({
    title: "Song",
    artist: "Artist",
    albumName: "Album B",
    imageKey: "img1",
    albumArtUrl: null,
  });
  const c = __test.buildTrackKey({
    title: "Song",
    artist: "Artist",
    albumName: "Album A",
    imageKey: "img2",
    albumArtUrl: null,
  });
  const d = __test.buildTrackKey({
    title: "Song",
    artist: "Artist",
    albumName: "Album A",
    imageKey: "img1",
    albumArtUrl: "https://example.com/cover.jpg",
  });

  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test("buildActivityPayload sets timestamps from seek and length", () => {
  const nowMs = 1_700_000_000_000;
  const { activity } = __test.buildActivityPayload({
    title: "Song",
    artist: "Artist",
    albumName: "Album",
    imageKey: "img1",
    albumArtUrl: "https://example.com/cover.jpg",
    seekPosition: 30,
    length: 240,
    zoneName: "Office",
  }, nowMs);

  const nowSec = Math.floor(nowMs / 1000);
  assert.equal(activity.startTimestamp, nowSec - 30);
  assert.equal(activity.endTimestamp, nowSec - 30 + 240);
  assert.equal(activity.largeImageKey, "https://example.com/cover.jpg");
  assert.equal(activity.smallImageText, "Zone: Office");
});

test("buildActivityPayload omits timestamps for invalid length", () => {
  const { activity } = __test.buildActivityPayload({
    title: "Song",
    artist: "Artist",
    seekPosition: 10,
    length: 0,
  }, 1_700_000_000_000);

  assert.equal(activity.startTimestamp, undefined);
  assert.equal(activity.endTimestamp, undefined);
});

test("calculateReconnectDelay grows with attempt and stays bounded", () => {
  const d0 = __test.calculateReconnectDelay(0);
  const d4 = __test.calculateReconnectDelay(4);
  const d10 = __test.calculateReconnectDelay(10);

  assert.ok(d0 >= 5000 && d0 < 6000);
  assert.ok(d4 >= 60000 && d4 < 61000);
  assert.ok(d10 >= 60000 && d10 < 61000);
});
