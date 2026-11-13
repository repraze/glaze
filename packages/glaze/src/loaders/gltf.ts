import {mat4, quat, vec3} from "gl-matrix";

import {AnimationClip, type AnimationTrack} from "../animation/clip";
import {computeTangents, Geometry} from "../geometry/geometry";
import {PBRMaterial} from "../material/material";
import {Entity} from "../scene/entity";
import {Mesh} from "../scene/mesh";
import {Skin, SkinnedMesh} from "../scene/skin";
import type {Texture} from "../texture";
import {
    createPBRMaterialFromGltf,
    decodeDataUri,
    extractMaterial,
    type GltfJson,
    type GltfNode,
    type GltfTextureSource,
    nodeMatrix,
    parseGlbContainer,
    readAccessor,
    readPrimitive,
} from "./glb";

/** A glTF scene as Glaze entities. */
export interface GltfModel {
    /** The default scene: add it to yours. Its children are the scene's root nodes. */
    readonly root: Entity;
    /** One entity per glTF node, by node index (nodes outside the default scene are built but not attached). */
    readonly nodes: readonly Entity[];
    /** Every Mesh in the model. A glTF mesh used by several nodes shares its Geometry between them. */
    readonly meshes: readonly Mesh[];
    /** One material per glTF material, shared by every primitive that uses it. */
    readonly materials: readonly PBRMaterial[];
    /** Every GPU texture the model loaded (one per image). */
    readonly textures: readonly Texture[];
    /** The file's animations, targeting the entities in `nodes`: play them with an AnimationMixer. */
    readonly animations: readonly AnimationClip[];
    /** The file's skins (skeletons), by index: their joints are entities in `nodes`. */
    readonly skins: readonly Skin[];
    /** Frees the model's textures and material buffers. */
    destroy(): void;
}

export interface GltfLoadOptions {
    /**
     * Maps a URI from the file (an external buffer or image) to a URL to fetch. Default: resolved against the
     * model's own URL, so `model.gltf` next to `model.bin` and its textures just works.
     */
    resolveUri?: (uri: string) => string;
}

const GLB_MAGIC = 0x46546c67;

/**
 * Loads a glTF 2.0 model (`.glb`, or `.gltf` with external or embedded buffers and images) as an entity tree:
 *
 * - each node becomes an Entity with the node's name and its translation / rotation / scale (or decomposed
 *   matrix), parented as in the file. A node whose mesh has one primitive *is* that Mesh; with several primitives
 *   the node holds one Mesh child per primitive.
 * - geometry is built once per glTF mesh primitive and shared by every node that uses it; materials once per glTF
 *   material; textures once per image.
 * - materials follow `planGltfMaterial`, including alphaMode, alphaCutoff and doubleSided.
 *
 * ```ts
 * const model = await loadGltf(renderer.device, "/models/donut/donut.glb");
 * scene.add(model.root);
 * model.root.find("Icing")!.enabled = false;
 * ```
 */
export async function loadGltf(device: GPUDevice, url: string, options: GltfLoadOptions = {}): Promise<GltfModel> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`glTF: failed to fetch '${url}' (${response.status})`);
    }
    const base = new URL(url, typeof location === "undefined" ? "http://localhost/" : location.href);
    return parseGltf(device, await response.arrayBuffer(), {
        resolveUri: (uri) => new URL(uri, base).href,
        ...options,
    });
}

/** As {@link loadGltf}, from the file's bytes (GLB, or glTF JSON text). External URIs go through `resolveUri`. */
export async function parseGltf(
    device: GPUDevice,
    bytes: ArrayBuffer,
    options: GltfLoadOptions = {},
): Promise<GltfModel> {
    const resolveUri = options.resolveUri ?? ((uri: string) => uri);
    const {json, buffers} = await readDocument(bytes, resolveUri);
    return buildModel(device, json, buffers, resolveUri);
}

