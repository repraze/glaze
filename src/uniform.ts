// ─── Uniform interface (type namespace) ───────────────────────────────────────

/**
 * A named uniform value that maps to a WGSL type.
 * Use the Uniform factory object to create instances: Uniform.f32(0), Uniform.vec3([1,0,0]).
 * Set .value on the returned object to update it each frame (EffectPass reads it automatically).
 */
export interface Uniform<T = unknown> {
    readonly wgslType: string;
    /** Byte alignment required by WGSL (uniform buffer layout rules). */
    readonly align: number;
    /** Byte size of the value (may be less than align for vec3). */
    readonly size: number;
    value: T;
    writeToView(view: DataView, byteOffset: number): void;
}

// ─── Internal base + concrete implementations ─────────────────────────────────

abstract class UniformBase<T> implements Uniform<T> {
    abstract readonly wgslType: string;
    abstract readonly align: number;
    abstract readonly size: number;
    value: T;
    constructor(value: T) {
        this.value = value;
    }
    abstract writeToView(view: DataView, byteOffset: number): void;
}

class F32Uniform extends UniformBase<number> {
    readonly wgslType = "f32";
    readonly align = 4;
    readonly size = 4;
    writeToView(view: DataView, byteOffset: number): void {
        view.setFloat32(byteOffset, this.value, true);
    }
}

class I32Uniform extends UniformBase<number> {
    readonly wgslType = "i32";
    readonly align = 4;
    readonly size = 4;
    writeToView(view: DataView, byteOffset: number): void {
        view.setInt32(byteOffset, this.value, true);
    }
}

class U32Uniform extends UniformBase<number> {
    readonly wgslType = "u32";
    readonly align = 4;
    readonly size = 4;
    writeToView(view: DataView, byteOffset: number): void {
        view.setUint32(byteOffset, this.value, true);
    }
}

class Vec2F32Uniform extends UniformBase<[number, number]> {
    readonly wgslType = "vec2<f32>";
    readonly align = 8;
    readonly size = 8;
    writeToView(view: DataView, byteOffset: number): void {
        view.setFloat32(byteOffset,     this.value[0], true);
        view.setFloat32(byteOffset + 4, this.value[1], true);
    }
}

class Vec3F32Uniform extends UniformBase<[number, number, number]> {
    readonly wgslType = "vec3<f32>";
    readonly align = 16; // vec3 requires 16-byte alignment despite being only 12 bytes
    readonly size = 12;
    writeToView(view: DataView, byteOffset: number): void {
        view.setFloat32(byteOffset,     this.value[0], true);
        view.setFloat32(byteOffset + 4, this.value[1], true);
        view.setFloat32(byteOffset + 8, this.value[2], true);
    }
}

class Vec4F32Uniform extends UniformBase<[number, number, number, number]> {
    readonly wgslType = "vec4<f32>";
    readonly align = 16;
    readonly size = 16;
    writeToView(view: DataView, byteOffset: number): void {
        view.setFloat32(byteOffset,      this.value[0], true);
        view.setFloat32(byteOffset + 4,  this.value[1], true);
        view.setFloat32(byteOffset + 8,  this.value[2], true);
        view.setFloat32(byteOffset + 12, this.value[3], true);
    }
}

class Vec2I32Uniform extends UniformBase<[number, number]> {
    readonly wgslType = "vec2<i32>";
    readonly align = 8;
    readonly size = 8;
    writeToView(view: DataView, byteOffset: number): void {
        view.setInt32(byteOffset,     this.value[0], true);
        view.setInt32(byteOffset + 4, this.value[1], true);
    }
}

class Vec3I32Uniform extends UniformBase<[number, number, number]> {
    readonly wgslType = "vec3<i32>";
    readonly align = 16;
    readonly size = 12;
    writeToView(view: DataView, byteOffset: number): void {
        view.setInt32(byteOffset,     this.value[0], true);
        view.setInt32(byteOffset + 4, this.value[1], true);
        view.setInt32(byteOffset + 8, this.value[2], true);
    }
}

