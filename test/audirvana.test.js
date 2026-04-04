const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../src/audirvana");

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function flacMetadataHeader({ isLast, blockType, length }) {
  const header = Buffer.alloc(4);
  header[0] = (isLast ? 0x80 : 0x00) | (blockType & 0x7f);
  header[1] = (length >> 16) & 0xff;
  header[2] = (length >> 8) & 0xff;
  header[3] = length & 0xff;
  return header;
}

function buildFlacPicturePayload(imageBytes, mime = "image/jpeg") {
  const mimeBuffer = Buffer.from(mime, "utf8");
  const descBuffer = Buffer.alloc(0);
  return Buffer.concat([
    u32(3), // picture type: front cover
    u32(mimeBuffer.length),
    mimeBuffer,
    u32(descBuffer.length),
    descBuffer,
    u32(512), // width
    u32(512), // height
    u32(24), // depth
    u32(0), // colors
    u32(imageBytes.length),
    imageBytes,
  ]);
}

function u32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function buildVorbisCommentBlock(comments = []) {
  const vendor = Buffer.from("roon-discord-rpc", "utf8");
  const parts = [
    u32le(vendor.length),
    vendor,
    u32le(comments.length),
  ];

  for (const comment of comments) {
    const encoded = Buffer.from(comment, "utf8");
    parts.push(u32le(encoded.length), encoded);
  }

  return Buffer.concat(parts);
}

test("resolvePollIntervalMs uses defaults and enforces minimum", () => {
  assert.equal(__test.resolvePollIntervalMs(undefined), 2000);
  assert.equal(__test.resolvePollIntervalMs(""), 2000);
  assert.equal(__test.resolvePollIntervalMs(100), 500);
  assert.equal(__test.resolvePollIntervalMs(750), 750);
});

test("normalizeState maps unsupported values to stopped", () => {
  assert.equal(__test.normalizeState("playing"), "playing");
  assert.equal(__test.normalizeState("paused"), "paused");
  assert.equal(__test.normalizeState("stopped"), "stopped");
  assert.equal(__test.normalizeState("buffering"), "stopped");
});

test("parseSnapshotOutput parses Audirvana JSON payload", () => {
  const parsed = __test.parseSnapshotOutput(JSON.stringify({
    running: true,
    state: "Playing",
    title: "Song Name",
    artist: "Artist Name",
    albumName: "Album Name",
    trackUrl: "file:///music/song.flac",
    length: 242.5,
    seekPosition: 33,
  }));

  assert.equal(parsed.running, true);
  assert.equal(parsed.state, "playing");
  assert.equal(parsed.title, "Song Name");
  assert.equal(parsed.artist, "Artist Name");
  assert.equal(parsed.albumName, "Album Name");
  assert.equal(parsed.trackUrl, "file:///music/song.flac");
  assert.equal(parsed.length, 242.5);
  assert.equal(parsed.seekPosition, 33);
});

test("parseSnapshotOutput handles invalid JSON", () => {
  const parsed = __test.parseSnapshotOutput("not-json");

  assert.equal(parsed.running, false);
  assert.equal(parsed.state, "stopped");
  assert.equal(parsed.title, "");
  assert.equal(parsed.artist, "");
  assert.equal(parsed.albumName, "");
  assert.equal(parsed.trackUrl, "");
  assert.equal(parsed.length, null);
  assert.equal(parsed.seekPosition, null);
});

test("parseSnapshotOutput parses time-like strings", () => {
  const parsed = __test.parseSnapshotOutput(JSON.stringify({
    running: true,
    state: "playing",
    length: "03:30",
    seekPosition: "01:05",
  }));

  assert.equal(parsed.length, 210);
  assert.equal(parsed.seekPosition, 65);
});

test("parseNumber supports decimals and hh:mm:ss-like values", () => {
  assert.equal(__test.parseNumber("12.5"), 12.5);
  assert.equal(__test.parseNumber("12,5"), 12.5);
  assert.equal(__test.parseNumber("1:02"), 62);
  assert.equal(__test.parseNumber("1:01:02"), 3662);
  assert.equal(__test.parseNumber(""), null);
});