async function readDocument(
    bytes: ArrayBuffer,
    resolveUri: (uri: string) => string,
): Promise<{json: GltfJson; buffers: ArrayBuffer[]}> {
    const isGlb = bytes.byteLength >= 4 && new DataView(bytes).getUint32(0, true) === GLB_MAGIC;
    const json: GltfJson = isGlb ? parseGlbContainer(bytes).json : JSON.parse(new TextDecoder().decode(bytes));
    const glbBin = isGlb ? parseGlbContainer(bytes).buffers[0]! : null;
    const buffers = await Promise.all(
        (json.buffers ?? []).map(async (buffer, i): Promise<ArrayBuffer> => {
            if (buffer.uri === undefined) {
                // GLB: buffer 0 without a uri is the binary chunk
                if (i === 0 && glbBin !== null) {
                    return glbBin;
                }
                throw new Error(`glTF: buffer ${i} has no data`);
            }
            const data = decodeDataUri(buffer.uri);
            if (data !== null) {
                return data.bytes.buffer;
            }
            const response = await fetch(resolveUri(buffer.uri));
            if (!response.ok) {
                throw new Error(`glTF: failed to fetch buffer '${buffer.uri}' (${response.status})`);
            }
            return response.arrayBuffer();
        }),
    );
    return {json, buffers};
}

async function buildModel(
    device: GPUDevice,
    json: GltfJson,
    buffers: ArrayBuffer[],
    resolveUri: (uri: string) => string,
): Promise<GltfModel> {
    // Materials (and their textures, shared through one cache) first: meshes need them.
    const imageCache = new Map<number, GltfTextureSource | null>();
    const textureCache = new Map<GltfTextureSource, Promise<Texture>>();
    const materials = await Promise.all(
        (json.materials ?? []).map((_, i) =>
            createPBRMaterialFromGltf(device, extractMaterial(json, buffers, i, imageCache), resolveUri, textureCache),
        ),
    );
    const textures = await Promise.all(textureCache.values());
    let fallbackMaterial: PBRMaterial | null = null;
    const materialFor = (index: number | undefined): PBRMaterial =>
        (index !== undefined ? materials[index] : undefined) ?? (fallbackMaterial ??= new PBRMaterial());

    // Geometry once per (mesh, primitive).
    const geometries = new Map<string, Geometry | null>();
    const geometryFor = (meshIndex: number, primIndex: number): Geometry | null => {
        const key = `${meshIndex}:${primIndex}`;
        if (!geometries.has(key)) {
            const prim = json.meshes![meshIndex]!.primitives[primIndex]!;
            const data = readPrimitive(json, buffers, prim);
            geometries.set(
                key,
                data === null
                    ? null
                    : new Geometry({
                          positions: data.positions,
                          normals: data.normals,
                          uvs: data.uvs,
                          indices: data.indices,
                          ...(data.joints && data.weights ? {joints: data.joints, weights: data.weights} : {}),
                          ...(data.morphTargets.length > 0 ? {morphTargets: data.morphTargets} : {}),
                          tangents:
                              data.tangents ??
                              computeTangents(
                                  data.positions,
                                  data.normals,
                                  data.uvs,
                                  data.indices,
                                  data.positions.length / 3,
                              ),
                      }),
            );
        }
        return geometries.get(key)!;
    };

    const meshes: Mesh[] = [];
    const nodes: Entity[] = (json.nodes ?? []).map((node, nodeIndex) => {
        const gltfMesh = node.mesh !== undefined ? json.meshes?.[node.mesh] : undefined;
        const prims = (gltfMesh?.primitives ?? [])
            .map((prim, i) => ({geometry: geometryFor(node.mesh!, i), material: materialFor(prim.material)}))
            .filter((p): p is {geometry: Geometry; material: PBRMaterial} => p.geometry !== null);

        // a node with a skin draws its skinned primitives as SkinnedMeshes (the skin is attached below)
        const makeMesh = (geometry: Geometry, material: PBRMaterial): Mesh =>
            node.skin !== undefined && geometry.skinned
                ? new SkinnedMesh(geometry, material)
                : new Mesh(geometry, material);
        let entity: Entity;
        if (prims.length === 1) {
            entity = makeMesh(prims[0]!.geometry, prims[0]!.material);
            meshes.push(entity as Mesh);
        } else {
            entity = new Entity();
            prims.forEach(({geometry, material}, i) => {
                const part = makeMesh(geometry, material);
                part.name = `${gltfMesh?.name ?? `mesh${node.mesh}`}#${i}`;
                meshes.push(part);
                entity.add(part);
            });
        }
        entity.name = node.name ?? gltfMesh?.name ?? `node${nodeIndex}`;
        // morph weights: the node's, else the mesh's defaults
        const defaults = node.weights ?? gltfMesh?.weights;
        if (defaults !== undefined) {
            for (const m of entity instanceof Mesh ? [entity] : entity.children) {
                if (m instanceof Mesh) {
                    m.morphWeights.set(defaults.slice(0, m.morphWeights.length));
                }
            }
        }
        setLocalTransform(entity, node);
        return entity;
    });

    // Parent as in the file (glTF nodes form a forest).
    (json.nodes ?? []).forEach((node, i) => {
        for (const child of node.children ?? []) {
            const entity = nodes[child];
            if (entity !== undefined && entity.parent === null && child !== i) {
                nodes[i]!.add(entity);
            }
        }
    });

    // skins: joints are node entities; each skinned node's meshes get theirs
    const skins = (json.skins ?? []).map(
        (def) =>
            new Skin(
                def.joints.map((i) => nodes[i]!),
                def.inverseBindMatrices !== undefined
                    ? Float32Array.from(readAccessor(json, buffers, def.inverseBindMatrices))
                    : undefined,
            ),
    );
    (json.nodes ?? []).forEach((node, i) => {
        const skin = node.skin !== undefined ? skins[node.skin] : undefined;
        if (skin === undefined) {
            return;
        }
        const entity = nodes[i]!;
        for (const mesh of entity instanceof SkinnedMesh ? [entity] : entity.children) {
            if (mesh instanceof SkinnedMesh) {
                mesh.skin = skin;
            }
        }
    });

    const root = new Entity();
    const sceneDef = json.scenes?.[json.scene ?? 0];
    root.name = sceneDef?.name ?? "scene";
    if (sceneDef?.nodes !== undefined) {
        for (const i of sceneDef.nodes) {
            const entity = nodes[i];
            if (entity !== undefined && entity.parent === null) {
                root.add(entity);
            }
        }
    } else {
        // No scene: every parentless node
        for (const entity of nodes) {
            if (entity.parent === null) {
                root.add(entity);
            }
        }
    }

    return {
        root,
        nodes,
        meshes,
        materials,
        textures,
        animations: readAnimations(json, buffers, nodes),
        skins,
        destroy() {
            for (const material of materials) {
                material.destroy();
            }
            fallbackMaterial?.destroy();
            for (const texture of textures) {
                texture.destroy();
            }
        },
    };
}

