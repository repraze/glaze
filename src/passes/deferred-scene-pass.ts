import { mat4, vec3 } from "gl-matrix";

import { Geometry } from "../geometry/geometry";
import { StandardMaterial } from "../material/material";
import { Pass, PassOutputSpec, PassRenderContext } from "../pass";
import { Camera } from "../scene/camera";
import { Mesh } from "../scene/mesh";
import { Scene } from "../scene/scene";

// ─── WGSL shaders ─────────────────────────────────────────────────────────────

const GBUFFER_SHADER = /* wgsl */ `
struct CameraUniforms {
    view:           mat4x4<f32>,
    projection:     mat4x4<f32>,
    viewProjection: mat4x4<f32>,
    position:       vec4<f32>,
};

struct ModelUniforms {
    model:        mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
};

struct MaterialUniforms {
    albedo:    vec4<f32>,
    roughness: f32,
    metallic:  f32,
    _pad0:     f32,
    _pad1:     f32,
    emissive:  vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> model:  ModelUniforms;
@group(2) @binding(0) var<uniform> mat:     MaterialUniforms;
@group(2) @binding(1) var albedoMap:         texture_2d<f32>;
@group(2) @binding(2) var albedoSampler:     sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clipPos:     vec4<f32>,
    @location(0)       worldPos:    vec3<f32>,
    @location(1)       worldNormal: vec3<f32>,
    @location(2)       uv:          vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    let worldPos = model.model * vec4<f32>(input.position, 1.0);
    var output: VertexOutput;
    output.clipPos     = camera.viewProjection * worldPos;
    output.worldPos    = worldPos.xyz;
    output.worldNormal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
    output.uv          = input.uv;
    return output;
}

struct GBufferOutput {
    @location(0) albedo:   vec4<f32>,
    @location(1) normal:   vec4<f32>,
    @location(2) worldPos: vec4<f32>,
    @location(3) emissive: vec4<f32>,
};

@fragment
fn fs_main(input: VertexOutput) -> GBufferOutput {
    let texAlbedo = textureSample(albedoMap, albedoSampler, input.uv).rgb;
    var out: GBufferOutput;
    out.albedo   = vec4<f32>(mat.albedo.rgb * texAlbedo, 1.0);
    out.normal   = vec4<f32>(normalize(input.worldNormal), mat.roughness);
    out.worldPos = vec4<f32>(input.worldPos, mat.metallic);
    out.emissive = vec4<f32>(mat.emissive.rgb, 0.0);
    return out;
}
`;

// ─── Max lights ──────────────────────────────────────────────────────────────

const MAX_DIRECTIONAL = 4;
const MAX_POINT = 8;
const MAX_SPOT = 4;

// ─── Lighting uniform layout ─────────────────────────────────────────────────
//
// ambientColor:       vec4<f32>                    offset   0   16 bytes
// cameraPosition:     vec4<f32>                    offset  16   16 bytes
// counts:             vec4<u32> (dir,pt,spot,pad)  offset  32   16 bytes
// directionalLights:  array<DirectionalLight, 4>   offset  48  128 bytes  (4 * 32)
// pointLights:        array<PointLight, 8>          offset 176  256 bytes  (8 * 32)
// spotLights:         array<SpotLight, 4>           offset 432  256 bytes  (4 * 64)
// Total: 688 bytes
//
// DirectionalLight { direction: vec4, colorIntensity: vec4 } = 32 bytes
// PointLight       { position:  vec4 (xyz,range), colorIntensity: vec4 } = 32 bytes
// SpotLight        { position:  vec4 (xyz,range), direction: vec4, colorIntensity: vec4, angles: vec4 } = 64 bytes

const LIGHTING_BUFFER_SIZE = 704;

