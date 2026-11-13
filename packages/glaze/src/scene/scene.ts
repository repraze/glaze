import {vec3} from "gl-matrix";

import type {Texture} from "../texture";
import type {Camera} from "./camera";
import {Entity} from "./entity";
import type {Light} from "./light";
import {DirectionalLight, PointLight, SpotLight} from "./light";
import {Mesh} from "./mesh";

export class Scene {
    readonly root = new Entity();
    activeCamera: Camera | null = null;
    // Colors are sRGB (hex ÷ 255, what a color picker shows); the scene pass decodes them to linear light.
    /** Light from everywhere, times albedo and occlusion. */
    ambientColor: vec3 = vec3.fromValues(0.25, 0.25, 0.25);
    /** Shown where nothing is drawn: exactly this color on screen with tone mapping "none". */
    backgroundColor: vec3 = vec3.fromValues(0, 0, 0);
    /**
     * Tint and strength of reflections (sRGB like the other colors: 0.5 is about a fifth of the light); without an
     * environmentMap they reflect ambientColor times this.
     */
    environmentColor: vec3 = vec3.fromValues(1.0, 1.0, 1.0);
    environmentMap: Texture | null = null;
    backgroundMap: Texture | null = null;

    add(entity: Entity): this {
        this.root.add(entity);
        return this;
    }

    remove(entity: Entity): this {
        this.root.remove(entity);
        return this;
    }

    /** Recompute all world matrices from the root. */
    updateWorldMatrices(): void {
        for (const child of this.root.children) {
            child.updateWorldMatrix(null);
        }
    }

    /** Collect all Mesh instances via depth-first traversal. */
    collectMeshes(): Mesh[] {
        const result: Mesh[] = [];
        this.traverseEntity(this.root, result);
        return result;
    }

    private traverseEntity(entity: Entity, meshes: Mesh[]): void {
        if (!entity.enabled) {
            return;
        }
        if (entity instanceof Mesh) {
            meshes.push(entity);
        }
        for (const child of entity.children) {
            this.traverseEntity(child, meshes);
        }
    }

    /** Collect all lights of a given type. */
    collectDirectionalLights(): DirectionalLight[] {
        return this.collectLightsOfType(DirectionalLight);
    }

    collectPointLights(): PointLight[] {
        return this.collectLightsOfType(PointLight);
    }

    collectSpotLights(): SpotLight[] {
        return this.collectLightsOfType(SpotLight);
    }

    private collectLightsOfType<T extends Light>(ctor: new (...args: never[]) => T): T[] {
        const result: T[] = [];
        this.traverseLight(this.root, ctor, result);
        return result;
    }

    private traverseLight<T extends Light>(entity: Entity, ctor: new (...args: never[]) => T, out: T[]): void {
        if (!entity.enabled) {
            return;
        }
        if (entity instanceof ctor) {
            out.push(entity);
        }
        for (const child of entity.children) {
            this.traverseLight(child, ctor, out);
        }
    }
}
