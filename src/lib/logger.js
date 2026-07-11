// Tiny structured logger — one JSON line per event, easy to grep in Dokploy logs.
const ts = () => new Date().toISOString();

function emit(level, msg, extra) {
  const line = { t: ts(), level, msg, ...(extra || {}) };
  const s = JSON.stringify(line);
  if (level === "error") console.error(s);
  else console.log(s);
}

export const log = {
  info: (msg, extra) => emit("info", msg, extra),
  warn: (msg, extra) => emit("warn", msg, extra),
  error: (msg, extra) => emit("error", msg, extra),
};
