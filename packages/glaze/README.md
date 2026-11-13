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
renderer.renderFrame(graph); // one frame; renderFrame(graph, seconds) drives globals.time yourself
const stop = renderer.startAnimation(graph); // or a loop; also accepts ({time, delta}) => graph
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
      └─ Light     DirectionalLight | PointLight {range} | SpotLight {innerAngle, outerAngle, range}
```

Entities look down their local −Z with +Y up. `quaternion` is the rotation; `setEuler(x, y, z)` (radians) and
`rotateX / rotateY / rotateZ(rad)` set it from angles, `lookAt(target, up?)` points −Z at a world-space target
and `lookAlong(direction, up?)` along a world direction (parent rotation included), and `getWorldPosition / getWorldQuaternion / getWorldScale / getWorldDirection()` read
the world transform fresh from the parent chain.

Lights take `{color, intensity, castShadow}`. Directional and spot lights shine along their −Z: the `direction`
option sets the initial aim, `lookAt` re-aims them, and a parent's rotation turns them. Children inherit their parent's transform; world matrices are
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

## Picking

`raycast(sceneOrEntity, ray, {layers?, filter?, maxDistance?})` returns **every** hit, nearest first:
`{entity, distance, point, normal, faceIndex, uv}`. Take `hits[0]`, or the first one behind something with
`hits.find(...)`.

```ts
import {boxCollider, Entity, layer, ray, raycast} from "@repraze/glaze";

const r = camera.getRay(ray.create(), ndcX, ndcY, width / height); // NDC: x right, y up, -1..1
const [hit] = raycast(scene, r, {layers: layer(0) | layer(2)});

// widen a small target with an invisible proxy: hits report the proxy, walk `parent` to its owner
const hitbox = new Entity();
hitbox.collider = boxCollider([1, 1, 1]);
button.add(hitbox);
```

- **Colliders** are what a ray hits, separate from rendering: `boxCollider(size | min, max)`,
  `sphereCollider(radius, center?)`, `geometryCollider(geometry?, {cullBackFace})`, on any entity. A mesh starts with
  its own geometry (bounds computed on first hit test, back faces culled like the renderer); `mesh.collider = null`
  takes it out of picking for free.
- **Layers**: one 32-bit mask per entity (`entity.layers`, default `layer(0)`), not inherited. `raycast` tests
  `entity.layers & layers`; a camera renders the meshes on its `visibleLayers` (default `ALL_LAYERS`).
- Layers and `filter` skip only that entity, never its children; a disabled entity skips its subtree. World matrices
  are refreshed first.

## Pointer input and controls

`PointerInput` turns a canvas's pointer events (mouse, touch, pen) into rays, hits and per-entity handlers, and
shares gestures between consumers so dragging an object never orbits the camera.

```ts
import {OrbitControls, PointerInput} from "@repraze/glaze";

const input = new PointerInput(canvas, {scene}); // camera: scene.activeCamera unless given
input.on(car, "click", (e) => select(car)); // a hit on a wheel bubbles up to the car
input.on(box, "pointerdown", (e) => e.capture()); // own the drag: its moves come here, the camera stays put

const controls = new OrbitControls(camera, {target: [0, 0.5, 0]}).attach(input);
renderer.startAnimation(({delta}) => (controls.update(delta), graph));
```

- **Events**: `pointerdown`, `pointermove`, `pointerup`, `click` (a press that moved less than `clickThreshold`),
  `pointerenter` / `pointerleave` (the nearest hit and its ancestors). Each goes to the entity hit, up its ancestors,
  then on to the next hit behind; an entity hears it once. `stopPropagation()` ends it. Events carry `ray`, `hits`,
  `hit`, `target`, `currentTarget` and the `pointer` (CSS px and NDC).
- **Gestures**: a press is offered to consumers by priority until one claims it; the claimer alone gets its moves,
  and every consumer offered it gets the release. Scene picking is at `SCENE_PICKING_PRIORITY` (100) and claims when a
  handler calls `capture()`; controls sit at 0. Implement `PointerConsumer` for your own (a gizmo above 100).
- **OrbitControls**: drag rotates, wheel or pinch zooms, right-drag, shift-drag or two fingers pan. On a trackpad
  (`trackpadGestures`), pinch zooms, a two-finger swipe rotates and Shift + swipe pans; a mouse wheel still zooms.
  `damping` eases frame-rate independently; distance and polar limits (steady through the poles: no roll);
  `autoRotate` spins while idle; `rotate` / `zoom` / `pan` / `setOrbit` drive it from code. For a canvas in a
  scrolling page, `captureScroll: false` leaves the wheel to the page until the canvas is pressed, and
  `touchAction: "pan-y"` (default `"none"`) lets one-finger vertical swipes scroll it.

## Bounds and rays

In gl-matrix's style (plain data, free functions, `out` first, aliasing allowed): `box3` and `sphere` for bounding
volumes, `ray` for rays. Geometry caches its local bounds on first use.

```ts
import {box3, ray} from "@repraze/glaze";

const worldBox = box3.transformMat4(box3.create(), mesh.geometry.boundingBox, mesh.worldMatrix);
const r = ray.fromNdc(ray.create(), invViewProjection, ndcX, ndcY); // through a screen point, from the near plane
const t = ray.intersectBox(r, worldBox); // distance, or null on a miss
```

`box3`: `create`, `fromValues`, `fromPositions`, `expandByPoint`, `union`, `transformMat4` (box around the
transformed box), `getCenter`, `getSize`, `containsPoint`, `intersectsBox`, `isEmpty`. `sphere`: `create`,
`fromValues`, `fromPositions`, `transformMat4`, `containsPoint`, `isEmpty`. `ray`: `create`, `fromValues`, `at`,
`fromNdc`, `transformMat4` (keeps the direction unnormalised, so local-space `t` equals world-space `t`),
`intersectBox`, `intersectSphere`, `intersectTriangle(r, a, b, c, cullBackFace?, barycentric?)`.
`geometry.boundingBox` / `boundingSphere` are cached; call `geometry.updateBounds()` after editing positions.

## Helpers

`lerp`, `clamp`, `smoothstep`, `smootherstep`, `easeIn`, `easeOut`, `easeInOut`, `pingpong`, `oscillate`,
`bounce` for animation.

## Develop

From the repository root: `npm test` (node's test runner through tsx), `npm run typecheck`,
`npm run build -w @repraze/glaze` (emits `dist/`).

## License

MIT
