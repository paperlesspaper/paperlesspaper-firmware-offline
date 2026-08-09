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
          const files = fs.readdirSync(dir).filter((f) =>
            exts.includes(f.split(".").pop().toLowerCase())
          ).sort();

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

export default defineConfig({
  root: "src",
  base: "./",
  publicDir: "../public",
  plugins: [colorProfilesPlugin(), ditherTestImagesPlugin(), viteSingleFile()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
