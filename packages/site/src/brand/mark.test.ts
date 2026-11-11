import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {palette} from "@repraze/termicolor";

import {MARK_COLORS, MARK_SHAPES, markSvg} from "./mark.ts";

/** The few matchers these checks use, on node:assert (the repo's test runner is node:test). */
function expect<T>(actual: T, message?: string) {
    return {
        not: {toContain: (part: string) => assert.ok(!(actual as string).includes(part), `not contains ${part}`)},
        toContain: (part: string) => assert.ok((actual as string).includes(part), `contains ${part}`),
        toBe: (expected: unknown) => assert.equal(actual, expected, message ?? "values differ"),
        toBeCloseTo: (expected: number, digits = 2) =>
            assert.ok(Math.abs((actual as number) - expected) < 10 ** -digits / 2, `${String(actual)} ≈ ${expected}`),
        toBeGreaterThan: (n: number) => assert.ok((actual as number) > n, `${String(actual)} > ${n}`),
        toBeLessThan: (n: number) => assert.ok((actual as number) < n, `${String(actual)} < ${n}`),
        toBeGreaterThanOrEqual: (n: number) => assert.ok((actual as number) >= n, `${String(actual)} >= ${n}`),
        toBeLessThanOrEqual: (n: number) => assert.ok((actual as number) <= n, `${String(actual)} <= ${n}`),
        toHaveLength: (n: number) => assert.equal((actual as {length: number}).length, n),
        toMatch: (re: RegExp) => assert.match(actual as string, re),
    };
}

/** Every coordinate and radius in a path, without the arc flags (clockwise or counter-clockwise). */
const numbers = (d: string) =>
    d
        .replace(/A(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) 0 0 [01]/g, "A$1 $2")
        .match(/-?\d+(\.\d+)?/g)!
        .map(Number);

/** Every coordinate in a path: the numbers with each arc's radii and flags left out. */
const coordinates = (d: string) =>
    d
        .replace(/A\d+(?:\.\d+)? \d+(?:\.\d+)? 0 0 [01]/g, "A")
        .match(/-?\d+(\.\d+)?/g)!
        .map(Number);

/** The end point of every command in a path (M, L, H, V, C, A), in order. */
const points = (d: string) => {
    const out: [number, number][] = [];
    let x = 0;
    let y = 0;
    for (const [, cmd = "", args = ""] of d.matchAll(/([MLHVCA])([^MLHVCAZ]*)/g)) {
        const v = args.trim().split(/\s+/).map(Number);
        const [a = 0, b = 0] = v.slice(-2);
        if (cmd === "H") {
            x = a;
        } else if (cmd === "V") {
            y = a;
        } else {
            [x, y] = [a, b];
        }
        out.push([x, y]);
    }
    return out;
};
const radius = ([x, y]: [number, number]) => Math.hypot(x - 16, y - 16);

const [silhouette, dough, sprinkles] = MARK_SHAPES;
/** The dough is its even 12-unit circle followed by the glaze edge it cuts out. */
const doughCircle = dough!.d.slice(0, dough!.d.indexOf("Z") + 1);
const glazeEdge = dough!.d.slice(doughCircle.length);

describe("brand mark", () => {
    it("puts the outline, hole and dough circle on the even-unit grid, so their edges land on whole pixels", () => {
        // the glaze wave and the pill sprinkles cannot sit on a grid, so only the frame is checked
        expect(doughCircle).toBe("M4 16A12 12 0 0 1 28 16A12 12 0 0 1 4 16Z");
        for (const d of [silhouette!.d, doughCircle]) {
            for (const n of numbers(d)) {
                expect(n % 2, `${n} in ${d}`).toBe(0);
            }
        }
    });

    it("stays inside the 32-unit viewBox with a 2-unit margin", () => {
        for (const n of MARK_SHAPES.flatMap(({d}) => coordinates(d))) {
            expect(n).toBeGreaterThanOrEqual(2);
            expect(n).toBeLessThanOrEqual(30);
        }
    });

    it("cuts the hole through the silhouette, so it stays transparent", () => {
        expect(silhouette!.d).toBe("M2 16A14 14 0 0 1 30 16A14 14 0 0 1 2 16ZM12 16A4 4 0 0 0 20 16A4 4 0 0 0 12 16Z");
    });

    it("runs the glaze edge as one smooth wave between the hole and the dough's rim", () => {
        expect(glazeEdge).toMatch(/^M[^MZ]+Z$/);
        const curves = [...glazeEdge.matchAll(/C([^CZ]+)/g)].map(([, a = ""]) => a.trim().split(/\s+/).map(Number));
        expect(curves).toHaveLength(32);
        let prev = points(glazeEdge)[0]!;
        let prevIn: [number, number] | undefined;
        const ends: number[] = [];
        for (const [c1x = 0, c1y = 0, c2x = 0, c2y = 0, x = 0, y = 0] of curves) {
            // smooth joints: the control points either side of each joint are collinear with it
            if (prevIn) {
                const cross = (prev[0] - prevIn[0]) * (c1y - prev[1]) - (prev[1] - prevIn[1]) * (c1x - prev[0]);
                expect(Math.abs(cross), `kink at ${prev}`).toBeLessThan(0.05);
            }
            for (const p of [
                [c1x, c1y],
                [c2x, c2y],
                [x, y],
            ] as [number, number][]) {
                expect(radius(p)).toBeGreaterThan(6);
                expect(radius(p)).toBeLessThan(10);
            }
            ends.push(radius([x, y]));
            prevIn = [c2x, c2y];
            prev = [x, y];
        }
        // eight even waves: the edge repeats every four curves, cresting at 9.5 and dipping to 7.5
        for (let i = 4; i < ends.length; i++) {
            expect(ends[i]).toBeCloseTo(ends[i - 4]!, 1);
        }
        expect(Math.max(...ends)).toBeCloseTo(9.5, 1);
        expect(Math.min(...ends)).toBeCloseTo(7.5, 1);
    });

    it("keeps the sprinkles on the glaze, clear of the hole and inside the wave's troughs", () => {
        const pills = sprinkles!.d.match(/M[^M]+/g)!;
        expect(pills).toHaveLength(8);
        for (const p of points(sprinkles!.d)) {
            expect(radius(p), `${p}`).toBeGreaterThan(4.5);
            expect(radius(p), `${p}`).toBeLessThan(8);
        }
    });

    it("draws true circles and round pill caps: every arc has equal radii", () => {
        for (const [, rx, ry] of MARK_SHAPES.flatMap(({d}) => [...d.matchAll(/A(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g)])) {
            expect(rx).toBe(ry);
        }
    });

    it("takes its colors from the dark palette, with the orange accent as the outline", () => {
        expect(MARK_COLORS.outline).toBe(palette.modes.dark.accents.orange);
        expect(markSvg()).toContain(`fill="${palette.modes.dark.accents.orange}"`);
    });

    it("sizes in px only when asked", () => {
        expect(markSvg()).not.toContain("width=");
        expect(markSvg({size: 512})).toContain('width="512" height="512"');
    });
});