test("parseArtworkOutput decodes base64 image payload", () => {
  const input = JSON.stringify({ base64: Buffer.from("hello").toString("base64") });
  const buffer = __test.parseArtworkOutput(input);
  assert.equal(buffer.toString("utf8"), "hello");
  assert.equal(__test.parseArtworkOutput(JSON.stringify({ base64: "" })), null);
});

test("parseArtworkResponse returns current track url metadata", () => {
  const parsed = __test.parseArtworkResponse(JSON.stringify({
    trackUrl: "https://example.com/track.flac?token=abc",
    artworkUrl: "https://example.com/cover.jpg",
    base64: Buffer.from("img").toString("base64"),
  }));
  assert.equal(parsed.trackUrl, "https://example.com/track.flac?token=abc");
  assert.equal(parsed.artworkUrl, "https://example.com/cover.jpg");
  assert.equal(parsed.buffer.toString("utf8"), "img");
});

test("parseDataImageUrl decodes inline base64 image data url", () => {
  const dataUrl = "data:image/jpeg;base64,aGVsbG8=";
  const parsed = __test.parseDataImageUrl(dataUrl);
  assert.equal(parsed.toString("utf8"), "hello");
});

test("normalizeTrackUrlForIdentity strips HTTP query/hash", () => {
  assert.equal(
    __test.normalizeTrackUrlForIdentity("https://example.com/track.flac?token=abc#frag"),
    "https://example.com/track.flac",
  );
  assert.equal(
    __test.normalizeTrackUrlForIdentity("file:///Volumes/Music/track.flac"),
    "file:///Volumes/Music/track.flac",
  );
});

test("buildTidalCoverUrls supports uuid and 32-hex ids", () => {
  const fromUuid = __test.buildTidalCoverUrls("e6f40f4e-fca8-4f6f-bbff-cbf6a1f52f45");
  const fromHex = __test.buildTidalCoverUrls("e6f40f4efca84f6fbbffcbf6a1f52f45");

  assert.equal(fromUuid.length > 0, true);
  assert.equal(fromHex.length > 0, true);
  assert.equal(fromUuid[0], "https://resources.tidal.com/images/e6f40f4e/fca8/4f6f/bbff/cbf6a1f52f45/1280x1280.jpg");
  assert.equal(fromHex[0], fromUuid[0]);
});

test("extractTidalIdsFromText finds uuid and hex ids", () => {
  const ids = __test.extractTidalIdsFromText(
    "foo e6f40f4efca84f6fbbffcbf6a1f52f45 bar e6f40f4e-fca8-4f6f-bbff-cbf6a1f52f45",
  );
  assert.equal(ids.includes("e6f40f4efca84f6fbbffcbf6a1f52f45"), true);
  assert.equal(ids.includes("e6f40f4e-fca8-4f6f-bbff-cbf6a1f52f45"), true);
});

test("decodeBase64UrlText decodes URL-safe base64 payload", () => {
  const payload = Buffer.from("$b5302224dd7fcc27652de1474cc6b156.mp4", "utf8").toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const decoded = __test.decodeBase64UrlText(payload);
  assert.equal(decoded, "$b5302224dd7fcc27652de1474cc6b156.mp4");
});

test("buildJxaArtworkScript emits artworkUrl in response payload", () => {
  const script = __test.buildJxaArtworkScript("Audirvana Studio", "");
  assert.equal(script.includes("artworkUrl"), true);
});

test("extractArtworkUrlsFromTrackUrl builds tidal resource candidates", () => {
  const trackUrl = "https://lgf.audio.tidal.com/mediatracks/CAEaKAgDEiRiNTMwMjIyNGRkN2ZjYzI3NjUyZGUxNDc0Y2M2YjE1Ni5tcDQ/0.flac";
  const urls = __test.extractArtworkUrlsFromTrackUrl(trackUrl);
  assert.equal(urls.length > 0, true);
  assert.equal(
    urls.includes("https://resources.tidal.com/images/b5302224/dd7f/cc27/652d/e1474cc6b156/1280x1280.jpg"),
    true,
  );
});

