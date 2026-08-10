// The SPA is served by the same Express server that hosts /api, so same-origin fetch works and the
// basic-auth cookie/credentials ride along automatically.
export const j = async (u, opt) => (await fetch(u, opt)).json();
export const post = (u, body) =>
  j(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
export const del = (u) => j(u, { method: "DELETE" });
