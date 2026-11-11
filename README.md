# GlazeEngine

A WebGPU-only rendering engine: a renderer, a render graph of composable passes, a deferred PBR scene pass
with shadows, lights, materials, geometry and model loaders. Typed classes and WGSL, no WebGL fallback.

Docs and live demos: https://repraze.github.io/glaze/

## Packages

| Package          | What                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `packages/glaze` | the engine (`@repraze/glaze`)                                              |
| `packages/site`  | docs site (Vite + TanStack Router, built on KernelKit), dev on port `5180` |

## Use

```bash
npm install @repraze/glaze
```

```ts
import {BlitPass, DeferredScenePass, Renderer, RenderGraph} from "@repraze/glaze";

const renderer = await Renderer.init(canvas);
const graph = new RenderGraph();
const {color} = graph.addPass(new DeferredScenePass({scene}));
graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
renderer.startAnimation(graph);
```

See [packages/glaze/README.md](packages/glaze/README.md) for the API.

## Develop

```bash
npm install --ignore-scripts
npm run dev          # docs on http://localhost:5180 (the engine is served from its sources)
npm test             # engine unit tests
npm run typecheck && npm run lint && npm run format:check
npm run build        # engine dist/, then the docs site
npm run check:docs   # console errors and scene states on every docs page (dev server running)
npm run check:docs -- --webgpu   # the same with WebGPU (SwiftShader) enabled: every scene must run
npm run check:states # hover / focus visible on every interactive element in the demos
node scripts/shot.mjs /review/<slug> out.png --full   # 6-theme screenshot matrix
```

Headless Chromium has no GPU adapter by default, so the scenes show their fallback there; `--enable-unsafe-webgpu`
gives a SwiftShader adapter that runs them (it can't present them to a screenshot). The scripts look for
Chromium's shared libraries in `~/.cache/pw-libs` like KernelKit's.

The site follows [KernelKit's GUIDELINES.md](https://github.com/repraze/kernelkit/blob/main/GUIDELINES.md):
orange accent, `xl` radius, the suite's header, sidebar, search, footer and landing page. Demo scenes take their
colors from TermiColor through the site's theme (`packages/site/src/glaze/scene-colors.ts`); the engine itself
has no palette dependency. [ALIGNMENT.md](ALIGNMENT.md) lists what this site copies from KernelKit's and how to
move it into the kit.

### Iterating on KernelKit

The site depends on [`@repraze/kernelkit`](https://www.npmjs.com/package/@repraze/kernelkit) from npm. To work
against a local checkout, link it (don't commit the lockfile while linked); the Vite config then serves the kit
from its TypeScript sources (`@repraze/source`) so edits hot-reload:

```bash
(cd ../kernelkit/packages/kernelkit && npm link)
npm link @repraze/kernelkit
npm install --ignore-scripts        # back to the published version
```

## Releasing

Bump `packages/glaze/package.json`, then push a `glaze-v<version>` tag: `.github/workflows/publish.yml` stages
it on npm with provenance through trusted publishing, and a maintainer approves it with 2FA.

## License

MIT