test("getTrackUrlToken extracts token query parameter", () => {
  const token = __test.getTrackUrlToken("https://lgf.audio.tidal.com/mediatracks/foo/0.flac?token=abc123");
  assert.equal(token, "abc123");
  assert.equal(__test.getTrackUrlToken("https://example.com/no-token"), "");
});

test("appendTokenToUrl appends token once", () => {
  assert.equal(
    __test.appendTokenToUrl("https://resources.tidal.com/images/a/b/c/d/e/1280x1280.jpg", "abc123"),
    "https://resources.tidal.com/images/a/b/c/d/e/1280x1280.jpg?token=abc123",
  );
  assert.equal(
    __test.appendTokenToUrl("https://resources.tidal.com/images/a/b/c/d/e/1280x1280.jpg?token=abc123", "ignored"),
    "https://resources.tidal.com/images/a/b/c/d/e/1280x1280.jpg?token=abc123",
  );
});

test("expandArtworkUrlsWithTrackToken includes tokenized variants", () => {
  const urls = __test.expandArtworkUrlsWithTrackToken(
    ["https://resources.tidal.com/images/a/b/c/d/e/1280x1280.jpg"],
    "https://lgf.audio.tidal.com/mediatracks/foo/0.flac?token=abc123",
  );
  assert.equal(urls.includes("https://resources.tidal.com/images/a/b/c/d/e/1280x1280.jpg"), true);
  assert.equal(urls.includes("https://resources.tidal.com/images/a/b/c/d/e/1280x1280.jpg?token=abc123"), true);
});

test("extractTidalCoverIdFromArtworkUrl parses split, uuid and hex variants", () => {
  assert.equal(
    __test.extractTidalCoverIdFromArtworkUrl("https://resources.tidal.com/images/b5302224/dd7f/cc27/652d/e1474cc6b156/320x320.jpg"),
    "b5302224-dd7f-cc27-652d-e1474cc6b156",
  );
  assert.equal(
    __test.extractTidalCoverIdFromArtworkUrl("https://resources.tidal.com/images/b5302224-dd7f-cc27-652d-e1474cc6b156/320x320.jpg"),
    "b5302224-dd7f-cc27-652d-e1474cc6b156",
  );
  assert.equal(
    __test.extractTidalCoverIdFromArtworkUrl("https://resources.tidal.com/images/b5302224dd7fcc27652de1474cc6b156/320x320.jpg"),
    "b5302224-dd7f-cc27-652d-e1474cc6b156",
  );
});

test("extractTidalCoverIdsFromTrackUrl includes normalized ids", () => {
  const trackUrl = "https://lgf.audio.tidal.com/mediatracks/CAEaKAgDEiRiNTMwMjIyNGRkN2ZjYzI3NjUyZGUxNDc0Y2M2YjE1Ni5tcDQ/0.flac";
  const ids = __test.extractTidalCoverIdsFromTrackUrl(trackUrl);
  assert.equal(ids.includes("b5302224-dd7f-cc27-652d-e1474cc6b156"), true);
});

test("getDirectArtworkUrlFromTrackUrl returns first tidal candidate", () => {
  const trackUrl = "https://lgf.audio.tidal.com/mediatracks/CAEaKAgDEiRiNTMwMjIyNGRkN2ZjYzI3NjUyZGUxNDc0Y2M2YjE1Ni5tcDQ/0.flac";
  const url = __test.getDirectArtworkUrlFromTrackUrl(trackUrl);
  assert.equal(
    url,
    "https://resources.tidal.com/images/b5302224/dd7f/cc27/652d/e1474cc6b156/1280x1280.jpg",
  );
});

test("extractArtworkUrlsFromVorbisComment picks http urls and tidal cover ids", () => {
  const urls = __test.extractArtworkUrlsFromVorbisComment(
    "COVER_ID",
    "e6f40f4e-fca8-4f6f-bbff-cbf6a1f52f45",
  );
  assert.equal(urls.includes("https://resources.tidal.com/images/e6f40f4e/fca8/4f6f/bbff/cbf6a1f52f45/1280x1280.jpg"), true);

  const fromHttp = __test.extractArtworkUrlsFromVorbisComment(
    "ALBUM_ART_URL",
    "https://example.com/cover.jpg",
  );
  assert.equal(fromHttp.includes("https://example.com/cover.jpg"), true);
});

