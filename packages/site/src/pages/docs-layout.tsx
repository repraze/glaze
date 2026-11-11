import {SiteLayout, SiteSidebar} from "@repraze/kernelkit/components/site-layout";
import {Outlet} from "@tanstack/react-router";

import {DocsNav} from "@/components/docs-nav";

/** The suite's docs layout (kernelkit SiteLayout): sticky nav column + the page (which adds its ToC). */
export function DocsLayout() {
    return (
        <SiteLayout>
            <SiteSidebar>
                <DocsNav />
            </SiteSidebar>
            <Outlet />
        </SiteLayout>
    );
}
