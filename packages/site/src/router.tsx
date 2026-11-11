import {DocPage, DocsLayout, ReviewMatrix, reviewScopes} from "@repraze/kernelkit/docs";
import {SuiteFooter, usePageTitle} from "@repraze/kernelkit/site";
import {createRootRoute, createRoute, notFound, Outlet, redirect, useLoaderData} from "@tanstack/react-router";

import {docLink, SiteDocsNav, SiteHeader} from "@/components/site-header";
import {DOCS_INDEX} from "@/lib/docs-index";
import {GITHUB_URL, NPM_URL, SITE_NAME, SITE_THEME} from "@/lib/site";
import {HomePage} from "@/pages/home";
import {NotFound} from "@/pages/not-found";

const rootRoute = createRootRoute({
    component: () => (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <div className="flex flex-1 flex-col">
                <Outlet />
            </div>
            <SuiteFooter
                credits={["kernelkit", "termicolor"]}
                links={[
                    {label: "Docs", render: docLink("introduction")},
                    {label: "Pipeline", render: docLink("pass-chain")},
                    {label: "npm", href: NPM_URL},
                    {label: "GitHub", href: GITHUB_URL},
                ]}
            />
        </div>
    ),
    notFoundComponent: NotFound,
});

const homeRoute = createRoute({getParentRoute: () => rootRoute, path: "/", component: HomePage});

const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docs",
    component: () => (
        <DocsLayout nav={<SiteDocsNav />}>
            <Outlet />
        </DocsLayout>
    ),
});

const docsIndexRoute = createRoute({
    getParentRoute: () => docsRoute,
    path: "/",
    beforeLoad: () => {
        throw redirect({to: "/docs/$slug", params: {slug: "introduction"}});
    },
});

/** Loads the page's own chunk (demos + source) on navigation; intent preload warms it on hover. */
async function docLoader({params}: {params: {slug: string}}) {
    const doc = await DOCS_INDEX.loadDoc(params.slug);
    if (!doc) {
        throw notFound();
    }
    return doc;
}

function DocRoute() {
    const doc = useLoaderData({from: "/docs/$slug"});
    usePageTitle(doc.title, SITE_NAME);
    return <DocPage doc={doc} index={DOCS_INDEX} linkFor={docLink} />;
}

const docRoute = createRoute({getParentRoute: () => docsRoute, path: "$slug", loader: docLoader, component: DocRoute});

/** Visual review matrix (KernelKit GUIDELINES.md §8): the site's orange/xl first, then a pink/md variant. */
const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/review/$slug",
    loader: docLoader,
    component: function ReviewRoute() {
        const doc = useLoaderData({from: "/review/$slug"});
        return (
            <ReviewMatrix
                doc={doc}
                scopes={reviewScopes(SITE_THEME, [
                    {mode: "dark", accent: "cyan", radius: "none"},
                    {mode: "light", accent: "pink", radius: "md"},
                ])}
            />
        );
    },
});

export const routeTree = rootRoute.addChildren([
    homeRoute,
    docsRoute.addChildren([docsIndexRoute, docRoute]),
    reviewRoute,
]);
