import {cn} from "@repraze/kernelkit/lib/utils";
import {ThemeScope, type ThemeScopeProps} from "@repraze/kernelkit/provider";
import {useLoaderData} from "@tanstack/react-router";

/** The GUIDELINES.md §8 matrix: every demo of a page in each theme, side by side, for visual review. */
const MATRIX: {label: string; scope: Omit<ThemeScopeProps, "children">}[] = [
    {label: "dark", scope: {mode: "dark", contrast: "normal", accent: "orange", radius: "xl"}},
    {label: "light", scope: {mode: "light", contrast: "normal", accent: "orange", radius: "xl"}},
    {label: "dark · hc", scope: {mode: "dark", contrast: "high", accent: "orange", radius: "xl"}},
    {label: "light · hc", scope: {mode: "light", contrast: "high", accent: "orange", radius: "xl"}},
    {label: "dark · radius-none · cyan", scope: {mode: "dark", contrast: "normal", accent: "cyan", radius: "none"}},
    {label: "light · radius-md · pink", scope: {mode: "light", contrast: "normal", accent: "pink", radius: "md"}},
];

export function ReviewPage() {
    const doc = useLoaderData({from: "/review/$slug"});
    return (
        <div className="flex flex-col gap-6 p-6" data-slot="review">
            <h1 className="font-mono text-lg font-semibold">{doc.title} · review</h1>
            {doc.demos.map((demo) => {
                const Component = demo.component;
                return (
                    <section key={demo.title} className="flex flex-col gap-2">
                        <h2 className="font-mono text-sm text-muted-foreground">{demo.title}</h2>
                        <div className="grid grid-cols-2 gap-px overflow-hidden border bg-border">
                            {MATRIX.map(({label, scope}) => (
                                <ThemeScope key={label} {...scope} className="flex flex-col gap-3 p-4">
                                    <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
                                    <div
                                        className={cn(
                                            "flex min-h-24 flex-1",
                                            demo.layout === "full" ? "" : "items-center justify-center",
                                        )}
                                    >
                                        <Component />
                                    </div>
                                </ThemeScope>
                            ))}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
