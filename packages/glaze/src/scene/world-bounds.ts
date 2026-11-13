import {mat4} from "gl-matrix";

import {type Box3, box3} from "../math/bounds";
import type {Entity} from "./entity";
import {Mesh} from "./mesh";

const tmpWorld = mat4.create();
const tmpBox = box3.create();

/**
 * The world-space box around every enabled mesh under `entity` (itself included), from each geometry's cached
 * bounds and the current transforms. Empty when there are no meshes. Use it to frame or centre a loaded model.
 */
export function computeWorldBounds(entity: Entity, out: Box3 = box3.create()): Box3 {
    box3.makeEmpty(out);
    entity.traverse((e) => {
        if (!e.enabled) {
            return false;
        }
        if (e instanceof Mesh) {
            box3.transformMat4(tmpBox, e.geometry.boundingBox, e.computeWorldMatrix(tmpWorld));
            box3.union(out, out, tmpBox);
        }
    });
    return out;
}
