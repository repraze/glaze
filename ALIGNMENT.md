# Same standard: what the Glaze site shares with KernelKit and TermiColor

The Glaze docs site is built to KernelKit's site standard (GUIDELINES.md §7b/§7c). It used to copy about twenty
pieces of KernelKit's site; those now live in the `@repraze/kernelkit` package and all three sites (KernelKit,
TermiColor, Glaze) import them. A site picks its brand, accent, radius, nav entries and content; nothing else.
Paths: `kk/` = `kernelkit/packages/site/`, `tc/` = `termicolor/packages/site/`, `gl/` = `glaze/packages/site/`.

## 1. Shared from the kit

| Was (Glaze copy)                                                                      | Now                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gl/plugins/docs-meta.ts`, `gl/src/virtual-docs-meta.d.ts`                            | `docsMetaPlugin(dir)` from `@repraze/kernelkit/vite`; types from `"types": ["@repraze/kernelkit/vite/client"]`.                                             |
| `gl/src/lib/doc-kit.tsx` (`Demo`, `PropsTable`, `Code`, `slugify`, `extractFunction`) | `@repraze/kernelkit/docs`. `DocDef<Category>` takes the categories as a type parameter, `source?: {label, href}` is the page badge, `sections` is built in. |
| `extractFunction` (regex: to the next `export`)                                       | Fixed in the kit: docsMetaPlugin parses each docs file with TypeScript and serves `<page>.tsx?demo-sources`, so a demo's Code tab stops at its own brace.   |
| `gl/src/lib/docs-index.ts`                                                            | `createDocsIndex({categories, meta, modules, sources})`: `docs`, `bySlug`, `byCategory`, `loadDoc`, `neighbours`, `slugOf`.                                 |
| `gl/src/pages/doc-page.tsx`                                                           | `DocPage({doc, index, linkFor})`: category + source badge, demos, notes, API, Pager; Toc of demos, `sections`, API (`docToc`).                              |
| `gl/src/pages/docs-layout.tsx`, `gl/src/components/docs-nav.tsx`                      | `DocsLayout({nav, children})`, `DocsNav({index, current, linkFor, onNavigate})`.                                                                            |
| `gl/src/pages/review-page.tsx`                                                        | `ReviewMatrix({doc, scopes})` + `reviewScopes(siteDefault, variants)`.                                                                                      |
| `gl/src/components/site-search.tsx`                                                   | `DocsSearch({index, icons, fallbackIcon, suggested, placeholder, onSelect})`; the substring filter is `substringFilter` in `components/search-dialog`.      |
| `gl/src/components/site-header.tsx` (the 40 shared lines)                             | `SuiteHeader({brand, brandLabel, home, nav, navLabel, search, themeMenu, repository, menu, locationKey})` from `@repraze/kernelkit/site`.                   |
| `gl/src/components/site-footer.tsx`                                                   | `SuiteFooter({links, credits, tagline})`: "MIT · built with KernelKit · themed by TermiColor · a repraze.com project" is built in.                          |
| `gl/src/components/logo.tsx`                                                          | `BrandLogo({svg, first, second})` / `BrandMark({svg})`.                                                                                                     |
| `gl/src/components/github-icon.tsx`                                                   | `GithubIcon` from `@repraze/kernelkit/site`.                                                                                                                |
| `usePageTitle` in `gl/src/lib/site.ts`                                                | `usePageTitle(title, brand)` from `@repraze/kernelkit/site`.                                                                                                |
| `themeScriptPlugin`, `faviconPlugin`, `spaFallback` in `gl/vite.config.ts`            | `@repraze/kernelkit/vite` (index.html uses the kit's `<!-- kernelkit:theme-script -->` marker).                                                             |
| `kernelkitLinked` in `gl/vite.config.ts`                                              | `suiteSourceConditions(["@repraze/kernelkit"])`.                                                                                                            |
| `gl/src/index.css`                                                                    | `@import "@repraze/kernelkit/site.css"` (the kit's styles + Geist and JetBrains Mono).                                                                      |
| `useTheme` in `gl/src/glaze/scene-colors.ts`                                          | `useResolvedTheme()` from the kit's provider: scene colors follow the nearest `ThemeScope`, so the review matrix's scenes match their cell (was §4).        |

The kit also gained `useThemePalette()` (`@repraze/kernelkit/hooks/use-theme-palette`): the resolved TermiColor
mode for canvas, chart and WebGPU code. Glaze keeps its own `sceneColors` mapping (scene roles: floor, key, fill)
on top of the resolved theme rather than switching to it.

## 2. Still local, and why

| Glaze file                                                 | Why it stays                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gl/src/lib/doc-kit.ts`                                    | Content: the categories, `defineDoc` narrowed to them, and the `engineFile` shorthand that becomes the kit's `source` badge (a GitHub link to `packages/glaze/src/<file>`).                                                                                    |
| `gl/src/lib/docs-index.ts`                                 | Six lines: `import.meta.glob` must be written in the site (Vite resolves it at build time, relative to the calling file).                                                                                                                                      |
| `gl/src/components/site-header.tsx`                        | Content: the nav entries (one per docs category), search icons and suggestions, the brand words. All rendering is `SuiteHeader`/`DocsSearch`/`DocsNav`.                                                                                                        |
| `gl/src/router.tsx`                                        | TanStack's typed routes (`useLoaderData({from})`, `Register`) need the route tree in the app; a generic `createDocsRoutes` would lose those types and make the router a kit dependency. It is now 90 lines of wiring, with the footer links in the root route. |
| `gl/src/pages/not-found.tsx`, `gl/src/pages/home.tsx`      | Content (the 404 message, the hero and sections).                                                                                                                                                                                                              |
| `gl/src/brand/mark.ts`, `gl/src/lib/theme.ts`              | The brand mark and the site theme (`glaze-docs-theme`, orange, xl): what makes the site Glaze.                                                                                                                                                                 |
| `gl/src/glaze/*`, `gl/src/components/pipeline-diagram.tsx` | Engine-specific (WebGPU lifecycle, scene colors, demo stage, the flow diagram). The Knob/Control family and a `Flow` component were left out of the kit for now: their APIs are still shaped by Glaze's demos and no second site uses them yet.                |
| `scripts/check-docs.mjs`, `check-states.mjs`, `shot.mjs`   | Kept per repo (see below).                                                                                                                                                                                                                                     |
| `.github/workflows/*.yml`                                  | GitHub has no cross-repo include short of a reusable workflow in a shared repo; KernelKit's and TermiColor's `ci.yml` now match Glaze's `permissions: {}` at the top with `contents: read` per job.                                                            |

