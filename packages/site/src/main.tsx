import "./index.css";

import {TooltipProvider} from "@repraze/kernelkit/components/tooltip";
import {ThemeProvider} from "@repraze/kernelkit/provider";
import {createRouter, RouterProvider} from "@tanstack/react-router";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";

import {SITE_THEME, THEME_STORAGE_KEY} from "@/lib/site";
import {routeTree} from "@/router";

const router = createRouter({
    routeTree,
    basepath: import.meta.env.BASE_URL,
    defaultPreload: "intent",
    scrollRestoration: true,
});

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ThemeProvider storageKey={THEME_STORAGE_KEY} defaultTheme={SITE_THEME}>
            <TooltipProvider>
                <RouterProvider router={router} />
            </TooltipProvider>
        </ThemeProvider>
    </StrictMode>,
);
