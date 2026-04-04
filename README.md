# roon-audirvana-discord-rpc

Display your currently playing music from **Roon** or **Audirvana Studio** as Discord Rich Presence.

<img width="433" height="142" alt="image" src="https://github.com/user-attachments/assets/fcecf592-ac04-40d3-b491-5de0732f4808" />

## What It Does

- Connects to Discord RPC and updates your status while music is playing.
- Supports two playback sources:
  - `roon`: via the Roon Extension API.
  - `audirvana`: via macOS JXA/Apple Events polling.
- Shows:
  - Track title and artist
  - Album name (as image hover text)
  - Playback progress (elapsed + remaining time bar in Discord)
  - Zone label (`Zone: <name>`) as small-image text
- Resolves album art and uploads it to public image hosts so Discord can display it.
- For Audirvana only Local Artwork or TIDAL Streaming Artwork is currently supported.
- For ROON all streaming services are supported.

## Requirements

- Node.js `>= 18`
- Discord desktop app running
- For `roon` mode:
  - A reachable Roon Core
  - Extension approval in Roon (`Settings -> Extensions`)
- For `audirvana` mode:
  - macOS (uses `osascript`)
  - Audirvana Studio installed (default expected path: `/Applications/Audirvana Studio.app`)
  - `sqlite3` CLI recommended for better streaming artwork/cache lookups

## Install

```bash
git clone https://github.com/reiserFSs/discordroonaudirvanarpc
npm install
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "discord_application_id": "YOUR_DISCORD_APPLICATION_ID",
  "player": "roon",
  "zone_name": "",
  "audirvana_poll_interval_ms": 2000,
  "pause_clear_after_ms": 0
}
```

## Discord App ID Setup

1. Open https://discord.com/developers/applications
2. Create/select an application.
3. Copy the **Application ID**.
4. Put it into `config.json` as `discord_application_id`.

## Config Options

- `discord_application_id` (string, required): Discord application/client ID.
- `player` (`"roon"` or `"audirvana"`, default: `"roon"`): playback backend.
- `zone_name` (string, optional):
  - Roon: target a specific zone display name.
  - Audirvana: used as displayed zone label in Discord.
- `audirvana_poll_interval_ms` (number, default: `2000`, minimum enforced: `500`): Audirvana poll interval.
- `pause_clear_after_ms` (number): currently unused by runtime logic.

## Run

```bash
npm start
```

Set debug logging if needed:

```bash
LOG_LEVEL=debug npm start
```

Run tests:

```bash
npm test
```

## Album Art + Upload Providers

Album art URLs must be publicly reachable by Discord, so local/embedded art is uploaded and cached in `image-cache.json`.

Default providers:

- `catbox`
- `litterbox`
- `telegraph`
- `fileio`

Additional supported providers:

- `pixeldrain` (requires API key)
- `imgur` (requires client ID)
- `imgbb` (requires API key)
- `0x0`

Provider selection:

```bash
IMAGE_UPLOAD_PROVIDERS=catbox,litterbox,pixeldrain npm start
```

## Environment Variables

### Logging

- `LOG_LEVEL` (`debug|info|warn|error`, default: `info`)

### Audirvana behavior

- `AUDIRVANA_SEEK_BUCKET_SECONDS` (default: `10`)
- `AUDIRVANA_REMOTE_ARTWORK_CANDIDATE_LIMIT` (default: `20`)

### Image cache behavior

- `IMAGE_CACHE_MAX_ITEMS` (default: `1000`)
- `IMAGE_CACHE_TTL_MS` (default: `2592000000` / 30 days)

### Upload/retry behavior

- `IMAGE_UPLOAD_MAX_RETRIES` (default: `3`)
- `IMAGE_UPLOAD_TIMEOUT_MS` (default: `60000`)
- `IMAGE_UPLOAD_RETRY_BASE_MS` (default: `1000`)
- `IMAGE_UPLOAD_FAILURE_COOLDOWN_MS` (default: `300000`)
- `IMAGE_UPLOAD_NO_BUFFER_COOLDOWN_MS` (default: `10000`)
- `IMAGE_BUFFER_FETCH_RETRIES` (default: `3`)
- `IMAGE_BUFFER_FETCH_RETRY_MS` (default: `1500`)
- `IMAGE_UPLOAD_CONNECT_TIMEOUT_MS` (default: `30000`)
- `IMAGE_UPLOAD_USER_AGENT` (default: `curl/8.7.1`)

### Provider credentials

- `IMAGE_UPLOAD_IMGBB_API_KEY`
- `IMAGE_UPLOAD_IMGUR_CLIENT_ID`
- `IMAGE_UPLOAD_PIXELDRAIN_API_KEY`

## Troubleshooting

- `Missing config.json`:
  - Copy `config.example.json` to `config.json` and fill values.
- Discord status not appearing:
  - Ensure Discord desktop app is running and `discord_application_id` is valid.
- Roon mode not updating:
  - Approve the extension in Roon settings.
- Audirvana mode logs `Failed to read Audirvana playback state`:
  - Verify Audirvana Studio is installed and macOS automation permissions are allowed.
- TIDAL/streaming artwork delays:
  - Artwork may appear after cache/DB/webkit metadata becomes available; increase debug logs to inspect source hits/misses.
- Provider warnings (e.g. Telegraph/File.io failures):
  - Normal if another provider wins the upload race.

## Notes
- Album art is uploaded to third-party services you enable; choose providers based on your privacy and retention preferences.