const LIGHTING_SHADER = /* wgsl */ `
struct DirectionalLight {
    direction:      vec4<f32>,  // xyz = direction, w = unused
    colorIntensity: vec4<f32>,  // xyz = color, w = intensity
};

struct PointLight {
    position:       vec4<f32>,  // xyz = world pos, w = range
    colorIntensity: vec4<f32>,  // xyz = color, w = intensity
};

struct SpotLight {
    position:       vec4<f32>,  // xyz = world pos, w = range
    direction:      vec4<f32>,  // xyz = direction, w = unused
    colorIntensity: vec4<f32>,  // xyz = color, w = intensity
    angles:         vec4<f32>,  // x = cos(innerAngle), y = cos(outerAngle), zw = unused
};

struct LightingUniforms {
    ambientColor:       vec4<f32>,
    cameraPosition:     vec4<f32>,
    counts:             vec4<u32>,  // x=dir, y=point, z=spot
    directionalLights:  array<DirectionalLight, ${MAX_DIRECTIONAL}>,
    pointLights:        array<PointLight, ${MAX_POINT}>,
    spotLights:         array<SpotLight, ${MAX_SPOT}>,
    backgroundColor:    vec4<f32>,
};

@group(0) @binding(0) var albedoTex:    texture_2d<f32>;
@group(0) @binding(1) var normalTex:    texture_2d<f32>;
@group(0) @binding(2) var posTex:       texture_2d<f32>;
@group(0) @binding(3) var<uniform> lighting: LightingUniforms;
@group(0) @binding(4) var emissiveTex: texture_2d<f32>;

struct QuadInput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> QuadInput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    var p = positions[vi];
    var out: QuadInput;
    out.pos = vec4<f32>(p, 0.0, 1.0);
    out.uv  = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
    return out;
}

const PI: f32 = 3.14159265358979;

fn D_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a  = roughness * roughness;
    let a2 = a * a;
    let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

fn G_Smith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let r  = roughness + 1.0;
    let k  = (r * r) / 8.0;
    let gv = NdotV / (NdotV * (1.0 - k) + k);
    let gl = NdotL / (NdotL * (1.0 - k) + k);
    return gv * gl;
}

fn F_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn brdf_direct(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, albedo: vec3<f32>, roughness: f32, metallic: f32, F0: vec3<f32>, NdotV: f32) -> vec3<f32> {
    let H     = normalize(V + L);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);
    let D = D_GGX(NdotH, roughness);
    let G = G_Smith(NdotV, NdotL, roughness);
    let F = F_Schlick(HdotV, F0);
    let specular = (D * G * F) / max(4.0 * NdotV * NdotL, 0.001);
    let diffuse  = (1.0 - metallic) * albedo / PI;
    return (diffuse + specular) * NdotL;
}

@fragment
fn fs_main(input: QuadInput) -> @location(0) vec4<f32> {
    let coord   = vec2<i32>(i32(input.pos.x), i32(input.pos.y));
    let albedo4 = textureLoad(albedoTex, coord, 0);
    // Background pixel: albedo alpha is 0 (G-buffer cleared to [0,0,0,0]).
    if (albedo4.a < 0.5) {
        return lighting.backgroundColor;
    }
    let albedo       = albedo4.rgb;
    let normalSample = textureLoad(normalTex, coord, 0);
    let N            = normalize(normalSample.xyz);
    let roughness    = clamp(normalSample.w, 0.05, 1.0);
    let posSample    = textureLoad(posTex, coord, 0);
    let worldPos     = posSample.xyz;
    let metallic     = clamp(posSample.w, 0.0, 1.0);

    let V    = normalize(lighting.cameraPosition.xyz - worldPos);
    let NdotV = max(dot(N, V), 0.001);
    let F0   = mix(vec3<f32>(0.04), albedo, metallic);

    var colour = lighting.ambientColor.rgb * albedo;

    // Directional lights
    for (var i = 0u; i < lighting.counts.x; i++) {
        let dl = lighting.directionalLights[i];
        let L  = normalize(-dl.direction.xyz);
        colour += brdf_direct(N, V, L, albedo, roughness, metallic, F0, NdotV)
                  * dl.colorIntensity.rgb * dl.colorIntensity.w;
    }

    // Point lights
    for (var i = 0u; i < lighting.counts.y; i++) {
        let pl      = lighting.pointLights[i];
        let toLight = pl.position.xyz - worldPos;
        let dist    = length(toLight);
        let L       = toLight / dist;
        let attn    = clamp(1.0 - dist / pl.position.w, 0.0, 1.0);
        colour += brdf_direct(N, V, L, albedo, roughness, metallic, F0, NdotV)
                  * pl.colorIntensity.rgb * (pl.colorIntensity.w * attn * attn);
    }

    // Spot lights
    for (var i = 0u; i < lighting.counts.z; i++) {
        let sl      = lighting.spotLights[i];
        let toLight = sl.position.xyz - worldPos;
        let dist    = length(toLight);
        let L       = toLight / dist;
        let attn     = clamp(1.0 - dist / sl.position.w, 0.0, 1.0);
        let theta    = dot(L, normalize(-sl.direction.xyz));
        let spotAttn = clamp(
            (theta - sl.angles.y) / (sl.angles.x - sl.angles.y),
            0.0, 1.0
        );
        colour += brdf_direct(N, V, L, albedo, roughness, metallic, F0, NdotV)
                  * sl.colorIntensity.rgb * (sl.colorIntensity.w * attn * attn * spotAttn);
    }

    colour += textureLoad(emissiveTex, coord, 0).rgb;
    return vec4<f32>(colour, 1.0);
}
`;

