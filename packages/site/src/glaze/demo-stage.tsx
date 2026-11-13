import {Badge} from "@repraze/kernelkit/components/badge";
import {Label} from "@repraze/kernelkit/components/label";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@repraze/kernelkit/components/select";
import {Slider} from "@repraze/kernelkit/components/slider";
import {Switch} from "@repraze/kernelkit/components/switch";
import {ToggleGroup, ToggleGroupItem} from "@repraze/kernelkit/components/toggle-group";
import {cn} from "@repraze/kernelkit/lib/utils";
import {type ReactNode, useId} from "react";

/**
 * A live scene in a docs demo frame (layout "full"): the canvas, with its controls beside it from `xl` and
 * under it below. The frame clips the canvas to its corners, so nothing inside needs its own radius.
 */
export function DemoStage({
    children,
    controls,
    className,
}: {
    children: ReactNode;
    controls?: ReactNode;
    className?: string;
}) {
    return (
        <div className="flex flex-col xl:flex-row">
            <div className={cn("relative h-80 min-w-0 sm:h-96 xl:h-auto xl:min-h-96 xl:flex-1", className)}>
                {children}
            </div>
            {controls ? (
                <div
                    data-slot="demo-controls"
                    className="flex flex-col gap-4 border-t border-border p-4 xl:w-60 xl:shrink-0 xl:border-t-0 xl:border-l"
                >
                    {controls}
                </div>
            ) : null}
        </div>
    );
}

/** A labelled slider with its value read out in mono. */
export function ControlSlider({
    label,
    value,
    onChange,
    min = 0,
    max = 1,
    step = 0.01,
    format = (v) => String(v),
}: {
    label: string;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    format?: (value: number) => string;
}) {
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <Label>{label}</Label>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{format(value)}</span>
            </div>
            <Slider
                value={value}
                onValueChange={(v) => onChange(v as number)}
                min={min}
                max={max}
                step={step}
                aria-label={label}
            />
        </div>
    );
}

/** A label with a switch at the end of the row. */
export function ControlSwitch({
    label,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    const id = useId();
    return (
        <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id}>{label}</Label>
            <Switch id={id} size="sm" checked={checked} onCheckedChange={onChange} />
        </div>
    );
}

export interface ControlOption<T extends string> {
    value: T;
    label: string;
}

/** A labelled select over a few named options. */
export function ControlSelect<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: readonly ControlOption<T>[];
    onChange: (value: T) => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            <Label>{label}</Label>
            <Select
                items={options as ControlOption<T>[]}
                value={value}
                onValueChange={(next) => {
                    if (next !== null) {
                        onChange(next as T);
                    }
                }}
            >
                <SelectTrigger size="sm" className="w-full" aria-label={label}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                            {o.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

/** A labelled segmented control (one of two to four short options). */
export function ControlSegmented<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: readonly ControlOption<T>[];
    onChange: (value: T) => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            <Label>{label}</Label>
            <ToggleGroup
                variant="outline"
                size="sm"
                value={[value]}
                onValueChange={(next) => {
                    const picked = next[0];
                    if (picked !== undefined) {
                        onChange(picked as T);
                    }
                }}
                aria-label={label}
                className="w-full"
            >
                {options.map((o) => (
                    <ToggleGroupItem key={o.value} value={o.value} className="flex-1">
                        {o.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
        </div>
    );
}

/** A small caption that groups the controls under it. */
export function ControlGroup({label, children}: {label: string; children: ReactNode}) {
    return (
        <div className="flex flex-col gap-3">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

/**
 * Facts about the scene (counts, timings) as outline badges that wrap: one badge per fact, so a narrow panel
 * stacks them instead of overflowing. A spinner stands in while `facts` is null.
 */
export function ControlStats({facts, pending}: {facts: readonly string[] | null; pending?: ReactNode}) {
    return (
        <div data-slot="demo-stats" className="flex min-w-0 flex-wrap items-center gap-1">
            {facts === null
                ? pending
                : facts.map((fact) => (
                      <Badge key={fact} variant="outline" className="max-w-full">
                          <span className="truncate">{fact}</span>
                      </Badge>
                  ))}
        </div>
    );
}
