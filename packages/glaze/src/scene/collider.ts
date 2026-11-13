import type {ReadonlyVec3} from "gl-matrix";

import type {Geometry} from "../geometry/geometry";
import {box3, type ReadonlyBox3, type ReadonlySphere, sphere} from "../math/bounds";

/**
 * The shape an entity is hit by in `raycast`, in the entity's local space, independent of what it renders. Any
 * entity can carry one, so an invisible entity with a box collider can widen the target of what it surrounds.
 *
 * - `box` / `sphere`: cheap analytic shapes.
 * - `geometry`: triangles. Without `geometry` it uses the entity's own (a Mesh's, read at query time, so it follows
 *   a geometry swap). `cullBackFace` skips triangles seen from behind; by default it follows the renderer (true,
 *   false on a Mesh whose material is `doubleSided`).
 *
 * Meshes start with `{kind: "geometry"}`; set `collider = null` to opt out of picking at no cost.
 */
export type Collider =
    | {readonly kind: "box"; readonly box: ReadonlyBox3}
    | {readonly kind: "sphere"; readonly sphere: ReadonlySphere}
    | {readonly kind: "geometry"; readonly geometry?: Geometry; readonly cullBackFace?: boolean};

/** A box collider from its min and max corners, or `size` centred on the origin. */
export function boxCollider(size: ReadonlyVec3): Collider;
export function boxCollider(min: ReadonlyVec3, max: ReadonlyVec3): Collider;
export function boxCollider(a: ReadonlyVec3, b?: ReadonlyVec3): Collider {
    if (b === undefined) {
        return {kind: "box", box: box3.fromValues([-a[0] / 2, -a[1] / 2, -a[2] / 2], [a[0] / 2, a[1] / 2, a[2] / 2])};
    }
    return {kind: "box", box: box3.fromValues(a, b)};
}

export function sphereCollider(radius: number, center: ReadonlyVec3 = [0, 0, 0]): Collider {
    return {kind: "sphere", sphere: sphere.fromValues(center, radius)};
}

/**
 * Triangles of `geometry`, or of the entity's own geometry when omitted. `cullBackFace` defaults to following the
 * renderer (the Mesh material's `doubleSided`).
 */
export function geometryCollider(geometry?: Geometry, {cullBackFace}: {cullBackFace?: boolean} = {}): Collider {
    return {kind: "geometry", geometry, cullBackFace};
}