class Vec4I32Uniform extends UniformBase<[number, number, number, number]> {
    readonly wgslType = "vec4<i32>";
    readonly align = 16;
    readonly size = 16;
    writeToView(view: DataView, byteOffset: number): void {
        view.setInt32(byteOffset,      this.value[0], true);
        view.setInt32(byteOffset + 4,  this.value[1], true);
        view.setInt32(byteOffset + 8,  this.value[2], true);
        view.setInt32(byteOffset + 12, this.value[3], true);
    }
}

class Vec2U32Uniform extends UniformBase<[number, number]> {
    readonly wgslType = "vec2<u32>";
    readonly align = 8;
    readonly size = 8;
    writeToView(view: DataView, byteOffset: number): void {
        view.setUint32(byteOffset,     this.value[0], true);
        view.setUint32(byteOffset + 4, this.value[1], true);
    }
}

class Vec3U32Uniform extends UniformBase<[number, number, number]> {
    readonly wgslType = "vec3<u32>";
    readonly align = 16;
    readonly size = 12;
    writeToView(view: DataView, byteOffset: number): void {
        view.setUint32(byteOffset,     this.value[0], true);
        view.setUint32(byteOffset + 4, this.value[1], true);
        view.setUint32(byteOffset + 8, this.value[2], true);
    }
}

class Vec4U32Uniform extends UniformBase<[number, number, number, number]> {
    readonly wgslType = "vec4<u32>";
    readonly align = 16;
    readonly size = 16;
    writeToView(view: DataView, byteOffset: number): void {
        view.setUint32(byteOffset,      this.value[0], true);
        view.setUint32(byteOffset + 4,  this.value[1], true);
        view.setUint32(byteOffset + 8,  this.value[2], true);
        view.setUint32(byteOffset + 12, this.value[3], true);
    }
}

// ─── Uniform factory object (value namespace, same name as the interface) ─────
// TypeScript allows a type and a value to share the same identifier.
// `Uniform` as a type refers to the interface; `Uniform.f32(...)` calls the factory.
// Note: booleans cannot be stored in WGSL uniform buffers — use u32 (0/1) instead.

export const Uniform = {
    f32:   (v: number):                              Uniform<number>                              => new F32Uniform(v),
    i32:   (v: number):                              Uniform<number>                              => new I32Uniform(v),
    u32:   (v: number):                              Uniform<number>                              => new U32Uniform(v),
    vec2:  (v: [number, number]):                    Uniform<[number, number]>                    => new Vec2F32Uniform(v),
    vec3:  (v: [number, number, number]):            Uniform<[number, number, number]>            => new Vec3F32Uniform(v),
    vec4:  (v: [number, number, number, number]):    Uniform<[number, number, number, number]>    => new Vec4F32Uniform(v),
    vec2i: (v: [number, number]):                    Uniform<[number, number]>                    => new Vec2I32Uniform(v),
    vec3i: (v: [number, number, number]):            Uniform<[number, number, number]>            => new Vec3I32Uniform(v),
    vec4i: (v: [number, number, number, number]):    Uniform<[number, number, number, number]>    => new Vec4I32Uniform(v),
    vec2u: (v: [number, number]):                    Uniform<[number, number]>                    => new Vec2U32Uniform(v),
    vec3u: (v: [number, number, number]):            Uniform<[number, number, number]>            => new Vec3U32Uniform(v),
    vec4u: (v: [number, number, number, number]):    Uniform<[number, number, number, number]>    => new Vec4U32Uniform(v),
};

// ─── TextureUniform ───────────────────────────────────────────────────────────

/**
 * An externally-provided GPU texture for use with EffectPass.
 * Set .texture after async loading; EffectPass detects changes each frame.
 */
export class TextureUniform {
    texture: GPUTexture | null;
    filter: "nearest" | "linear";
    constructor(filter: "nearest" | "linear" = "nearest", texture: GPUTexture | null = null) {
        this.filter = filter;
        this.texture = texture;
    }
}
