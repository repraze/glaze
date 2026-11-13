import {mat4, quat, type ReadonlyVec3, vec3} from "gl-matrix";

import type {Collider} from "./collider";

/** Every layer bit set: the default query and visibility mask. */
export const ALL_LAYERS = 0xffffffff;

/** The mask with only layer `n` (0..31) set, Blender-style: `entity.layers = layer(0) | layer(3)`. */
export function layer(n: number): number {
    return (1 << n) >>> 0;
}

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const WORLD_UP: ReadonlyVec3 = vec3.fromValues(0, 1, 0);
const ORIGIN: ReadonlyVec3 = vec3.fromValues(0, 0, 0);
// Stand-in up vectors when the look direction is parallel to `up`.
const FALLBACK_UP_Z: ReadonlyVec3 = vec3.fromValues(0, 0, -1);
const FALLBACK_UP_X: ReadonlyVec3 = vec3.fromValues(1, 0, 0);
const DEG = 180 / Math.PI;

// Scratch values for the methods below (never escape them).
const tmpMat = mat4.create();
const tmpMat2 = mat4.create();
const tmpQuat = quat.create();
const tmpVec = vec3.create();

/**
 * A node of the scene tree: a local transform (position, rotation quaternion, scale) composed with its parent's.
 *
 * Orientation convention: an entity looks down its local -Z with +Y up (cameras, `lookAt`, `getWorldDirection`).
 */
export class Entity {
    readonly children: Entity[] = [];
    parent: Entity | null = null;
    enabled: boolean = true;
    /** A label for finding the entity (`find`); loaders copy node names here. */
    name: string = "";

    /**
     * The layers this entity is on, a 32-bit mask (default: layer 0). One mask for everything: `raycast` queries
     * and a camera's `visibleLayers` match it with a bitwise AND. Not inherited: each entity has its own.
     */
    layers: number = 1;

    /** The shape `raycast` hits this entity by, in local space; null (the default, except on meshes) for none. */
    collider: Collider | null = null;

    position: vec3 = vec3.fromValues(0, 0, 0);
    /** Local rotation, a unit quaternion (x, y, z, w). Set it from angles with `setEuler`. */
    quaternion: quat = quat.create();
    scale: vec3 = vec3.fromValues(1, 1, 1);

    /** World transform, updated each frame by the scene traversal (use the `getWorld*` methods for a fresh value). */
    readonly worldMatrix: mat4 = mat4.create();
    /** Local transform computed from position/quaternion/scale. */
    readonly localMatrix: mat4 = mat4.create();

    add(child: Entity): this {
        child.parent?.remove(child);
        child.parent = this;
        this.children.push(child);
        return this;
    }

