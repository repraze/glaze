import {vec3} from "gl-matrix";

import type {ColorRgb} from "../color";
import {ALL_LAYERS, Entity} from "./entity";

/**
 * How a light's shadow looks. Every field has a default that suits most scenes; change them on `light.shadow`
 * at any time (the next frame uses them).
 */
export interface ShadowSettings {
    /**
     * The light's size, which sets how soft shadows get away from what casts them (sharp at contact, wider
     * further off). A directional light: its angular diameter in degrees (the sun is about 0.5). A point or
     * spot light: its radius in world units. 0: hard, only anti-aliased.
     */
    softness: number;
    /** Filter samples per shadow lookup: more is smoother on soft edges, and costs more. Default 16. */
    samples: number;
    /** Lookups move off the surface along its normal by this many shadow texels at grazing light. Default 1.5. */
    normalBias: number;
    /** …and toward the light by this many shadow texels. Default 0.5. */
    bias: number;
    /** How dark the shadow is, 0..1: 1 blocks the light fully, 0.5 lets half through. Default 1. */
    intensity: number;
    /**
     * Point and spot lights: where the shadow map starts, in world units from the light. Casters nearer than this
     * cast nothing; a smaller value costs depth precision far away. Default 0.1.
     */
    near: number;
    /** Which meshes cast into this light's shadow: those whose `layers` share a bit with it. Default all. */
    layers: number;
}

/** See {@link DirectionalShadowSettings.cascadeBlend}. */
export type CascadeBlend = "dither" | "smooth" | "none";

/** A directional light's shadow: cascades fitted to the camera's view, finest near the camera. */
export interface DirectionalShadowSettings extends ShadowSettings {
    /** How many shadow maps split the view in depth, 1 to 4. Default 4. */
    cascades: number;
    /** Shadows end this far from the camera (they fade over the last tenth). Default 40. */
    maxDistance: number;
    /**
     * Where the splits fall: 0 spaces them evenly, 1 logarithmically (much finer near the camera).
     * Default 0.6 (about 10%, 20% and 45% of maxDistance for four cascades).
     */
    splitBalance: number;
    /**
     * How a cascade hands over to the next, over the last tenth of it, so the seam doesn't show:
     * - `"dither"` (default): each pixel picks one of the two with a fixed screen-space threshold. One lookup,
     *   and stable: the pattern doesn't change from frame to frame, so it doesn't flicker.
     * - `"smooth"`: both are looked up and cross-faded. Softest, twice the work in the band.
     * - `"none"`: a hard switch, cheapest; the change in sharpness can show as a line.
     */
    cascadeBlend: CascadeBlend;
}

export interface LightOptions {
    color?: ColorRgb;
    intensity?: number;
    castShadow?: boolean;
    /** Shadow settings to override; the rest keep their defaults. */
    shadow?: Partial<ShadowSettings>;
}

export abstract class Light extends Entity {
    color: vec3;
    intensity: number;
    castShadow: boolean;
    /** See {@link ShadowSettings}. */
    shadow: ShadowSettings;

    constructor({color = [1, 1, 1], intensity = 1, castShadow = false, shadow}: LightOptions = {}) {
        super();
        this.color = vec3.clone(color as vec3);
        this.intensity = intensity;
        this.castShadow = castShadow;
        this.shadow = {
            softness: 0.05,
            samples: 16,
            normalBias: 1.5,
            bias: 0.5,
            intensity: 1,
            near: 0.1,
            layers: ALL_LAYERS,
            ...shadow,
        };
    }
}

export interface DirectionalLightOptions extends Omit<LightOptions, "shadow"> {
    /** Initial direction the light travels (sets the rotation through `lookAlong`). */
    direction?: [number, number, number];
    /** Shadow settings to override; the rest keep their defaults. */
    shadow?: Partial<DirectionalShadowSettings>;
}

/** Parallel light travelling along the entity's -Z: aim it with `lookAt` / `lookAlong`; its position is unused. */
export class DirectionalLight extends Light {
    /** See {@link DirectionalShadowSettings}. */
    declare shadow: DirectionalShadowSettings;

    constructor({direction = [0, -1, 0], shadow, ...rest}: DirectionalLightOptions = {}) {
        super(rest);
        this.shadow = {
            softness: 1,
            samples: 16,
            normalBias: 1.5,
            bias: 0.5,
            intensity: 1,
            near: 0.1,
            layers: ALL_LAYERS,
            cascades: 4,
            maxDistance: 40,
            splitBalance: 0.6,
            cascadeBlend: "dither",
            ...shadow,
        };
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
    /** Half-angle (radians) of the fully lit core. Kept between 0 and `outerAngle`. */
    innerAngle?: number;
    /** Half-angle (radians) where the light reaches 0. Kept below 89°. */
    outerAngle?: number;
    range?: number;
}

const MAX_SPOT_ANGLE = (89 * Math.PI) / 180;

/** @internal A spot light's cone as rendered: outer within (0, 89°], inner within [0, outer). */
export function spotCone(light: SpotLight): {inner: number; outer: number} {
    const outer = Math.min(Math.max(light.outerAngle, 1e-3), MAX_SPOT_ANGLE);
    const inner = Math.min(Math.max(light.innerAngle, 0), outer * 0.999);
    return {inner, outer};
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
