import {Geometry} from "../geometry/geometry.ts";

// ─── Detection ────────────────────────────────────────────────────────────────

function isBinarySTL(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 84) return false;
    const triangleCount = new DataView(buffer).getUint32(80, true);
    // Binary STL is exactly 84 + 50*n bytes. Use this to distinguish from
    // ASCII files that happen to start with "solid".
    return buffer.byteLength === 84 + triangleCount * 50;
}

// ─── Binary parser ────────────────────────────────────────────────────────────

function parseBinarySTL(buffer: ArrayBuffer): Geometry {
    const view = new DataView(buffer);
    const triangleCount = view.getUint32(80, true);

    const positions = new Float32Array(triangleCount * 9);
    const normals   = new Float32Array(triangleCount * 9);
    const uvs       = new Float32Array(triangleCount * 6);
    const indices   = new Uint32Array(triangleCount * 3);

    let offset = 84;
    for (let i = 0; i < triangleCount; i++) {
        const nx = view.getFloat32(offset,      true);
        const ny = view.getFloat32(offset +  4, true);
        const nz = view.getFloat32(offset +  8, true);
        offset += 12;

        for (let v = 0; v < 3; v++) {
            const base = i * 9 + v * 3;
            positions[base]     = view.getFloat32(offset,      true);
            positions[base + 1] = view.getFloat32(offset +  4, true);
            positions[base + 2] = view.getFloat32(offset +  8, true);
            normals[base]     = nx;
            normals[base + 1] = ny;
            normals[base + 2] = nz;
            offset += 12;
        }

        offset += 2; // attribute byte count

        indices[i * 3]     = i * 3;
        indices[i * 3 + 1] = i * 3 + 1;
        indices[i * 3 + 2] = i * 3 + 2;
    }

    return new Geometry({positions, normals, uvs, indices});
}

// ─── ASCII parser ─────────────────────────────────────────────────────────────

function parseAsciiSTL(buffer: ArrayBuffer): Geometry {
    const text = new TextDecoder().decode(buffer);

    const posArr: number[] = [];
    const nrmArr: number[] = [];

    // Match each facet block including its three vertices.
    const facetRe =
        /facet\s+normal\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)([\s\S]*?)endfacet/g;
    const vertexRe =
        /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;

    let facetMatch: RegExpExecArray | null;
    while ((facetMatch = facetRe.exec(text)) !== null) {
        const nx = parseFloat(facetMatch[1]!);
        const ny = parseFloat(facetMatch[2]!);
        const nz = parseFloat(facetMatch[3]!);

        vertexRe.lastIndex = 0;
        let vertexMatch: RegExpExecArray | null;
        while ((vertexMatch = vertexRe.exec(facetMatch[4]!)) !== null) {
            posArr.push(
                parseFloat(vertexMatch[1]!),
                parseFloat(vertexMatch[2]!),
                parseFloat(vertexMatch[3]!),
            );
            nrmArr.push(nx, ny, nz);
        }
    }

    const vertexCount  = posArr.length / 3;
    const triangleCount = vertexCount / 3;

    const positions = new Float32Array(posArr);
    const normals   = new Float32Array(nrmArr);
    const uvs       = new Float32Array(triangleCount * 6);
    const indices   = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;

    return new Geometry({positions, normals, uvs, indices});
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an STL file (binary or ASCII) and return a {@link Geometry}.
 *
 * Vertices are unmerged (each triangle has 3 unique vertices), normals come
 * from the file's face normals, and UVs are zeroed (STL carries no UV data).
 */
export function parseSTL(buffer: ArrayBuffer): Geometry {
    return isBinarySTL(buffer) ? parseBinarySTL(buffer) : parseAsciiSTL(buffer);
}

/**
 * Fetch an STL file from `url` and parse it into a {@link Geometry}.
 */
export async function loadSTLFromURL(url: string): Promise<Geometry> {
    const response = await fetch(url);
    const buffer   = await response.arrayBuffer();
    return parseSTL(buffer);
}
