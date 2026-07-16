/** @type {import('next').NextConfig} */
// Static export — `next build` emits plain HTML/JS into `out/`, which the existing Express server
// serves via express.static (single container, same basic-auth, no SSR runtime). The dashboard is a
// client-rendered SPA that fetches the Express `/api/*` endpoints at runtime.
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // Fonts live in the backend's public/fonts (served by Express at /fonts) — no duplication here.
};

export default nextConfig;
