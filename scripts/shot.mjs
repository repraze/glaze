// Screenshot a docs page against the running dev server (:5180).
//
//   node scripts/shot.mjs <path> <out.png> [options]
//
//   --theme=dark|light  --hc  --accent=<name>  --radius=none|sm|md|lg|xl   site theme (default dark/orange/xl)
//   --webgpu            enable WebGPU (SwiftShader, CPU: let scenes settle with --wait=2000)
//   --width=1440 --height=900  --full                                          viewport / full page
//   --el=<selector>     screenshot only this element (first match), e.g. "[data-slot=demo-frame]"
//   --nth=<n>           which match of --el (0-based)
//   --hover=<selector>  hover this element first
//   --focus=<selector>  keyboard-focus this element (focus-visible)
//   --click=<selector>  click this element first (open overlays)
//   --rclick=<selector> right-click (context menus)
//   --wait=<ms>         extra wait before the shot (hover cards open after ~600ms)
//   --press=<keys>      press keys after, comma separated (e.g. "ArrowDown,ArrowDown")
//
// Review matrix of every demo in 6 themes: node scripts/shot.mjs /review/<slug> out.png --full
import {existsSync} from "node:fs";
import {homedir} from "node:os";

import {chromium} from "playwright";

// No sudo for `playwright install-deps`: use Chromium's shared libs extracted to ~/.cache/pw-libs if present.
const libs = `${homedir()}/.cache/pw-libs/root/usr/lib/x86_64-linux-gnu`;
const env = {...process.env};
if (existsSync(libs)) {
    env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

const [path = "/", out = "shot.png", ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(
    flags.map((f) => {
        const [k, ...v] = f.replace(/^--/, "").split("=");
        return [k, v.length ? v.join("=") : true];
    }),
);
const theme = {
    mode: opt.theme ?? "dark",
    contrast: opt.hc ? "high" : "normal",
    accent: opt.accent ?? "orange",
    radius: opt.radius ?? "xl",
};
// WebGPU in headless runs on SwiftShader (CPU Vulkan). The compositor must be on the same Vulkan too (ANGLE on
// Vulkan), or the WebGPU canvas renders but never reaches the screenshot.
const WEBGPU_ARGS = [
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
    "--use-angle=vulkan",
];
const browser = await chromium.launch({env, args: opt.webgpu ? WEBGPU_ARGS : []});
const page = await browser.newPage({
    viewport: {width: Number(opt.width ?? 1440), height: Number(opt.height ?? 900)},
    deviceScaleFactor: Number(opt.dpr ?? 1),
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().split("\n")[0]));
await page.addInitScript((t) => localStorage.setItem("glaze-docs-theme", JSON.stringify(t)), theme);
await page.goto(`http://localhost:5180${path}`, {waitUntil: "networkidle"});
await page.waitForTimeout(250);
if (opt.hover) {
    await page.locator(opt.hover).first().hover();
}
if (opt.focus) {
    await page.keyboard.press("Shift");
    await page.locator(opt.focus).first().focus();
}
if (opt.click) {
    await page.locator(opt.click).first().click();
}
if (opt.rclick) {
    await page.locator(opt.rclick).first().click({button: "right"});
}
if (opt.press) {
    for (const key of String(opt.press).split(",")) {
        await page.keyboard.press(key);
    }
}
await page.waitForTimeout(350 + Number(opt.wait ?? 0));
if (opt.el) {
    await page
        .locator(opt.el)
        .nth(Number(opt.nth ?? 0))
        .screenshot({path: out});
} else {
    await page.screenshot({path: out, fullPage: Boolean(opt.full)});
}
await browser.close();
if (errors.length) {
    console.log(`ERRORS (${errors.length}):\n${[...new Set(errors)].join("\n")}`);
}
console.log("saved", out);
