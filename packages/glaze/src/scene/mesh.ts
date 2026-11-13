import type {Geometry} from "../geometry/geometry";
import type {Material} from "../material/material";
import {Entity} from "./entity";

export class Mesh extends Entity {
    geometry: Geometry;
    material: Material;
    castShadow: boolean;
    receiveShadow: boolean;
    /**
     * Skipped when its bounds are outside the camera's view (default true). Turn it off for a mesh whose vertices
     * a custom shader moves beyond its geometry's bounds.
     */
    frustumCulled = true;
    /**
     * How much of each of its geometry's morph targets this mesh adds (0..1 usually), one per target. glTF
     * animations drive it; set it yourself for blend shapes. Only targets with a non-zero weight cost anything.
     */
    morphWeights: Float32Array;

    constructor(geometry: Geometry, material: Material) {
        super();
        this.geometry = geometry;
        this.material = material;
        this.castShadow = true;
        this.receiveShadow = true;
        this.morphWeights = new Float32Array(geometry.morphTargets?.length ?? 0);
        // Hit by its own triangles; the bounds are only computed by the first raycast that reaches it.
        this.collider = {kind: "geometry"};
    }
}