    remove(child: Entity): this {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parent = null;
        }
        return this;
    }

    /** Calls `fn` for this entity and every descendant, depth first; return false from `fn` to skip a subtree. */
    traverse(fn: (entity: Entity) => boolean | void): void {
        if (fn(this) === false) {
            return;
        }
        for (const child of this.children) {
            child.traverse(fn);
        }
    }

    /** The first entity named `name` in this subtree (this one included), depth first; null if none. */
    find(name: string): Entity | null {
        let found: Entity | null = null;
        this.traverse((e) => {
            if (found !== null) {
                return false;
            }
            if (e.name === name) {
                found = e;
                return false;
            }
        });
        return found;
    }

    // ─── Rotation ─────────────────────────────────────────────────────────────

    /** Sets the rotation from Euler angles in radians (gl-matrix's default order, as `quat.fromEuler`). */
    setEuler(x: number, y: number, z: number): this {
        quat.fromEuler(this.quaternion, x * DEG, y * DEG, z * DEG);
        return this;
    }

    /** Rotates about the local X axis by `rad`. */
    rotateX(rad: number): this {
        quat.rotateX(this.quaternion, this.quaternion, rad);
        return this;
    }

    /** Rotates about the local Y axis by `rad`. */
    rotateY(rad: number): this {
        quat.rotateY(this.quaternion, this.quaternion, rad);
        return this;
    }

    /** Rotates about the local Z axis by `rad`. */
    rotateZ(rad: number): this {
        quat.rotateZ(this.quaternion, this.quaternion, rad);
        return this;
    }

    /**
     * Turns the entity so its -Z axis points at a world-space `target`, keeping `up` (world space) as close to +Y as
     * possible. Accounts for the parent's world rotation. A target at the entity's own position leaves it unchanged.
     */
    lookAt(target: ReadonlyVec3, up: ReadonlyVec3 = WORLD_UP): this {
        const eye = this.getWorldPosition(tmpVec);
        return this.lookAlong(vec3.subtract(tmpVec, target, eye), up);
    }

    /**
     * Turns the entity so its -Z axis points along a world-space `direction` (any length), keeping `up` as close to
     * +Y as possible. When the direction is parallel to `up` (straight down, say) another axis stands in for it.
     * Accounts for the parent's world rotation. A zero direction leaves it unchanged.
     */
    lookAlong(direction: ReadonlyVec3, up: ReadonlyVec3 = WORLD_UP): this {
        const lenSq = vec3.squaredLength(direction);
        const upLenSq = vec3.squaredLength(up);
        if (lenSq === 0 || upLenSq === 0) {
            return this;
        }
        const cos = vec3.dot(direction, up) / Math.sqrt(lenSq * upLenSq);
        let safeUp = up;
        if (Math.abs(cos) > 0.9999) {
            // targetTo's right axis would be cross(up, forward) = 0: pick the world axis least aligned with it.
            const ax = Math.abs(direction[0]);
            const az = Math.abs(direction[2]);
            safeUp = az <= ax ? FALLBACK_UP_Z : FALLBACK_UP_X;
        }
        // targetTo builds a world transform (not a view matrix like mat4.lookAt) whose -Z faces the target.
        mat4.targetTo(tmpMat2, ORIGIN, direction, safeUp);
        mat4.getRotation(this.quaternion, tmpMat2);
        if (this.parent !== null) {
            this.parent.getWorldQuaternion(tmpQuat);
            quat.invert(tmpQuat, tmpQuat);
            quat.multiply(this.quaternion, tmpQuat, this.quaternion);
        }
        quat.normalize(this.quaternion, this.quaternion);
        return this;
    }

    // ─── World-space queries (computed from the parent chain, never stale) ────

    /** The world transform, recomputed now from the local transforms up the parent chain. */
    computeWorldMatrix(out: mat4 = mat4.create()): mat4 {
        this.updateLocalMatrix();
        if (this.parent === null) {
            return mat4.copy(out, this.localMatrix);
        }
        this.parent.computeWorldMatrix(out);
        return mat4.multiply(out, out, this.localMatrix);
    }

    getWorldPosition(out: vec3 = vec3.create()): vec3 {
        return mat4.getTranslation(out, this.computeWorldMatrix(tmpMat));
    }

    getWorldQuaternion(out: quat = quat.create()): quat {
        return quat.normalize(out, mat4.getRotation(out, this.computeWorldMatrix(tmpMat)));
    }

    getWorldScale(out: vec3 = vec3.create()): vec3 {
        return mat4.getScaling(out, this.computeWorldMatrix(tmpMat));
    }

    /** The unit world-space direction the entity faces (its -Z axis). */
    getWorldDirection(out: vec3 = vec3.create()): vec3 {
        const m = this.computeWorldMatrix(tmpMat);
        return vec3.normalize(out, vec3.set(out, -m[8]!, -m[9]!, -m[10]!));
    }

    // ─── Frame traversal ──────────────────────────────────────────────────────

    updateLocalMatrix(): void {
        mat4.fromRotationTranslationScale(this.localMatrix, this.quaternion, this.position, this.scale);
    }

    updateWorldMatrix(parentWorld: mat4 | null): void {
        if (!this.enabled) {
            return;
        }
        this.updateLocalMatrix();
        if (parentWorld !== null) {
            mat4.multiply(this.worldMatrix, parentWorld, this.localMatrix);
        } else {
            mat4.copy(this.worldMatrix, this.localMatrix);
        }
        for (const child of this.children) {
            child.updateWorldMatrix(this.worldMatrix);
        }
    }
}
