import {lstatSync} from "node:fs";
import {copyFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath, URL} from "node:url";

import {themeScript} from "@repraze/kernelkit/theme";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {defaultClientConditions, defineConfig, type Plugin} from "vite";

import {docsMeta} from "./plugins/docs-meta.ts";
import {markSvg} from "./src/brand/mark.ts";
import {SITE_THEME, THEME_KEY} from "./src/lib/theme.ts";

/** Inline the pre-paint theme script (KernelKit's, with the site's key and defaults) before first paint. */
function themeScriptPlugin(): Plugin {
    return {
        name: "glaze-theme-script",
        transformIndexHtml: (html) =>
            html.replace(
                "<!-- glaze:theme-script -->",
                `<script>${themeScript({storageKey: THEME_KEY, defaults: SITE_THEME})}</script>`,
            ),
    };
}

/** favicon.svg from the brand mark, so the icon never drifts from the logo. */
function faviconPlugin(): Plugin {
    const svg = markSvg();
    return {
        name: "glaze-favicon",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url?.endsWith("/favicon.svg")) {
                    res.setHeader("Content-Type", "image/svg+xml");
                    res.end(svg);
                    return;
                }
                next();
            });
        },
        generateBundle() {
            this.emitFile({type: "asset", fileName: "favicon.svg", source: svg});
        },
    };
}

/** GitHub Pages has no SPA rewrites: serve the app for unknown paths so deep links work. */
function spaFallback(): Plugin {
    return {
        name: "spa-404-fallback",
        apply: "build",
        async writeBundle({dir}) {
            if (dir) {
                await copyFile(join(dir, "index.html"), join(dir, "404.html"));
            }
        },
    };
}

/**
 * `npm link @repraze/kernelkit` (a symlink to a kernelkit checkout): serve kernelkit from its TypeScript
 * sources (its "@repraze/source" exports condition), unbundled, so edits there hot-reload here.
 * Installed from npm: use its built dist like any dependency, pre-bundled with its CJS deps.
 */
const kernelkitLinked = (() => {
    try {
        return lstatSync(
            fileURLToPath(new URL("../../node_modules/@repraze/kernelkit", import.meta.url)),
        ).isSymbolicLink();
    } catch {
        return false;
    }
})();

/** The engine is always served from its sources (packages/glaze/src), so HMR needs no engine build. */
const glazeSrc = fileURLToPath(new URL("../glaze/src", import.meta.url));

// Fixed port so the suite's doc sites run side by side (termicolor 5170, kernelkit 5175, glaze 5180, nullsec 5199).
export default defineConfig({
    base: process.env.BASE_PATH ?? "/",
    server: {port: 5180, strictPort: true},
    preview: {port: 4180, strictPort: true},
    plugins: [
        docsMeta(fileURLToPath(new URL("./src/docs", import.meta.url))),
        react(),
        tailwindcss(),
        themeScriptPlugin(),
        faviconPlugin(),
        spaFallback(),
    ],
    resolve: {
        alias: [
            {find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url))},
            {find: /^@repraze\/glaze$/, replacement: join(glazeSrc, "index.ts")},
        ],
        conditions: [...(kernelkitLinked ? ["@repraze/source"] : []), ...defaultClientConditions],
        // a linked kernelkit sits outside this tree: force one copy of React-context packages
        dedupe: ["react", "react-dom", "@base-ui/react", "cmdk", "lucide-react"],
    },
    optimizeDeps: kernelkitLinked ? {exclude: ["@repraze/kernelkit"]} : {},
});