// ─── GPU resource cache per Mesh ──────────────────────────────────────────────

interface MeshGPUResources {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    modelBuffer: GPUBuffer;
    modelBindGroup: GPUBindGroup;
    indexCount: number;
}

// ─── DeferredScenePass ───────────────────────────────────────────────────────

export interface DeferredScenePassOptions {
    scene: Scene;
    outputSpecs?: PassOutputSpec[];
}

export class DeferredScenePass extends Pass {
    readonly outputSpecs: PassOutputSpec[];
    readonly inputCount = 0;

    private readonly scene: Scene;

    private device!: GPUDevice;
    private canvasFormat!: GPUTextureFormat;
    private width = 1;
    private height = 1;

    // G-buffer internals
    private albedoTex!: GPUTexture;
    private normalTex!: GPUTexture;
    private posTex!: GPUTexture;
    private emissiveTex!: GPUTexture;
    private depthTex!: GPUTexture;

    // Pipelines and layouts
    private gbufferPipeline!: GPURenderPipeline;
    private lightingPipeline!: GPURenderPipeline;

    private cameraBindGroupLayout!: GPUBindGroupLayout;
    private modelBindGroupLayout!: GPUBindGroupLayout;
    private materialBindGroupLayout!: GPUBindGroupLayout;

    // Camera uniforms
    private cameraBuffer!: GPUBuffer;
    private cameraBindGroup!: GPUBindGroup;

    // Lighting uniforms
    private lightingBuffer!: GPUBuffer;
    private lightingBindGroup: GPUBindGroup | null = null;
    private lightingBindGroupLayout!: GPUBindGroupLayout;

    // Default material texture resources
    private defaultAlbedoTex!: GPUTexture;
    private defaultAlbedoView!: GPUTextureView;
    private texSampler!: GPUSampler;

    // Cached mesh GPU resources
    private meshCache = new Map<Mesh, MeshGPUResources>();

    constructor({ scene, outputSpecs }: DeferredScenePassOptions) {
        super();
        this.scene = scene;
        this.outputSpecs = outputSpecs ?? [{ format: "rgba16float" }];
    }

    initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
        this.device = device;
        this.canvasFormat = canvasFormat;

        this.cameraBuffer = device.createBuffer({
            label: "DeferredScene:camera",
            // view(64) + proj(64) + vp(64) + pos(16) = 208 bytes
            size: 208,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.lightingBuffer = device.createBuffer({
            label: "DeferredScene:lighting",
            size: LIGHTING_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.buildPipelines();
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        this.rebuildGBuffer();
    }

    render(ctx: PassRenderContext): void {
        const { encoder, outputs, canvasView } = ctx;
        const camera = this.scene.activeCamera;

        this.scene.updateWorldMatrices();
        this.uploadCameraUniforms(camera, ctx.width, ctx.height);
        this.uploadLightingUniforms();

        const meshes = this.scene.collectMeshes();
        this.ensureMeshResources(meshes);

        // G-buffer pass
        this.renderGBuffer(encoder, meshes);

        // Lighting / composite pass
        const outputView = outputs ? outputs[0]! : canvasView!;
        this.renderLighting(encoder, outputView);
    }

    destroy(): void {
        this.albedoTex?.destroy();
        this.normalTex?.destroy();
        this.posTex?.destroy();
        this.emissiveTex?.destroy();
        this.depthTex?.destroy();
        this.defaultAlbedoTex?.destroy();
        this.cameraBuffer?.destroy();
        this.lightingBuffer?.destroy();
        for (const r of this.meshCache.values()) {
            r.vertexBuffer.destroy();
            r.indexBuffer.destroy();
            r.modelBuffer.destroy();
        }
        this.meshCache.clear();
    }

    // ─── Private: pipeline setup ────────────────────────────────────────────

    private buildPipelines(): void {
        const { device } = this;

        this.cameraBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:cameraLayout",
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
        });

        this.modelBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:modelLayout",
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
        });

