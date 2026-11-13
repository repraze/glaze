import {vec3} from "gl-matrix";

import type {ColorRgb} from "../color";
import {Entity} from "./entity";

export interface LightOptions {
    color?: ColorRgb;
    intensity?: number;
    castShadow?: boolean;
}

export abstract class Light extends Entity {
    color: vec3;
    intensity: number;
    castShadow: boolean;

    constructor({color = [1, 1, 1], intensity = 1, castShadow = false}: LightOptions = {}) {
        super();
        this.color = vec3.clone(color as vec3);
        this.intensity = intensity;
        this.castShadow = castShadow;
    }
}

export interface DirectionalLightOptions extends LightOptions {
    /** Initial direction the light travels (sets the rotation through `lookAlong`). */
    direction?: [number, number, number];
}

/** Parallel light travelling along the entity's -Z: aim it with `lookAt` / `lookAlong`; its position is unused. */
export class DirectionalLight extends Light {
    constructor({direction = [0, -1, 0], ...rest}: DirectionalLightOptions = {}) {
        super(rest);
        this.lookAlong(direction);
    }
}

export interface PointLightOptions extends LightOptions {
    range?: number;
}

export class PointLight extends Light {
    range: number;

    constructor({range = 10, ...rest}: PointLightOptions = {}) {
        super(rest);
        this.range = range;
    }
}

export interface SpotLightOptions extends LightOptions {
    /** Initial direction the cone points (sets the rotation through `lookAlong`). */
    direction?: [number, number, number];
    innerAngle?: number;
    outerAngle?: number;
    range?: number;
}

/** A cone of light from the entity's position along its -Z: aim it with `lookAt` / `lookAlong`. */
export class SpotLight extends Light {
    innerAngle: number;
    outerAngle: number;
    range: number;

    constructor({
        direction = [0, -1, 0],
        innerAngle = Math.PI / 8,
        outerAngle = Math.PI / 4,
        range = 10,
        ...rest
    }: SpotLightOptions = {}) {
        super(rest);
        this.lookAlong(direction);
        this.innerAngle = innerAngle;
        this.outerAngle = outerAngle;
        this.range = range;
    }
}
