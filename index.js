// Force ws library for Roon API — Node 22+ has a native WebSocket that lacks
// the .on()/.ping()/.pong() methods the Roon transport layer requires.
global.WebSocket = require("ws");
const dns = require("node:dns");

// Some upload providers intermittently fail over IPv6 in home networks.
// Make address selection deterministic even when not started via npm scripts.
dns.setDefaultResultOrder("ipv4first");

const app = require("./src/app");
const logger = require("./src/logger");

let config;
try {
  config = require("./config.json");
} catch {
  logger.error("Missing config.json — copy config.example.json to config.json and fill in your credentials.");
  process.exit(1);
}

if (!config.discord_application_id || config.discord_application_id === "YOUR_DISCORD_APPLICATION_ID") {
  logger.error("Set discord_application_id in config.json (from https://discord.com/developers/applications)");
  process.exit(1);
}

const discord = require("./src/discord");

async function shutdown() {
  logger.info("Shutting down...");
  app.stop();
  await discord.clearActivity();
  discord.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logger.info("Starting Discord Rich Presence bridge...");
app.start(config).catch((err) => {
  logger.error("Fatal error", { error: err.message });
  process.exit(1);
});
