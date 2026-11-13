import {mat4} from "gl-matrix";

import {type Ray, ray} from "../math/ray";
import {ALL_LAYERS, Entity} from "./entity";

const tmpWorld = mat4.create();
const tmpInvProj = mat4.create();

export abstract class Camera extends Entity {
    /** The layers this camera renders: a mesh shows when `mesh.layers & camera.visibleLayers` is non-zero. */
    visibleLayers: number = ALL_LAYERS;

    abstract getProjectionMatrix(aspect: number): mat4;

    /**
     * The world-space ray through a point in normalised device coordinates (x right, y up, -1..1), from the near
     * plane, with a unit direction. Uses the camera's current transform (not last frame's).
     */
    getRay(out: Ray, ndcX: number, ndcY: number, aspect: number): Ray {
        // inverse(P · V) = world · inverse(P), and V is the inverse of the world matrix.
        const invProj = mat4.invert(tmpInvProj, this.getProjectionMatrix(aspect));
        if (invProj === null) {
            return ray.copy(out, {origin: this.getWorldPosition(), direction: this.getWorldDirection()});
        }
        return ray.fromNdc(out, mat4.multiply(tmpInvProj, this.computeWorldMatrix(tmpWorld), invProj), ndcX, ndcY);
    }

    getViewMatrix(): mat4 {
        const view = mat4.create();
        mat4.invert(view, this.worldMatrix);
        return view;
    }

    getViewProjectionMatrix(aspect: number): mat4 {
        const vp = mat4.create();
        mat4.multiply(vp, this.getProjectionMatrix(aspect), this.getViewMatrix());
        return vp;
    }
}

export interface PerspectiveCameraOptions {
    fov?: number;
    near?: number;
    far?: number;
}

export class PerspectiveCamera extends Camera {
    fov: number;
    near: number;
    far: number;

    constructor({fov = Math.PI / 3, near = 0.1, far = 1000}: PerspectiveCameraOptions = {}) {
        super();
        this.fov = fov;
        this.near = near;
        this.far = far;
    }

    getProjectionMatrix(aspect: number): mat4 {
        const proj = mat4.create();
        mat4.perspectiveZO(proj, this.fov, aspect, this.near, this.far); // WebGPU clip depth is 0..1
        return proj;
    }
}

export interface OrthographicCameraOptions {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    near?: number;
    far?: number;
}

export class OrthographicCamera extends Camera {
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;

    constructor({left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 1000}: OrthographicCameraOptions = {}) {
        super();
        this.left = left;
        this.right = right;
        this.top = top;
        this.bottom = bottom;
        this.near = near;
        this.far = far;
    }

    getProjectionMatrix(_aspect: number): mat4 {
        const proj = mat4.create();
        mat4.orthoZO(proj, this.left, this.right, this.bottom, this.top, this.near, this.far);
        return proj;
    }
}
