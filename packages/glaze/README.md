# @repraze/glaze

GlazeEngine: a WebGPU rendering engine with class-based bindings and a composable render-pass pipeline. A
renderer, a render graph of passes, a deferred PBR scene pass with shadows, lights, materials, geometry and
model loaders.

**WebGPU only.** There is no WebGL fallback: it needs a browser with WebGPU in a secure context (Chrome and
Edge, Safari 26+, recent Firefox). Detect it and show something else where it is missing.

Docs and live demos: https://repraze.github.io/glaze/

```bash
npm install @repraze/glaze
npm install -D @webgpu/types   # the WebGPU globals for TypeScript: add "@webgpu/types" to compilerOptions.types
```

ESM only, typed, side-effect free. [`gl-matrix`](https://glmatrix.net/) is its one dependency (vectors and
matrices); import `vec3` / `mat4` from it to move entities.

---

## A frame

```ts
import {
    BlitPass,
    colorRgb,
    createTorus,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    Renderer,
    RenderGraph,
    Scene,
} from "@repraze/glaze";

const renderer = await Renderer.init(canvas); // throws without WebGPU or without a GPU adapter

const scene = new Scene();
const camera = new PerspectiveCamera({fov: Math.PI / 4});
camera.position[2] = 4;
scene.add(camera);
scene.activeCamera = camera;
scene.add(new DirectionalLight({direction: [-0.5, -1, -0.6], intensity: 3}));
const donut = new Mesh(createTorus(), new PBRMaterial({color: colorRgb("#ff9243"), roughness: 0.3}));
scene.add(donut);

const graph = new RenderGraph();
const {color} = graph.addPass(new DeferredScenePass({scene}));
graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

const stop = renderer.startAnimation(() => {
    donut.setEuler(0, performance.now() / 1000, 0);
    return graph;
});
// later: stop(); renderer.destroy();
```

---

## Architecture

```
Renderer               device, canvas context, frame loop, textures between passes
  └─ RenderGraph       passes in order; named output textures wired into later passes
       ├─ ShaderPass         fullscreen WGSL fragment, textures in and out
       ├─ EffectPass         ShaderPass + typed uniforms and external textures
       ├─ DeferredScenePass  3D: shadows, G-buffer, PBR lighting
       ├─ BlitPass           one texture to the canvas, tone mapped
       └─ SplitViewPass      several textures in viewport rectangles
```

### Renderer

```ts
const renderer = await Renderer.init(canvas, {alphaMode: "premultiplied"}); // alphaMode defaults to "opaque"
renderer.renderFrame(graph); // one frame
const stop = renderer.startAnimation(graph); // or a loop; also accepts () => graph
renderer.resize(width, height); // after the canvas changed size
renderer.destroy();
```

`renderer.device`, `.adapter`, `.context` and `.format` are public for your own resources.

### Passes and the render graph

A `Pass` declares named `inputSlots` and `outputSlots` (`{name, spec: {format, width?, height?, widthDivisor?,
heightDivisor?}}`) and implements `initialize(device, format)`, `resize(width, height)` and `render(ctx)`. The
renderer creates each output texture (canvas-sized unless fixed, or divided), calls `initialize` the first time
it sees the pass, and hands `render` the views of its inputs and outputs.

`graph.addPass(pass, inputs?, {canvasSlot?})` returns one handle per output slot, typed by the pass's slot
names. Wire handles into later passes by input name; the pass marked with `canvasSlot` writes to the swap chain.

### ShaderPass

```ts
const noise = new ShaderPass({
    fragmentShader: /* wgsl */ `
        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
            let v = fract(sin(dot(floor(in.pos.xy), vec2<f32>(12.9898, 78.233))) * 43758.5453);
            return vec4<f32>(v, v, v, 1.0);
        }`,
    outputs: [{name: "noise", spec: {format: "rgba8unorm", widthDivisor: 8, heightDivisor: 8}}],
});
const dots = new ShaderPass({fragmentShader: DOTS_WGSL, inputs: [{name: "input0"}]});

const graph = new RenderGraph();
const {noise: field} = graph.addPass(noise);
graph.addPass(dots, {input0: field}, {canvasSlot: "canvas"});
```

