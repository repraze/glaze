import {mat4, quat, vec3} from "gl-matrix";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export class Entity {
    readonly children: Entity[] = [];
    parent: Entity | null = null;
    enabled: boolean = true;

    position: vec3 = vec3.fromValues(0, 0, 0);
    rotation: vec3 = vec3.fromValues(0, 0, 0); // Euler XYZ in radians
    scale: vec3 = vec3.fromValues(1, 1, 1);

    /** World transform, updated each frame by the scene traversal. */
    readonly worldMatrix: mat4 = mat4.create();
    /** Local transform computed from position/rotation/scale. */
    readonly localMatrix: mat4 = mat4.create();

    add(child: Entity): this {
        child.parent = this;
        this.children.push(child);
        return this;
    }

    remove(child: Entity): this {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parent = null;
        }
        return this;
    }

    updateLocalMatrix(): void {
        const q = quat.create();
        quat.fromEuler(
            q,
            this.rotation[0] * (180 / Math.PI),
            this.rotation[1] * (180 / Math.PI),
            this.rotation[2] * (180 / Math.PI),
        );
        mat4.fromRotationTranslationScale(this.localMatrix, q, this.position, this.scale);
    }

    updateWorldMatrix(parentWorld: mat4 | null): void {
        if (!this.enabled) {
            return;
        }
        this.updateLocalMatrix();
        if (parentWorld !== null) {
            mat4.multiply(this.worldMatrix, parentWorld, this.localMatrix);
        } else {
            mat4.copy(this.worldMatrix, this.localMatrix);
        }
        for (const child of this.children) {
            child.updateWorldMatrix(this.worldMatrix);
        }
    }
}
