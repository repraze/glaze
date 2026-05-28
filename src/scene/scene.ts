import { Camera } from "./camera";
import { DirectionalLight, Light, PointLight, SpotLight } from "./light";
import { Entity } from "./entity";
import { Mesh } from "./mesh";
import { vec3 } from "gl-matrix";

export class Scene {
    readonly root = new Entity();
    activeCamera: Camera | null = null;
    ambientColor: vec3 = vec3.fromValues(0.05, 0.05, 0.05);
    backgroundColor: vec3 = vec3.fromValues(0, 0, 0);

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
        if (entity instanceof Mesh) meshes.push(entity);
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

    private traverseLight<T extends Light>(
        entity: Entity,
        ctor: new (...args: never[]) => T,
        out: T[],
    ): void {
        if (entity instanceof ctor) out.push(entity);
        for (const child of entity.children) {
            this.traverseLight(child, ctor, out);
        }
    }
}
