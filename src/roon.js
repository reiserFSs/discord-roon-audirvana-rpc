const RoonApi = require("@roonlabs/node-roon-api");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiImage = require("node-roon-api-image");
const logger = require("./logger");

let core = null;
let imageApi = null;
let transportApi = null;

function init(config, onZoneEvent) {
  const roon = new RoonApi({
    extension_id: "com.roon-discord-rpc",
    display_name: "Discord Rich Presence",
    display_version: "1.0.0",
    publisher: "roon-discord-rpc",
    email: "",
    log_level: "none",

    core_paired: (pairedCore) => {
      core = pairedCore;
      imageApi = pairedCore.services.RoonApiImage;
      transportApi = pairedCore.services.RoonApiTransport;
      logger.info("Roon core paired", { coreName: pairedCore.display_name });

      transportApi.subscribe_zones((event, data) => {
        onZoneEvent(event, data);
      });

      transportApi.get_zones((err, body) => {
        if (err) {
          logger.warn("Failed to fetch initial zone snapshot", { error: err });
          return;
        }

        onZoneEvent("Snapshot", body || { zones: [] });
        logger.info("Fetched initial zone snapshot", { zoneCount: body?.zones?.length ?? 0 });
      });
    },

    core_unpaired: () => {
      logger.warn("Roon core unpaired");
      core = null;
      imageApi = null;
      transportApi = null;
      onZoneEvent("Unpaired", null);
    },
  });

  roon.init_services({
    required_services: [RoonApiTransport, RoonApiImage],
  });

  roon.start_discovery();
  logger.info("Roon discovery started — authorize this extension in Roon Settings -> Extensions");
}

function getImage(imageKey) {
  return new Promise((resolve, reject) => {
    if (!imageApi) {
      return reject(new Error("Roon image API not available"));
    }

    imageApi.get_image(imageKey, { scale: "fit", width: 512, height: 512, format: "image/jpeg" }, (err, contentType, buffer) => {
      if (err) return reject(new Error(`Roon image error: ${err}`));
      resolve(buffer);
    });
  });
}

module.exports = { init, getImage };