        this.materialBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:materialLayout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });

        // Default 1×1 white albedo texture used when material has no albedoMap.
        const white = new Uint8Array([255, 255, 255, 255]);
        this.defaultAlbedoTex = device.createTexture({
            label: "DeferredScene:defaultAlbedo",
            size: { width: 1, height: 1 },
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: this.defaultAlbedoTex }, white, { bytesPerRow: 4 }, { width: 1, height: 1 });
        this.defaultAlbedoView = this.defaultAlbedoTex.createView();
        this.texSampler = device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "repeat",
        });

        const gbufferLayout = device.createPipelineLayout({
            bindGroupLayouts: [
                this.cameraBindGroupLayout,
                this.modelBindGroupLayout,
                this.materialBindGroupLayout,
            ],
        });

        const gbufferModule = device.createShaderModule({ label: "GBuffer", code: GBUFFER_SHADER });

        this.gbufferPipeline = device.createRenderPipeline({
            label: "DeferredScene:gbuffer",
            layout: gbufferLayout,
            vertex: {
                module: gbufferModule,
                entryPoint: "vs_main",
                buffers: [
                    {
                        arrayStride: 32, // 8 floats × 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0,  format: "float32x3" }, // position
                            { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
                            { shaderLocation: 2, offset: 24, format: "float32x2" }, // uv
                        ],
                    },
                ],
            },
            fragment: {
                module: gbufferModule,
                entryPoint: "fs_main",
                targets: [
                    { format: "rgba8unorm" },   // albedo
                    { format: "rgba16float" },  // normal
                    { format: "rgba16float" },  // world position
                    { format: "rgba16float" },  // emissive (HDR)
                ],
            },
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: {
                format: "depth24plus",
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        });

        // Lighting pipeline bind group layout
        this.lightingBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:lightingLayout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
            ],
        });

        const lightingLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.lightingBindGroupLayout],
        });

        const lightingModule = device.createShaderModule({ label: "Lighting", code: LIGHTING_SHADER });

        // Output format: either the user-specified texture format or canvas format
        const outputFormat = this.outputSpecs.length > 0 ? this.outputSpecs[0]!.format : this.canvasFormat;

        this.lightingPipeline = device.createRenderPipeline({
            label: "DeferredScene:lighting",
            layout: lightingLayout,
            vertex: { module: lightingModule, entryPoint: "vs_main" },
            fragment: {
                module: lightingModule,
                entryPoint: "fs_main",
                targets: [{ format: outputFormat }],
            },
            primitive: { topology: "triangle-list" },
        });

        // Build camera bind group now (buffer already created)
        this.cameraBindGroup = device.createBindGroup({
            label: "DeferredScene:camera",
            layout: this.cameraBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
        });
    }

    // ─── Private: G-buffer management ───────────────────────────────────────

    private rebuildGBuffer(): void {
        this.albedoTex?.destroy();
        this.normalTex?.destroy();
        this.posTex?.destroy();
        this.emissiveTex?.destroy();
        this.depthTex?.destroy();

        const { device, width, height } = this;

        const makeTexture = (format: GPUTextureFormat, label: string) =>
            device.createTexture({
                label,
                size: { width, height },
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });

        this.albedoTex   = makeTexture("rgba8unorm",  "GBuffer:albedo");
        this.normalTex   = makeTexture("rgba16float", "GBuffer:normal");
        this.posTex      = makeTexture("rgba16float", "GBuffer:position");
        this.emissiveTex = makeTexture("rgba16float", "GBuffer:emissive");
        this.depthTex    = makeTexture("depth24plus", "GBuffer:depth");

        // Rebuild the lighting bind group with new texture views.
        this.lightingBindGroup = null;
    }

    private getLightingBindGroup(): GPUBindGroup {
        if (this.lightingBindGroup) return this.lightingBindGroup;

        this.lightingBindGroup = this.device.createBindGroup({
            label: "DeferredScene:lightingBindGroup",
            layout: this.lightingBindGroupLayout,
            entries: [
                { binding: 0, resource: this.albedoTex.createView() },
                { binding: 1, resource: this.normalTex.createView() },
                { binding: 2, resource: this.posTex.createView() },
                { binding: 3, resource: { buffer: this.lightingBuffer } },
                { binding: 4, resource: this.emissiveTex.createView() },
            ],
        });

        return this.lightingBindGroup;
    }

    // ─── Private: render steps ───────────────────────────────────────────────

    private renderGBuffer(encoder: GPUCommandEncoder, meshes: Mesh[]): void {
        const pass = encoder.beginRenderPass({
            label: "GBuffer",
            colorAttachments: [
                { view: this.albedoTex.createView(),   clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
                { view: this.normalTex.createView(),   clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
                { view: this.posTex.createView(),      clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
                { view: this.emissiveTex.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
            ],
            depthStencilAttachment: {
                view: this.depthTex.createView(),
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });

        pass.setPipeline(this.gbufferPipeline);
        pass.setBindGroup(0, this.cameraBindGroup);

        for (const mesh of meshes) {
            const res = this.meshCache.get(mesh);
            if (!res) continue;

            this.uploadModelUniforms(mesh, res.modelBuffer);

            const matBg = mesh.material instanceof StandardMaterial
                ? mesh.material.getOrCreateBindGroup(this.device, this.materialBindGroupLayout, this.defaultAlbedoView, this.texSampler)
                : null;

            if (!matBg) continue;

            pass.setBindGroup(1, res.modelBindGroup);
            pass.setBindGroup(2, matBg);
            pass.setVertexBuffer(0, res.vertexBuffer);
            pass.setIndexBuffer(res.indexBuffer, "uint32");
            pass.drawIndexed(res.indexCount);
        }

        pass.end();
    }

    private renderLighting(encoder: GPUCommandEncoder, outputView: GPUTextureView): void {
        const pass = encoder.beginRenderPass({
            label: "Lighting",
            colorAttachments: [
                { view: outputView, clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" },
            ],
        });

        pass.setPipeline(this.lightingPipeline);
        pass.setBindGroup(0, this.getLightingBindGroup());
        pass.draw(3);
        pass.end();
    }

    // ─── Private: uniform uploads ────────────────────────────────────────────

    private uploadCameraUniforms(camera: Camera | null, width: number, height: number): void {
        const aspect = width / height;
        const viewMatrix = camera ? camera.getViewMatrix() : mat4.create();
        const projMatrix = camera ? camera.getProjectionMatrix(aspect) : mat4.create();
        const vpMatrix   = camera ? camera.getViewProjectionMatrix(aspect) : mat4.create();
        const camPos     = camera ? camera.getCameraPosition() : vec3.create();

        // Layout: view(64) + proj(64) + vp(64) + pos(16) = 208 bytes
        const data = new Float32Array(208 / 4);
        data.set(viewMatrix, 0);
        data.set(projMatrix, 16);
        data.set(vpMatrix, 32);
        data[48] = camPos[0];
        data[49] = camPos[1];
        data[50] = camPos[2];
        data[51] = 1.0;

        this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
    }

    private uploadModelUniforms(mesh: Mesh, buffer: GPUBuffer): void {
        const model = mesh.worldMatrix;
        const normalMatrix = mat4.create();
        mat4.invert(normalMatrix, model);
        mat4.transpose(normalMatrix, normalMatrix);

        const data = new Float32Array(32); // 2 × mat4
        data.set(model, 0);
        data.set(normalMatrix, 16);
        this.device.queue.writeBuffer(buffer, 0, data);
    }

    private uploadLightingUniforms(): void {
        const data = new ArrayBuffer(LIGHTING_BUFFER_SIZE);
        const f32  = new Float32Array(data);
        const u32  = new Uint32Array(data);

        const ambient = this.scene.ambientColor;
        f32[0] = ambient[0]; f32[1] = ambient[1]; f32[2] = ambient[2]; f32[3] = 1.0;

        const cam = this.scene.activeCamera;
        const cp  = cam ? cam.getCameraPosition() : vec3.create();
        f32[4] = cp[0]; f32[5] = cp[1]; f32[6] = cp[2]; f32[7] = 1.0;

        const dirLights   = this.scene.collectDirectionalLights().slice(0, MAX_DIRECTIONAL);
        const pointLights = this.scene.collectPointLights().slice(0, MAX_POINT);
        const spotLights  = this.scene.collectSpotLights().slice(0, MAX_SPOT);

        u32[8]  = dirLights.length;
        u32[9]  = pointLights.length;
        u32[10] = spotLights.length;
        u32[11] = 0;

        // Directional lights (offset 48 bytes = float index 12), each 32 bytes = 8 floats
        for (let i = 0; i < dirLights.length; i++) {
            const li = 12 + i * 8;
            const l  = dirLights[i]!;
            f32[li + 0] = l.direction[0]; f32[li + 1] = l.direction[1]; f32[li + 2] = l.direction[2]; f32[li + 3] = 0.0;
            f32[li + 4] = l.color[0];     f32[li + 5] = l.color[1];     f32[li + 6] = l.color[2];     f32[li + 7] = l.intensity;
        }

        // Point lights (offset 176 bytes = float index 44), each 32 bytes = 8 floats
        for (let i = 0; i < pointLights.length; i++) {
            const li = 44 + i * 8;
            const l  = pointLights[i]!;
            const wp = l.worldMatrix;
            f32[li + 0] = wp[12]!;    f32[li + 1] = wp[13]!;    f32[li + 2] = wp[14]!;    f32[li + 3] = l.range;
            f32[li + 4] = l.color[0]; f32[li + 5] = l.color[1]; f32[li + 6] = l.color[2]; f32[li + 7] = l.intensity;
        }

        // Spot lights (offset 432 bytes = float index 108), each 64 bytes = 16 floats
        for (let i = 0; i < spotLights.length; i++) {
            const li = 108 + i * 16;
            const l  = spotLights[i]!;
            const wp = l.worldMatrix;
            f32[li + 0]  = wp[12]!;         f32[li + 1]  = wp[13]!;         f32[li + 2]  = wp[14]!;         f32[li + 3]  = l.range;
            f32[li + 4]  = l.direction[0];  f32[li + 5]  = l.direction[1];  f32[li + 6]  = l.direction[2];  f32[li + 7]  = 0.0;
            f32[li + 8]  = l.color[0];      f32[li + 9]  = l.color[1];      f32[li + 10] = l.color[2];      f32[li + 11] = l.intensity;
            f32[li + 12] = Math.cos(l.innerAngle); f32[li + 13] = Math.cos(l.outerAngle); f32[li + 14] = 0.0; f32[li + 15] = 0.0;
        }

        const bg = this.scene.backgroundColor;
        f32[172] = bg[0]; f32[173] = bg[1]; f32[174] = bg[2]; f32[175] = 1.0;

        this.device.queue.writeBuffer(this.lightingBuffer, 0, data);
    }

    // ─── Private: mesh GPU resource management ───────────────────────────────

    private ensureMeshResources(meshes: Mesh[]): void {
        for (const mesh of meshes) {
            if (this.meshCache.has(mesh)) continue;
            this.meshCache.set(mesh, this.createMeshResources(mesh.geometry));
        }
    }

    private createMeshResources(geo: Geometry): MeshGPUResources {
        const { device } = this;

        const interleaved = geo.buildInterleavedBuffer();
        const vertexBuffer = device.createBuffer({
            label: "Mesh:vertex",
            size: interleaved.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, interleaved);

        const indexBuffer = device.createBuffer({
            label: "Mesh:index",
            size: geo.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(indexBuffer, 0, geo.indices);

        const modelBuffer = device.createBuffer({
            label: "Mesh:model",
            size: 128, // 2 × mat4
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const modelBindGroup = device.createBindGroup({
            label: "Mesh:modelBindGroup",
            layout: this.modelBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: modelBuffer } }],
        });

        return { vertexBuffer, indexBuffer, modelBuffer, modelBindGroup, indexCount: geo.indexCount };
    }
}
