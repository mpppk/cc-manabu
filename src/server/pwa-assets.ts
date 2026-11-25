import manifest from "../web/manifest.webmanifest" with { type: "file" };
import icon192 from "../web/pwa/icon-192.png" with { type: "file" };
import icon512 from "../web/pwa/icon-512.png" with { type: "file" };

/** コンパイル済みバイナリにもアイコンを埋め込む。 */
export const pwaRoutes = {
  "/manifest.webmanifest": () =>
    new Response(Bun.file(manifest, { type: "application/manifest+json" })),
  "/pwa/icon-192.png": () =>
    new Response(Bun.file(icon192, { type: "image/png" })),
  "/pwa/icon-512.png": () =>
    new Response(Bun.file(icon512, { type: "image/png" })),
};
