// Load every docs page (and its review matrix) on the running dev server and report console errors.
//   node scripts/check-docs.mjs [slug…] [--webgpu]
// Without --webgpu, headless Chromium has no GPU adapter: every Glaze scene must show its fallback.
// With --webgpu (SwiftShader), every scene in view must reach "running".
import {existsSync, readdirSync} from "node:fs";
import {homedir} from "node:os";

import {chromium} from "playwright";

const libs = `${homedir()}/.cache/pw-libs/root/usr/lib/x86_64-linux-gnu`;
const env = {...process.env};
if (existsSync(libs)) {
    env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

const docsDir = new URL("../packages/site/src/docs/", import.meta.url).pathname;
const args = process.argv.slice(2);
const webgpu = args.includes("--webgpu");
const named = args.filter((a) => !a.startsWith("--"));
const slugs = named.length
    ? named
    : readdirSync(docsDir)
          .filter((f) => f.endsWith(".tsx"))
          .map((f) => f.replace(/\.tsx$/, ""));

const browser = await chromium.launch({env, args: webgpu ? ["--enable-unsafe-webgpu"] : []});
const expected = webgpu ? ["running"] : ["no-adapter", "unsupported"];

/**
 * Headless SwiftShader renders but can't present a WebGPU canvas: the first present loses the device ("A valid
 * external Instance reference no longer exists"). With --webgpu, each page's "webgpu" contexts render into an
 * offscreen texture instead, so the engine runs every pass and validation errors still reach the console.
 */
function offscreenWebGpuContexts() {
    const getContext = HTMLCanvasElement.prototype.getContext;
    const offscreen = (canvas) => ({
        canvas,
        device: null,
        texture: null,
        configure(config) {
            this.device = config.device;
        },
        unconfigure() {
            this.texture?.destroy();
            this.texture = null;
        },
        getConfiguration() {
            return this.device ? {device: this.device, format: "rgba8unorm"} : null;
        },
        getCurrentTexture() {
            const {width, height} = canvas;
            if (!this.texture || this.texture.width !== width || this.texture.height !== height) {
                this.texture?.destroy();
                this.texture = this.device.createTexture({
                    size: {width, height},
                    format: "rgba8unorm",
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                });
            }
            return this.texture;
        },
    });
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (type !== "webgpu") {
            return getContext.call(this, type, ...rest);
        }
        this.__offscreen ??= offscreen(this);
        return this.__offscreen;
    };
    if ("gpu" in navigator) {
        navigator.gpu.getPreferredCanvasFormat = () => "rgba8unorm";
    }
}
let failed = 0;
for (const slug of slugs) {
    for (const path of [`/docs/${slug}`, `/review/${slug}`]) {
        const page = await browser.newPage();
        if (webgpu) {
            await page.addInitScript(offscreenWebGpuContexts);
        }
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text().split("\n")[0]));
        await page.goto(`http://localhost:5180${path}`, {waitUntil: "networkidle"});
        await page.waitForTimeout(200);
        const demos = await page.locator("[data-slot=demo-frame], [data-slot=theme-scope]").count();
        // scenes start when scrolled into view: visit each one, then read where it settled
        const canvases = page.locator("[data-slot=glaze-canvas]");
        for (let i = 0; i < (await canvases.count()); i++) {
            await canvases.nth(i).scrollIntoViewIfNeeded();
            await page.waitForTimeout(webgpu ? 1500 : 150);
        }
        const states = await page.$$eval("[data-slot=glaze-canvas]", (els) => els.map((e) => e.dataset.state));
        const wrong = states.filter((s) => !expected.includes(s));
        if (errors.length || demos === 0 || wrong.length) {
            failed++;
            console.log(
                `✗ ${path} (${demos} demo frames, scenes: ${states.join(" ") || "none"})\n  ${[...new Set(errors)].join("\n  ")}`,
            );
        }
        await page.close();
    }
}
await browser.close();
console.log(failed ? `\n${failed} page(s) with problems` : `all ${slugs.length} docs pages clean`);
process.exit(failed ? 1 : 0);
