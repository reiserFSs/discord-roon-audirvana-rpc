const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel = levels[(process.env.LOG_LEVEL || "info").toLowerCase()] || levels.info;

function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return "";
  return ` ${JSON.stringify(meta)}`;
}

function log(level, message, meta = null) {
  if (levels[level] < currentLevel) return;

  const line = `[${level.toUpperCase()}] ${message}${formatMeta(meta)}`;
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

module.exports = {
  debug: (message, meta) => log("debug", message, meta),
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta),
};
