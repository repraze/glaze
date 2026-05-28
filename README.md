# @repraze/glaze

A performant WebGPU rendering engine with class-based bindings and a composable render-pass pipeline. WebGL compatibility is not a goal — this library targets the WebGPU API exclusively.

---

## Architecture overview

```
Renderer
  └─ Pass chain: [Pass, Pass, ...]
       ├─ ShaderPass         — fullscreen fragment-shader effects
       └─ DeferredScenePass  — deferred 3-D scene renderer
```

---

## Renderer

`Renderer` initialises the WebGPU device and canvas context. Passes are executed in order; each pass can read the output textures of all previous passes and may write to its own output textures or directly to the canvas.

```ts
import { Renderer } from "@repraze/glaze/renderer";

const renderer = await Renderer.init(canvasElement);

// Single frame
renderer.renderFrame([noisePass, dotsPass]);

// Animation loop
const stop = renderer.startAnimation([noisePass, dotsPass]);
// later…
stop();
```

---

## Passes

A **Pass** is one step in the rendering pipeline. Each pass declares:

- `outputSpecs` — the textures it writes to (format + optional fixed size). An empty array means the pass renders directly to the canvas (must be the last pass).
- `inputCount` — how many textures from the previous pass it expects as inputs.

The renderer automatically creates and manages the intermediate textures and wires them between passes.

### ShaderPass

Renders a fullscreen quad through a user-supplied WGSL fragment shader.

```ts
import { ShaderPass } from "@repraze/glaze/passes/shader-pass";

const noisePass = new ShaderPass({
    fragmentShader: /* wgsl */ `
        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
            let uv = in.uv * globals.resolution / 256.0;
            return vec4<f32>(noise(uv, globals.time), 0.0, 0.0, 1.0);
        }
    `,
    outputSpecs: [{ format: "rgba8unorm", width: 256, height: 256 }],
});
```

**Do not redeclare** `QuadInput`, `globals`, `inputSampler`, or any `inputN` — they are all injected automatically. Your fragment source should only contain helper functions and the `@fragment fn fs_main` entry point.

**Auto-injected bindings** available in every fragment shader:

| Binding              | Type                    | Description                        |
|----------------------|-------------------------|------------------------------------|
| `@group(0) @binding(0)` `globals` | `GlobalsUniform` | `time: f32`, `resolution: vec2<f32>` |
| `@group(1) @binding(0)` `inputSampler` | `sampler` | Shared sampler for all input textures |
| `@group(1) @binding(N)` `inputN`       | `texture_2d<f32>` | Each input texture (1-indexed) |

The vertex stage outputs a `QuadInput` struct:

```wgsl
struct QuadInput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}
```

### DeferredScenePass

Renders a 3-D scene using deferred shading.

1. **G-buffer pass** — renders all geometry to albedo / normal / world-position textures.
2. **Lighting accumulation** — a fullscreen pass that reads the G-buffer and accumulates contributions from every light in the scene.

```ts
import { DeferredScenePass } from "@repraze/glaze/passes/deferred-scene-pass";

const scenePass = new DeferredScenePass({ scene });
// renders to a single rgba16float output texture by default
```

---

## Scene graph

```
Scene
 └─ Entity (has localMatrix, children[])
      ├─ Mesh      — geometry + material
      ├─ Camera    — PerspectiveCamera | OrthographicCamera
      └─ Light     — DirectionalLight | PointLight | SpotLight
```

Children inherit the parent's world transform. World matrices are computed lazily each frame before rendering.

### Entity

```ts
import { Entity } from "@repraze/glaze/scene/entity";

entity.position.set(1, 2, 3);
entity.rotation.set(0, Math.PI / 4, 0);  // Euler XYZ radians
entity.scale.set(2, 2, 2);
entity.add(child);
```

### Mesh

```ts
import { Mesh } from "@repraze/glaze/scene/mesh";
import { createCube } from "@repraze/glaze/geometry/shapes";
import { StandardMaterial } from "@repraze/glaze/material";

const mesh = new Mesh(createCube({ size: 1 }), new StandardMaterial({ color: [1, 0.5, 0.2] }));
scene.add(mesh);
```

### Lights

```ts
import { DirectionalLight, PointLight, SpotLight } from "@repraze/glaze/scene/light";

const sun = new DirectionalLight({ direction: [0.5, -1, -0.5], color: [1, 0.95, 0.8], intensity: 1.5 });
const bulb = new PointLight({ color: [1, 0.8, 0.4], intensity: 3, range: 10 });
const spot = new SpotLight({ innerAngle: Math.PI / 8, outerAngle: Math.PI / 4 });
```

### Cameras

```ts
import { PerspectiveCamera, OrthographicCamera } from "@repraze/glaze/scene/camera";

const cam = new PerspectiveCamera({ fov: Math.PI / 3, near: 0.1, far: 1000 });
cam.position.set(0, 2, 5);
scene.activeCamera = cam;
```

---

## Geometry

### Geometry class

```ts
import { Geometry } from "@repraze/glaze/geometry";

// positions: Float32Array (3 floats/vertex)
// normals:   Float32Array (3 floats/vertex)
// uvs:       Float32Array (2 floats/vertex)
// indices:   Uint32Array
const geo = new Geometry({ positions, normals, uvs, indices });
```

### Shape factories

All factories accept a `flat?: boolean` option. When `true`, the geometry is expanded into unshared triangles with per-face normals (flat shading).

| Function | Key options |
|---|---|
| `createCube(opts)` | `size`, `widthSegments`, `heightSegments`, `depthSegments` |
| `createPlane(opts)` | `width`, `height`, `widthSegments`, `heightSegments` |
| `createQuad(opts)` | `width`, `height` |
| `createSphere(opts)` | `radius`, `widthSegments`, `heightSegments` |
| `createIcosphere(opts)` | `radius`, `subdivisions` |
| `createCylinder(opts)` | `radiusTop`, `radiusBottom`, `height`, `radialSegments`, `heightSegments`, `openEnded` |
| `createCone(opts)` | `radius`, `height`, `radialSegments`, `heightSegments`, `openEnded` |
| `createTorus(opts)` | `radius`, `tube`, `radialSegments`, `tubularSegments`, `arc` |

---

## Material

### StandardMaterial

```ts
import { StandardMaterial } from "@repraze/glaze/material";

const mat = new StandardMaterial({
    color: [1, 0.5, 0.2],      // albedo RGB (default [1,1,1])
    roughness: 0.6,             // 0–1
    metallic: 0.0,              // 0–1
    emissive: [0, 0, 0, 0],    // RGBA emission
});
```

Multiple mesh instances sharing the **same** `StandardMaterial` instance reuse the same GPU buffer and bind group — no redundant uploads.

---

## Render targets

Passing `outputSpecs: []` (or omitting it on the last pass) directs the pass output to the canvas. Any non-empty `outputSpecs` array creates GPU textures that the next pass in the chain receives as inputs.

Fixed-size output textures are created at the specified dimensions and are not resized with the canvas. Omitting `width`/`height` in a spec causes the texture to match the canvas size and be recreated on resize.

---

## Animation & lifecycle

```ts
// Start/stop animation
const stop = renderer.startAnimation(passes);
stop();

// Single frame (e.g. static renders, tests)
renderer.renderFrame(passes);

// Explicit resize (called automatically if ResizeObserver is used)
renderer.resize(width, height);

// Full teardown
renderer.destroy();
```

---

## Math

This library uses [`gl-matrix`](https://glmatrix.net/) for all vector/matrix math. Import it directly when needed:

```ts
import { mat4, vec3 } from "gl-matrix";
```
