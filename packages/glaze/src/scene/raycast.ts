import {mat3, mat4, type ReadonlyMat4, vec2, vec3} from "gl-matrix";

import type {Geometry} from "../geometry/geometry";
import {type Ray, ray, type ReadonlyRay} from "../math/ray";
import type {Collider} from "./collider";
import type {Entity} from "./entity";
import {ALL_LAYERS} from "./entity";
import {Mesh} from "./mesh";
import {Scene} from "./scene";

export interface RaycastHit {
    /** The entity whose collider was hit (an invisible proxy, a mesh, …): walk `parent` to find what owns it. */
    entity: Entity;
    /** Distance along the ray (in units of its direction's length; world units for a unit direction). */
    distance: number;
    /** World-space hit point. */
    point: vec3;
    /** World-space unit surface normal at the hit. */
    normal: vec3;
    /** For geometry colliders: the triangle index (`indices[3 * faceIndex …]`), else -1. */
    faceIndex: number;
    /** For geometry colliders: the interpolated texture coordinate, else null. */
    uv: vec2 | null;
}

export interface RaycastOptions {
    /** Only entities on one of these layers are tested (`entity.layers & layers`). Default: all. */
    layers?: number;
    /** Extra per-entity test, after the layer check (return false to skip the entity, not its children). */
    filter?: (entity: Entity) => boolean;
    /** Hits farther than this are dropped. Default: Infinity. */
    maxDistance?: number;
}

const tmpWorld = mat4.create();
const tmpInv = mat4.create();
const tmpNormalMat = mat3.create();
const localRay: Ray = ray.create();
const tmpA = vec3.create();
const tmpB = vec3.create();
const tmpC = vec3.create();
const tmpBary = vec3.create();
const tmpLocalNormal = vec3.create();

/**
 * Every collider the world-space ray crosses under `target` (a scene, or one entity and its subtree), nearest
 * first. Disabled entities and their subtrees are skipped; layers and `filter` skip only the entity itself, so a
 * group on another layer still lets its children be hit. World matrices are refreshed first, so the result
 * reflects transforms set since the last frame.
 *
 * All hits are returned, not only the first: pick the one behind with `hits[1]`, or the first that passes a test.
 */
export function raycast(target: Scene | Entity, worldRay: ReadonlyRay, options: RaycastOptions = {}): RaycastHit[] {
    const {layers = ALL_LAYERS, filter, maxDistance = Infinity} = options;
    const hits: RaycastHit[] = [];

    const visit = (entity: Entity): void => {
        if (!entity.enabled) {
            return;
        }
        if (entity.collider !== null && (entity.layers & layers) !== 0 && (filter === undefined || filter(entity))) {
            const hit = intersectCollider(entity, entity.collider, entity.worldMatrix, worldRay);
            if (hit !== null && hit.distance <= maxDistance) {
                hits.push(hit);
            }
        }
        for (const child of entity.children) {
            visit(child);
        }
    };

    if (target instanceof Scene) {
        target.updateWorldMatrices();
        target.root.children.forEach(visit);
    } else {
        target.updateWorldMatrix(target.parent === null ? null : target.parent.computeWorldMatrix(tmpWorld));
        visit(target);
    }
    return hits.sort((a, b) => a.distance - b.distance);
}

function intersectCollider(
    entity: Entity,
    collider: Collider,
    world: ReadonlyMat4,
    worldRay: ReadonlyRay,
): RaycastHit | null {
    if (mat4.invert(tmpInv, world) === null) {
        return null; // zero scale: nothing to hit
    }
    // Local-space ray with an unnormalised direction: its t is the world-space t.
    ray.transformMat4(localRay, worldRay, tmpInv);

    let t: number | null = null;
    let faceIndex = -1;
    let uv: vec2 | null = null;

    switch (collider.kind) {
        case "box": {
            t = ray.intersectBox(localRay, collider.box);
            if (t !== null) {
                boxNormal(tmpLocalNormal, ray.at(tmpA, localRay, t), collider.box.min, collider.box.max);
            }
            break;
        }
        case "sphere": {
            t = ray.intersectSphere(localRay, collider.sphere);
            if (t !== null) {
                vec3.subtract(tmpLocalNormal, ray.at(tmpA, localRay, t), collider.sphere.center);
                if (vec3.squaredLength(tmpLocalNormal) === 0) {
                    vec3.negate(tmpLocalNormal, localRay.direction);
                }
            }
            break;
        }
        case "geometry": {
            const geometry = collider.geometry ?? (entity instanceof Mesh ? entity.geometry : undefined);
            if (geometry === undefined) {
                return null;
            }
            const found = intersectGeometry(geometry, collider.cullBackFace ?? true);
            if (found !== null) {
                ({t, faceIndex, uv} = found);
            }
            break;
        }
    }
    if (t === null) {
        return null;
    }

    const point = ray.at(vec3.create(), worldRay, t);
    // Normals go to world space through the inverse transpose of the world matrix.
    mat3.normalFromMat4(tmpNormalMat, world as mat4);
    const normal = vec3.transformMat3(vec3.create(), tmpLocalNormal, tmpNormalMat);
    vec3.normalize(normal, normal);
    return {entity, distance: t, point, normal, faceIndex, uv};
}

