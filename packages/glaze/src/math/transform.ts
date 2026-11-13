import {mat3, mat4, quat, type ReadonlyMat4, type vec3} from "gl-matrix";

const linear = mat3.create();
const rotationOnly = mat3.create();

/** True when a transform mirrors (its 3×3 part has a negative determinant): its triangles wind the other way. */
export function isMirrored(m: ReadonlyMat4): boolean {
    return mat3.determinant(mat3.fromMat4(linear, m)) < 0;
}

/**
 * Splits a transform into translation, rotation and scale. A mirroring matrix comes out with a negative X scale
 * (gl-matrix's getScaling alone is always positive, which would leave a mirror inside the "rotation").
 */
export function decompose(m: ReadonlyMat4, position: vec3 | null, rotation: quat | null, scale: vec3 | null): void {
    if (position !== null) {
        mat4.getTranslation(position, m);
    }
    const mirrored = isMirrored(m);
    if (scale !== null) {
        mat4.getScaling(scale, m);
        if (mirrored) {
            scale[0] = -scale[0];
        }
    }
    if (rotation !== null) {
        // the columns divided by their scale (gl-matrix's getRotation mixes up rows and columns under non-uniform
        // scale), then quat.fromMat3
        const sx = Math.hypot(m[0]!, m[1]!, m[2]!) * (mirrored ? -1 : 1) || 1;
        const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
        const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
        mat3.set(
            rotationOnly,
            m[0]! / sx,
            m[1]! / sx,
            m[2]! / sx,
            m[4]! / sy,
            m[5]! / sy,
            m[6]! / sy,
            m[8]! / sz,
            m[9]! / sz,
            m[10]! / sz,
        );
        quat.fromMat3(rotation, rotationOnly);
        quat.normalize(rotation, rotation);
    }
}
