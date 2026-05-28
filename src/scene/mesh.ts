import { Geometry } from "../geometry/geometry";
import { Material } from "../material/material";
import { Entity } from "./entity";

export class Mesh extends Entity {
    geometry: Geometry;
    material: Material;

    constructor(geometry: Geometry, material: Material) {
        super();
        this.geometry = geometry;
        this.material = material;
    }
}