/** Nearest triangle hit of the local ray; leaves the face normal in tmpLocalNormal. */
function intersectGeometry(geometry: Geometry, cullBackFace: boolean): {t: number; faceIndex: number; uv: vec2} | null {
    // Broad phase: the cached local bounding box.
    if (ray.intersectBox(localRay, geometry.boundingBox) === null) {
        return null;
    }
    const {positions, indices, uvs} = geometry;
    let bestT = Infinity;
    let bestFace = -1;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let f = 0; f * 3 + 2 < indices.length; f++) {
        const i0 = indices[f * 3]! * 3;
        const i1 = indices[f * 3 + 1]! * 3;
        const i2 = indices[f * 3 + 2]! * 3;
        vec3.set(tmpA, positions[i0]!, positions[i0 + 1]!, positions[i0 + 2]!);
        vec3.set(tmpB, positions[i1]!, positions[i1 + 1]!, positions[i1 + 2]!);
        vec3.set(tmpC, positions[i2]!, positions[i2 + 1]!, positions[i2 + 2]!);
        const t = ray.intersectTriangle(localRay, tmpA, tmpB, tmpC, cullBackFace, tmpBary);
        if (t !== null && t < bestT) {
            bestT = t;
            bestFace = f;
            b0 = tmpBary[0];
            b1 = tmpBary[1];
            b2 = tmpBary[2];
        }
    }
    if (bestFace < 0) {
        return null;
    }

    const ia = indices[bestFace * 3]!;
    const ib = indices[bestFace * 3 + 1]!;
    const ic = indices[bestFace * 3 + 2]!;
    vec3.set(tmpA, positions[ia * 3]!, positions[ia * 3 + 1]!, positions[ia * 3 + 2]!);
    vec3.set(tmpB, positions[ib * 3]!, positions[ib * 3 + 1]!, positions[ib * 3 + 2]!);
    vec3.set(tmpC, positions[ic * 3]!, positions[ic * 3 + 1]!, positions[ic * 3 + 2]!);
    vec3.cross(tmpLocalNormal, vec3.subtract(tmpB, tmpB, tmpA), vec3.subtract(tmpC, tmpC, tmpA));
    // Seen from behind (double-sided picking): face the normal toward the ray.
    if (vec3.dot(tmpLocalNormal, localRay.direction) > 0) {
        vec3.negate(tmpLocalNormal, tmpLocalNormal);
    }

    const uv = vec2.fromValues(
        b0 * (uvs[ia * 2] ?? 0) + b1 * (uvs[ib * 2] ?? 0) + b2 * (uvs[ic * 2] ?? 0),
        b0 * (uvs[ia * 2 + 1] ?? 0) + b1 * (uvs[ib * 2 + 1] ?? 0) + b2 * (uvs[ic * 2 + 1] ?? 0),
    );
    return {t: bestT, faceIndex: bestFace, uv};
}

/** Outward normal of the box face nearest to a point on its surface. */
function boxNormal(out: vec3, p: vec3, min: ArrayLike<number>, max: ArrayLike<number>): vec3 {
    let best = Infinity;
    vec3.set(out, 0, 0, 1);
    for (let i = 0; i < 3; i++) {
        const dMin = Math.abs(p[i]! - min[i]!);
        const dMax = Math.abs(p[i]! - max[i]!);
        if (dMin < best) {
            best = dMin;
            vec3.set(out, 0, 0, 0);
            out[i] = -1;
        }
        if (dMax < best) {
            best = dMax;
            vec3.set(out, 0, 0, 0);
            out[i] = 1;
        }
    }
    return out;
}
