import {join} from "node:path";
import {fileURLToPath, URL} from "node:url";

import {
    docsMetaPlugin,
    faviconPlugin,
    spaFallback,
    suiteSourceConditions,
    themeScriptPlugin,
} from "@repraze/kernelkit/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

import {markSvg} from "./src/brand/mark.ts";
import {SITE_THEME, THEME_KEY} from "./src/lib/theme.ts";

/** The engine is always served from its sources (packages/glaze/src), so HMR needs no engine build. */
const glazeSrc = fileURLToPath(new URL("../glaze/src", import.meta.url));

// Fixed port so the suite's doc sites run side by side (termicolor 5170, kernelkit 5175, glaze 5180, nullsec 5199).
export default defineConfig({
    base: process.env.BASE_PATH ?? "/",
    server: {port: 5180, strictPort: true},
    preview: {port: 4180, strictPort: true},
    plugins: [
        // `npm link @repraze/kernelkit` (a symlink to a kernelkit checkout): served from its TypeScript sources,
        // so edits there hot-reload here; installed from npm, its built dist like any dependency
        suiteSourceConditions(["@repraze/kernelkit"]),
        docsMetaPlugin(fileURLToPath(new URL("./src/docs", import.meta.url))),
        react(),
        tailwindcss(),
        themeScriptPlugin({storageKey: THEME_KEY, defaults: SITE_THEME}),
        faviconPlugin(markSvg),
        spaFallback(),
    ],
    resolve: {
        alias: [
            {find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url))},
            {find: /^@repraze\/glaze$/, replacement: join(glazeSrc, "index.ts")},
        ],
    },
});
