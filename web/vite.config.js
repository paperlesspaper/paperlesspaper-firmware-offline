import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import fs from "fs";
import path from "path";

/**
 * Vite plugin that collects all *.json files from src/profiles/
 * and exposes them as a virtual module `virtual:color-profiles`.
 * This ensures profiles are inlined into the single-file build.
 */
function colorProfilesPlugin() {
  const virtualModuleId = "virtual:color-profiles";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;

  return {
    name: "color-profiles",
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        const profilesDir = path.resolve(__dirname, "src/profiles");
        const profiles = [];

        if (fs.existsSync(profilesDir)) {
          const files = fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            const filePath = path.join(profilesDir, file);
            const content = fs.readFileSync(filePath, "utf-8");
            try {
              const data = JSON.parse(content);
              const name = file.replace(/\.json$/, "");
              profiles.push({ name, data });
            } catch (e) {
              console.warn(`[color-profiles] Could not parse ${file}:`, e.message);
            }
          }
        }

        return `export default ${JSON.stringify(profiles)};`;
      }
    },
  };
}

/**
 * Vite plugin that reads all image files from src/dither-test/ and inlines
 * them as base64 data URLs via the virtual module `virtual:dither-test-images`.
 * Supports jpg, jpeg, png, avif, webp, gif.
 */
function ditherTestImagesPlugin() {
  const virtualModuleId = "virtual:dither-test-images";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;

  const MIME = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    avif: "image/avif",
    webp: "image/webp",
    gif: "image/gif",
  };

  return {
    name: "dither-test-images",
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        const dir = path.resolve(__dirname, "src/dither-test");
        const images = [];

        if (fs.existsSync(dir)) {
          const exts = Object.keys(MIME);
          const files = fs
            .readdirSync(dir)
            .filter((f) => exts.includes(f.split(".").pop().toLowerCase()))
            .sort();

          for (const file of files) {
            const ext = file.split(".").pop().toLowerCase();
            const mime = MIME[ext];
            const data = fs.readFileSync(path.join(dir, file));
            const b64 = data.toString("base64");
            images.push({
              name: file,
              src: `data:${mime};base64,${b64}`,
            });
          }
        }

        return `export default ${JSON.stringify(images)};`;
      }
    },
  };
}

/**
 * Firmware version the web UI expects on the device. The deploy workflow passes the version of
 * the firmware it publishes together with this UI (FW_VERSION); local builds read src/types.h.
 */
function readExpectedFirmwareVersion() {
  const fromEnv = String(process.env.FW_VERSION || "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const typesHeader = fs.readFileSync(path.resolve(__dirname, "../src/types.h"), "utf-8");
    const match = typesHeader.match(/#define\s+SOFTWARE_VERSION\s+"([^"]+)"/);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch (e) {
    console.warn("[fw-version] Could not read SOFTWARE_VERSION from ../src/types.h:", e.message);
  }
  return "0.1.0";
}

/**
 * Release channel of this build. The deploy workflow builds the site twice:
 * "main" (stable) is published at the site root, "dev" (preview) in ./dev/.
 * Anything else is a local build without a channel switch.
 */
function readReleaseChannel() {
  const channel = String(process.env.RELEASE_CHANNEL || "")
    .trim()
    .toLowerCase();
  return channel === "main" || channel === "dev" ? channel : "local";
}

/**
 * Makes the page installable as an app (PWA): writes manifest.webmanifest next to index.html
 * and links it. The manifest depends on the release channel, so the stable and the preview
 * version install as two separate apps. Icons and the service worker are static files in
 * src/public/.
 */
function pwaManifestPlugin() {
  const isDev = readReleaseChannel() === "dev";
  const manifest = {
    name: isDev ? "Paperlesspaper Offline (Dev)" : "Paperlesspaper Offline",
    short_name: isDev ? "Paperless Dev" : "Paperlesspaper",
    description: "E-Paper per Bluetooth einrichten, Bilder aufbereiten und senden, Firmware flashen.",
    lang: "de",
    // relative to the manifest: the folder of this version (site root, or ./dev/)
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // the artwork keeps to the safe zone, so the same files serve as maskable icons
      { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  const source = JSON.stringify(manifest, null, 2);

  return {
    name: "pwa-manifest",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || "").split("?")[0] === "/manifest.webmanifest") {
          res.setHeader("Content-Type", "application/manifest+json");
          res.end(source);
        } else {
          next();
        }
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source });
    },
    transformIndexHtml() {
      return [
        { tag: "link", attrs: { rel: "manifest", href: "./manifest.webmanifest" }, injectTo: "head" },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "./icons/apple-touch-icon.png" }, injectTo: "head" },
      ];
    },
  };
}

export default defineConfig({
  root: "src",
  base: "./",
  define: {
    __EXPECTED_FW_VERSION__: JSON.stringify(readExpectedFirmwareVersion()),
    __RELEASE_CHANNEL__: JSON.stringify(readReleaseChannel()),
    __BUILD_COMMIT__: JSON.stringify(
      String(process.env.BUILD_COMMIT || "")
        .trim()
        .slice(0, 7),
    ),
  },
  plugins: [colorProfilesPlugin(), ditherTestImagesPlugin(), pwaManifestPlugin(), viteSingleFile()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
