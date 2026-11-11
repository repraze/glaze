// GUIDELINES.md §6 automated: on every docs page, hover and keyboard-focus each interactive element inside
// the demo frames and report the ones whose look doesn't change (dead hover / invisible focus).
//   node scripts/check-states.mjs [slug…] [--modes=dark,light,dark-hc]
import {existsSync, readdirSync} from "node:fs";
import {homedir} from "node:os";

import {chromium} from "playwright";

const libs = `${homedir()}/.cache/pw-libs/root/usr/lib/x86_64-linux-gnu`;
const env = {...process.env};
if (existsSync(libs)) {
    env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}
const args = process.argv.slice(2);
const modes = (args.find((a) => a.startsWith("--modes="))?.slice(8) ?? "dark,light,dark-hc").split(",");
const docsDir = new URL("../packages/site/src/docs/", import.meta.url).pathname;
const named = args.filter((a) => !a.startsWith("--"));
const slugs = named.length
    ? named
    : readdirSync(docsDir)
          .filter((f) => f.endsWith(".tsx"))
          .map((f) => f.replace(/\.tsx$/, ""));

// Things a user can hover or focus inside demos.
const SELECTOR = [
    "button",
    "a[href]",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role=button]",
    "[role=tab]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=slider]",
    "[tabindex='0']",
]
    .map((s) => `[data-slot=demo-frame] ${s}`)
    .join(",");

// What a user perceives: fills, lines, text, rings/outlines/shadows, decoration.
function look(e) {
    const c = getComputedStyle(e);
    // hover may be drawn on a pseudo-element (hit-area lines) or on the parent (overlay triggers)
    const after = getComputedStyle(e, "::after");
    const before = getComputedStyle(e, "::before");
    const parent = e.parentElement ? getComputedStyle(e.parentElement) : null;
    // ...or on the first child (wrapper buttons around a styled row)
    const child = e.firstElementChild ? getComputedStyle(e.firstElementChild) : null;
    return [
        child?.color,
        child?.backgroundColor,
        after.backgroundColor,
        before.backgroundColor,
        parent?.backgroundColor,
        parent?.borderColor,
        c.backgroundColor,
        c.borderColor,
        c.color,
        c.boxShadow,
        c.outlineStyle + c.outlineColor + c.outlineWidth,
        c.textDecorationLine,
        c.opacity,
    ].join("|");
}

const browser = await chromium.launch({env});
const report = [];
for (const mode of modes) {
    const [m, hc] = mode.split("-");
    for (const slug of slugs) {
        const page = await browser.newPage({viewport: {width: 1440, height: 900}});
        await page.addInitScript((t) => localStorage.setItem("glaze-docs-theme", JSON.stringify(t)), {
            mode: m,
            contrast: hc ? "high" : "normal",
            accent: "orange",
            radius: "xl",
        });
        await page.goto(`http://localhost:5180/docs/${slug}`, {waitUntil: "networkidle"});
        await page.addStyleTag({content: "*,*::before,*::after{transition:none!important;animation:none!important}"});
        const handles = await page.$$(SELECTOR);
        for (const h of handles) {
            try {
                const info = await h.evaluate((e) => ({
                    // scroll containers / panels are focusable for keyboard scrolling but are not "controls";
                    // the current tab/page needs no hover; input-otp's native input is invisible by design
                    container:
                        /^(pre|svg)$/i.test(e.tagName) ||
                        /(-viewport|-content|^tabs-content)$/.test(e.dataset.slot ?? "") ||
                        e.matches("[role=tabpanel]"),
                    current: e.matches(
                        "[aria-selected=true],[aria-expanded=true],[data-popup-open],[aria-current]:not([aria-current=false]),[data-active]:not([data-active=false])",
                    ),
                    invisible: e.matches("[data-slot=input-otp]"),
                    skip:
                        e.matches(":disabled,[aria-disabled=true],[data-disabled],[aria-busy=true],[data-loading]") ||
                        !e.checkVisibility() ||
                        e.closest("[hidden],[inert]") !== null,
                    name: `${e.tagName.toLowerCase()}${e.dataset.slot ? `[${e.dataset.slot}]` : ""}${e.dataset.variant ? `{${e.dataset.variant}}` : ""}${e.matches("[data-pressed],[aria-pressed=true],[data-checked]") ? "(on)" : ""} "${(e.textContent || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "").trim().slice(0, 24)}"`,
                }));
                const box = await h.boundingBox();
                if (info.skip || info.invisible || !box || box.width < 2) {
                    continue;
                }
                await page.mouse.move(0, 0);
                const rest = await h.evaluate(look);
                await h.hover({timeout: 500, force: true});
                await page.waitForTimeout(30);
                const hover = await h.evaluate(look);
                await page.mouse.move(0, 0);
                await page.keyboard.press("Shift");
                await h.focus();
                const focus = await h.evaluate(look);
                await h.evaluate((e) => e.blur());
                const problems = [];
                // native text inputs and links may legitimately have no hover; focus is required for all
                if (hover === rest && !info.container && !info.current && !/^(input|textarea|a)\b/.test(info.name)) {
                    problems.push("no hover");
                }
                if (focus === rest) {
                    problems.push("no visible focus");
                }
                if (problems.length) {
                    report.push(`${mode.padEnd(8)} ${slug.padEnd(18)} ${info.name}: ${problems.join(", ")}`);
                }
            } catch {
                // detached or re-rendered mid-check: skip
            }
        }
        await page.close();
    }
}
await browser.close();
console.log(report.length ? report.join("\n") : "all interactive elements show hover and focus");
console.log(`\n${report.length} problem(s)`);
