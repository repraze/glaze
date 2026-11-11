import type {ThemeState} from "@repraze/kernelkit/theme";

/**
 * The site theme is KernelKit's ThemeProvider (mode, contrast, accent, radius in one JSON object), so the
 * header's ThemeMenu is the same as every suite site's. No `@/` imports: vite.config.ts loads this file
 * for the pre-paint script, and scripts/*.mjs write the same key.
 */
export const THEME_KEY = "glaze-docs-theme";

/** What a visitor who never picked gets, and what Reset restores: glaze orange, max rounding. */
export const SITE_THEME = {accent: "orange", radius: "xl"} as const satisfies Partial<ThemeState>;
