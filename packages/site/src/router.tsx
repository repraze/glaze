import {createRootRoute, createRoute, notFound, Outlet, redirect} from "@tanstack/react-router";

import {SiteFooter} from "@/components/site-footer";
import {SiteHeader} from "@/components/site-header";
import {loadDoc} from "@/lib/docs-index";
import {DocPage} from "@/pages/doc-page";
import {DocsLayout} from "@/pages/docs-layout";
import {HomePage} from "@/pages/home";
import {NotFound} from "@/pages/not-found";
import {ReviewPage} from "@/pages/review-page";

const rootRoute = createRootRoute({
    component: () => (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <div className="flex flex-1 flex-col">
                <Outlet />
            </div>
            <SiteFooter />
        </div>
    ),
    notFoundComponent: NotFound,
});

const homeRoute = createRoute({getParentRoute: () => rootRoute, path: "/", component: HomePage});

const docsRoute = createRoute({getParentRoute: () => rootRoute, path: "/docs", component: DocsLayout});

const docsIndexRoute = createRoute({
    getParentRoute: () => docsRoute,
    path: "/",
    beforeLoad: () => {
        throw redirect({to: "/docs/$slug", params: {slug: "introduction"}});
    },
});

/** Loads the page's own chunk (demos + source) on navigation; intent preload warms it on hover. */
async function docLoader({params}: {params: {slug: string}}) {
    const doc = await loadDoc(params.slug);
    if (!doc) {
        throw notFound();
    }
    return doc;
}

const docRoute = createRoute({getParentRoute: () => docsRoute, path: "$slug", loader: docLoader, component: DocPage});

/** Visual review matrix (GUIDELINES.md §8), outside the site chrome. */
const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/review/$slug",
    loader: docLoader,
    component: ReviewPage,
});

export const routeTree = rootRoute.addChildren([
    homeRoute,
    docsRoute.addChildren([docsIndexRoute, docRoute]),
    reviewRoute,
]);