**Check scripts stay per repo.** A `kernelkit-docs-check` bin would make `playwright` a dependency of a UI library
and need a plug-in API for Glaze's WebGPU assertions (offscreen contexts, every scene's settled state), which is
most of Glaze's `check-docs.mjs`. KernelKit's and Glaze's `check-states.mjs`/`shot.mjs` differ only in port,
storage key and theme defaults; TermiColor tests with `@playwright/test` instead. Copying three small scripts is
cheaper than versioning a CLI.

## 3. Where Glaze deliberately differs from KernelKit's site

- **Notes come before the demos in each docs file.** No longer needed (the kit's extraction stops at the demo's
  own closing brace), but harmless.
- **No `lint:design`**: it lints the kit's component sources (now also the kit's `docs/` and `site/` modules),
  which this repo doesn't have. Scene colors are hex strings by design (the engine takes CSS hex).
- **No shadcn registry** (`registry` script, `public/r`): nothing to distribute as source.
- **The engine is served from source through an alias**, not the `@repraze/source` condition: the condition
  would also switch the npm-installed kit to its sources. (`suiteSourceConditions` only applies it when the kit
  is symlinked.)
- **The kit's highlighter has no WGSL**: WGSL samples render as plain text with a "wgsl" title. Proposal: add
  `wgsl` to the kit's `lib/highlighter.ts` language map (shiki ships the grammar).

## 4. Open items

- `gl/src/brand/mark.test.ts` imports `vitest`, which this repo doesn't install. Either add vitest (as
  TermiColor does) or port the test to `node:test` like the engine's tests.
- While the kit is linked from a local checkout, `node_modules/@repraze/kernelkit` is a symlink; switch back to
  the npm release once the kit alpha with `/docs`, `/site`, `/vite` and `site.css` is published.
