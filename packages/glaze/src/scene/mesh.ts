import type {Geometry} from "../geometry/geometry";
import type {Material} from "../material/material";
import {Entity} from "./entity";

export class Mesh extends Entity {
    geometry: Geometry;
    material: Material;
    castShadow: boolean;
    receiveShadow: boolean;
    /**
     * How much of each of its geometry's morph targets this mesh adds (0..1 usually), one per target. glTF
     * animations drive it; set it yourself for blend shapes. The pass reads the first 8.
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