/**
 * glTF animations as clips. Node translation / rotation / scale channels become tracks on the node's entity;
 * morph target weights become `weights` tracks on the node (driving the mesh, or the meshes under it).
 */
function readAnimations(json: GltfJson, buffers: ArrayBuffer[], nodes: Entity[]): AnimationClip[] {
    return (json.animations ?? []).map((animation, index) => {
        const tracks: AnimationTrack[] = [];
        for (const channel of animation.channels) {
            const target = channel.target.node !== undefined ? nodes[channel.target.node] : undefined;
            const sampler = animation.samplers[channel.sampler];
            const path = channel.target.path;
            if (target === undefined || sampler === undefined) {
                continue;
            }
            tracks.push({
                target,
                path,
                times: Float32Array.from(readAccessor(json, buffers, sampler.input)),
                values: Float32Array.from(readAccessor(json, buffers, sampler.output)),
                interpolation: sampler.interpolation ?? "LINEAR",
            });
        }
        return new AnimationClip(animation.name ?? `animation${index}`, tracks);
    });
}

const tmpMatrix = mat4.create();

function setLocalTransform(entity: Entity, node: GltfNode): void {
    if (node.matrix !== undefined) {
        const m = mat4.copy(tmpMatrix, nodeMatrix(node));
        mat4.getTranslation(entity.position, m);
        mat4.getScaling(entity.scale, m);
        mat4.getRotation(entity.quaternion, m);
        quat.normalize(entity.quaternion, entity.quaternion);
        return;
    }
    if (node.translation !== undefined) {
        vec3.set(entity.position, node.translation[0]!, node.translation[1]!, node.translation[2]!);
    }
    if (node.rotation !== undefined) {
        quat.set(entity.quaternion, node.rotation[0]!, node.rotation[1]!, node.rotation[2]!, node.rotation[3]!);
    }
    if (node.scale !== undefined) {
        vec3.set(entity.scale, node.scale[0]!, node.scale[1]!, node.scale[2]!);
    }
}
