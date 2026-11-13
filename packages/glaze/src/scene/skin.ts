import {mat4} from "gl-matrix";

import type {Geometry} from "../geometry/geometry";
import type {Material} from "../material/material";
import {Entity} from "./entity";
import {Mesh} from "./mesh";

/**
 * A skeleton: the joint entities that deform a skinned mesh, and each joint's inverse bind matrix (the
 * inverse of its world transform when the mesh was bound to it). Animating the joints bends the mesh.
 */
export class Skin {
    readonly joints: readonly Entity[];
    /** 16 floats per joint, column-major. */
    readonly inverseBindMatrices: Float32Array;

    constructor(joints: readonly Entity[], inverseBindMatrices?: Float32Array) {
        this.joints = joints;
        this.inverseBindMatrices = inverseBindMatrices ?? identities(joints.length);
        if (this.inverseBindMatrices.length !== joints.length * 16) {
            throw new Error(`Skin: ${joints.length} joints need ${joints.length * 16} inverse bind matrix floats`);
        }
    }
}

function identities(count: number): Float32Array {
    const out = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
        out[i * 16] = out[i * 16 + 5] = out[i * 16 + 10] = out[i * 16 + 15] = 1;
    }
    return out;
}

const joint = mat4.create();

/**
 * A mesh deformed by a skin: each vertex follows up to four joints by its weights. The geometry needs joints
 * and weights. Its joints place it (as glTF defines): move the skeleton, not the mesh entity.
 *
 * Picking: a skinned mesh has no collider by default (its triangles move; the geometry's are the bind pose).
 * Attach colliders to the joints instead, e.g. a sphere on the head.
 */
export class SkinnedMesh extends Mesh {
    skin: Skin | null;
    /** The joint matrices this frame (world space), 16 floats per joint: filled by `updateJointMatrices`. */
    jointMatrices: Float32Array;

    constructor(geometry: Geometry, material: Material, skin: Skin | null = null) {
        super(geometry, material);
        this.skin = skin;
        this.jointMatrices = new Float32Array((skin?.joints.length ?? 0) * 16);
        this.collider = null;
    }

    /**
     * jointMatrix[i] = jointWorld[i] · inverseBind[i]: where a joint carries a bind-pose vertex, in world space.
     * The mesh's own world matrix plays no part (glTF: the skin places the vertices), so no inverse of it is
     * needed either, which a zero scale would break. Call after world matrices are updated.
     */
    updateJointMatrices(): Float32Array {
        const skin = this.skin;
        if (skin === null) {
            return this.jointMatrices;
        }
        if (this.jointMatrices.length !== skin.joints.length * 16) {
            this.jointMatrices = new Float32Array(skin.joints.length * 16);
        }
        for (let i = 0; i < skin.joints.length; i++) {
            const ibm = skin.inverseBindMatrices.subarray(i * 16, i * 16 + 16);
            const j = skin.joints[i]!;
            // a joint the scene update didn't reach (under a disabled entity, or outside the scene): from its parents
            if (j.worldFrame !== Entity.worldPass) {
                j.computeWorldMatrix(j.worldMatrix);
                j.worldFrame = Entity.worldPass;
            }
            mat4.multiply(joint, j.worldMatrix, ibm);
            this.jointMatrices.set(joint, i * 16);
        }
        return this.jointMatrices;
    }
}
