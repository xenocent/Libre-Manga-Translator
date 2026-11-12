import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import pkg from "./package.json";

/**
 * Display-only build stamp, carried in `version_name`.
 *
 * Chrome's `version` field accepts dotted numbers only, so it cannot say which
 * commit a build came from - and the same number can be installed twice at once
 * (store build plus unpacked build, or yesterday's unpacked build never
 * reloaded). `version_name` has no format constraint, is capped at 32 chars, and
 * is what both `chrome://extensions` and the in-app footer render when present.
 */
function buildStamp(): string {
  // Fixed argv, no shell: metacharacters in a path or hook cannot reroute it.
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" })
      .trim();
  try {
    // Only tracked modifications count. Untracked files here are scratch
    // (`.work/`, local configs), and letting them mark every build "dirty"
    // makes the stamp useless for telling two builds apart.
    const dirty = git("status", "--porcelain", "--untracked-files=no")
      ? " dirty"
      : "";
    return ` (${git("rev-parse", "--short", "HEAD")}${dirty})`;
  } catch {
    // No git in a published tarball; the plain version still identifies it.
    return "";
  }
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss() as any],
    build: {
      target: "esnext",
      minify: import.meta.env.PROD ? "terser" : "esbuild",
    },
  }),

  manifest: ({ browser }) => ({
    name: "Libre Manga Translator",
    version_name: `${pkg.version}${buildStamp()}`,
    description: "Free Privacy-focused AI manga translator: local WebGPU, Gemini cloud, or self-hosted LLM",
    permissions: [
      "activeTab",
      "offscreen",
      "storage",
      "unlimitedStorage",
      "declarativeNetRequest",
    ],
    host_permissions: ["<all_urls>"],
    web_accessible_resources: [
      {
        resources: [
          "/offscreen.html",
          "/setup.html",
          "/content-scripts/*",
          "/*.wasm",
          "/*.mjs",
          "/dicts/*",
          "/fonts/*",
          "/icon/*",
        ],
        matches: ["<all_urls>"],
      },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "libremangatranslator@lmt.tmp",
          strict_min_version: "148.0",
        },
      },
    }),
  }),

  srcDir: "src",
  modules: ["@wxt-dev/module-svelte"],
  webExt: {
    chromiumArgs: [
      "--enable-unsafe-webgpu",
      "--ozone-platform=x11",
      "--use-angle=vulkan",
      "--enable-features=Vulkan,VulkanFromANGLE",
      "--user-data-dir=./.wxt/chrome-data",
    ],
  },
});