Injected into every fragment shader (don't redeclare them):

| Binding                              | Declaration                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| vertex output                        | `struct QuadInput { @builtin(position) pos, @location(0) uv }`               |
| `@group(0) @binding(0)`              | `globals: {time: f32, resolution: vec2<f32>}`                                |
| `@group(1) @binding(0)`              | `inputSampler: sampler` (with inputs)                                        |
| `@group(1) @binding(N)`, N = 1, 2, … | each input by name: `texture_2d<f32>`, or `texture_depth_2d` (`depth: true`) |

### EffectPass, uniforms and bindings

```ts
const tint = Uniform.vec3([1, 0.57, 0.26]);
const speed = Uniform.f32(1);
const pattern = new TextureUniform("nearest"); // set pattern.texture = gpuTexture once loaded

const pass = new EffectPass({
    fragmentShader: `… effect.tint, effect.speed, textureSample(pattern, pattern_sampler, uv) …`,
    uniforms: {tint, speed},
    textures: {pattern},
});
speed.value = 2; // uploaded on the next frame
```

`Uniform.f32 / i32 / u32 / vec2 / vec3 / vec4` (and `vec2i…vec4u`) lay out a uniform struct with WGSL
alignment. The pass skips drawing until every `TextureUniform` has a texture.

### DeferredScenePass

Shadow maps, then a G-buffer, then one fullscreen lighting pass (Cook-Torrance BRDF, image-based ambient and
reflections from `scene.environmentMap`). Up to 4 directional, 8 point and 4 spot lights; any can cast shadows.

| Output     | Format                        | Contents                            |
| ---------- | ----------------------------- | ----------------------------------- |
| `color`    | `colorFormat` (`rgba16float`) | the lit scene                       |
| `albedo`   | `rgba8unorm`                  | rgb base color, a ambient occlusion |
| `normal`   | `rgba16float`                 | rgb world normal, a roughness       |
| `worldPos` | `rgba16float`                 | rgb world position, a metallic      |
| `emissive` | `rgba16float`                 | rgb emission, a receives shadow     |
| `depth`    | `depth24plus`                 | depth                               |

Set `colorFormat: renderer.format` and `canvasSlot: "color"` to render straight to the canvas.

---

## Scene graph

```
Scene (root, activeCamera, backgroundColor, ambientColor, environmentMap, backgroundMap, environmentColor)
 └─ Entity (position, quaternion, scale, enabled, children)
      ├─ Mesh      geometry + material, castShadow, receiveShadow
      ├─ Camera    PerspectiveCamera {fov, near, far} | OrthographicCamera {left, right, top, bottom, near, far}
      └─ Light     DirectionalLight {direction} | PointLight {range} | SpotLight {direction, innerAngle, outerAngle, range}
```

Entities look down their local −Z with +Y up. `quaternion` is the rotation; `setEuler(x, y, z)` (radians) and
`rotateX / rotateY / rotateZ(rad)` set it from angles, `lookAt(target, up?)` points −Z at a world-space target
(parent rotation included), and `getWorldPosition / getWorldQuaternion / getWorldScale / getWorldDirection()` read
the world transform fresh from the parent chain.

Lights take `{color, intensity, castShadow}`. Children inherit their parent's transform; world matrices are
updated by the scene pass each frame. Cameras must be in the tree.

## Geometry

`Geometry({positions, normals, uvs, indices, tangents?})`, and factories that all take `flat?: boolean` (per-face
normals): `createCube`, `createPlane`, `createQuad`, `createSphere`, `createIcosphere`, `createCylinder`,
`createCone`, `createTorus`. `computeTangents(positions, normals, uvs, indices, vertexCount)` for normal maps.

UVs follow glTF everywhere (shapes, GLB, OBJ, which flips `vt`): (0, 0) is the image's top-left, its first row,
and v runs down. Normal maps are glTF's too: tangent-space +y points to the top of the image.

## Materials and textures

```ts
const gold = new PBRMaterial({color: colorRgb("#f0c040"), roughness: 0.1, metallic: 1, emissive: [0, 0, 0, 0]});
gold.albedoMap = Texture.fromPixels(renderer.device, rgbaBytes, 256, 256); // also normalMap, emissiveMap, heightMap
gold.roughness = 0.3;
gold.markDirty(); // after changing scalars
```

`Texture.fromPixels(device, data, w, h)`, `Texture.fromURL(device, url)`, `Texture.fromBlob(device, blob)`.
Meshes sharing a material share its GPU buffer and bind group. Emission is the rgb of `emissive` (alpha unused).

Occlusion, roughness and metallic follow glTF: `ormMap` is a packed texture (r occlusion, g roughness, b metallic);
`metallicRoughnessMap` (g, b) and `occlusionMap` (r) are separate textures that override its channels. Without an
occlusion source, occlusion is 1. `normalScale` and `occlusionStrength` scale the normal and occlusion maps.

## Loaders

`parseGLB(buffer)` / `loadGLBFromURL(url)` → `{geometry, material}[]`, with
`createPBRMaterialFromGltf(device, material, resolveUri?)` (the mapping itself, GPU-free, is
`planGltfMaterial(material)`). Node transforms of the default scene are baked into the geometry. `parseOBJ(text)` / `loadOBJFromURL(url)`;
`parseSTL(buffer)` (binary or text STL) / `loadSTLFromURL(url)`.

## Color

The renderer applies no gamma: what a pass writes is what the canvas shows, so `colorRgb("#ff6b35")` in a
ShaderPass matches CSS `#ff6b35`. Convert explicitly for linear-light work.

```ts
import {colorRgb, colorRgba, linearToSrgb, setColorRgb, srgbToLinear} from "@repraze/glaze";

colorRgb("#ff6b35"); // [1, 0.42, 0.21]: bytes ÷ 255, no gamma
colorRgba("#ff6b35", 0.5); // [1, 0.42, 0.21, 0.5]
setColorRgb(scene.ambientColor, "#050508"); // in place, for per-frame updates
srgbToLinear(0.5); // ≈ 0.214
```

## Helpers

`lerp`, `clamp`, `smoothstep`, `smootherstep`, `easeIn`, `easeOut`, `easeInOut`, `pingpong`, `oscillate`,
`bounce` for animation.

## Develop

From the repository root: `npm test` (node's test runner through tsx), `npm run typecheck`,
`npm run build -w @repraze/glaze` (emits `dist/`).

## License

MIT
