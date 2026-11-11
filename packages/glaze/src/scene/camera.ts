import {mat4, vec3} from "gl-matrix";

import {Entity} from "./entity";

export abstract class Camera extends Entity {
    abstract getProjectionMatrix(aspect: number): mat4;

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

    getCameraPosition(): vec3 {
        return vec3.fromValues(this.worldMatrix[12]!, this.worldMatrix[13]!, this.worldMatrix[14]!);
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
        mat4.perspective(proj, this.fov, aspect, this.near, this.far);
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
