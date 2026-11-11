import type {Geometry} from "../geometry/geometry";
import type {Material} from "../material/material";
import {Entity} from "./entity";

export class Mesh extends Entity {
    geometry: Geometry;
    material: Material;
    castShadow: boolean;
    receiveShadow: boolean;

    constructor(geometry: Geometry, material: Material) {
        super();
        this.geometry = geometry;
        this.material = material;
        this.castShadow = true;
        this.receiveShadow = true;
    }
}