test("decodeFileTrackPath decodes Audirvana file URLs", () => {
  assert.equal(
    __test.decodeFileTrackPath("file://%2FVolumes%2FMedia%2FTrack.flac"),
    "/Volumes/Media/Track.flac",
  );
  assert.equal(
    __test.decodeFileTrackPath("file:///Volumes/Media/Track.flac"),
    "/Volumes/Media/Track.flac",
  );
  assert.equal(__test.decodeFileTrackPath("https://example.com/a.flac"), null);
});

test("buildLocalArtworkCandidates prioritizes track-matching filenames", () => {
  const candidates = __test.buildLocalArtworkCandidates("/Volumes/Media/Album/02 - Song.flac");
  assert.equal(candidates[0], "/Volumes/Media/Album/02 - Song.jpg");
  assert.equal(candidates[1], "/Volumes/Media/Album/02 - Song.jpeg");
  assert.equal(candidates[2], "/Volumes/Media/Album/02 - Song.png");
});

test("parseEmbeddedFlacArtwork extracts embedded picture data", () => {
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
  const pictureBlock = buildFlacPicturePayload(imageBytes);
  const flacPayload = Buffer.concat([
    Buffer.from("fLaC"),
    flacMetadataHeader({ isLast: true, blockType: 6, length: pictureBlock.length }),
    pictureBlock,
  ]);

  const parsed = __test.parseEmbeddedFlacArtwork(flacPayload);
  assert.deepEqual(parsed, imageBytes);
});

test("parseEmbeddedFlacArtwork returns null for non-FLAC data", () => {
  const parsed = __test.parseEmbeddedFlacArtwork(Buffer.from("not-a-flac"));
  assert.equal(parsed, null);
});

test("parseFlacVorbisCommentPicture extracts METADATA_BLOCK_PICTURE", () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const picturePayload = buildFlacPicturePayload(imageBytes);
  const commentBlock = buildVorbisCommentBlock([
    `METADATA_BLOCK_PICTURE=${picturePayload.toString("base64")}`,
  ]);

  const parsed = __test.parseFlacVorbisCommentPicture(commentBlock);
  assert.deepEqual(parsed, imageBytes);
});

test("parseFlacVorbisCommentData extracts artwork urls from comments", () => {
  const commentBlock = buildVorbisCommentBlock([
    "ALBUM_ART_URL=https://example.com/cover.jpg",
  ]);

  const parsed = __test.parseFlacVorbisCommentData(commentBlock);
  assert.equal(parsed.picture, null);
  assert.equal(parsed.artworkUrls.includes("https://example.com/cover.jpg"), true);
});

test("parseEmbeddedFlacArtwork finds picture in Vorbis comment block", () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
  const picturePayload = buildFlacPicturePayload(imageBytes);
  const commentBlock = buildVorbisCommentBlock([
    `METADATA_BLOCK_PICTURE=${picturePayload.toString("base64")}`,
  ]);

  const flacPayload = Buffer.concat([
    Buffer.from("fLaC"),
    flacMetadataHeader({ isLast: true, blockType: 4, length: commentBlock.length }),
    commentBlock,
  ]);

  const parsed = __test.parseEmbeddedFlacArtwork(flacPayload);
  assert.deepEqual(parsed, imageBytes);
});

test("buildSnapshotKey buckets seek position while playing", () => {
  const first = __test.buildSnapshotKey({
    running: true,
    state: "playing",
    title: "Song",
    artist: "Artist",
    albumName: "Album",
    length: 200,
    seekPosition: 39,
  });
  const second = __test.buildSnapshotKey({
    running: true,
    state: "playing",
    title: "Song",
    artist: "Artist",
    albumName: "Album",
    length: 200,
    seekPosition: 30,
  });
  const third = __test.buildSnapshotKey({
    running: true,
    state: "playing",
    title: "Song",
    artist: "Artist",
    albumName: "Album",
    length: 200,
    seekPosition: 41,
  });

  assert.equal(first, second);
  assert.notEqual(second, third);
});
