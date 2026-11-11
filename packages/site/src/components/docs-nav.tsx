import {
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@repraze/kernelkit/components/sidebar";
import {Link, useRouterState} from "@tanstack/react-router";

import {DOCS_BY_CATEGORY} from "@/lib/docs-index";

/** Docs navigation, shared by the desktop SiteSidebar and the phone SiteHeaderMenu. */
export function DocsNav({onNavigate}: {onNavigate?: () => void}) {
    const pathname = useRouterState({select: (s) => s.location.pathname});
    return (
        <nav aria-label="Docs" className="flex flex-col">
            {DOCS_BY_CATEGORY.map(({category, docs}) => (
                <SidebarGroup key={category}>
                    <SidebarGroupLabel className="font-mono uppercase">{category}</SidebarGroupLabel>
                    <SidebarMenu>
                        {docs.map((doc) => (
                            <SidebarMenuItem key={doc.slug}>
                                <SidebarMenuButton
                                    isActive={pathname.endsWith(`/docs/${doc.slug}`)}
                                    render={<Link to="/docs/$slug" params={{slug: doc.slug}} onClick={onNavigate} />}
                                >
                                    <span>{doc.title}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        ))}
                    </SidebarMenu>
                </SidebarGroup>
            ))}
        </nav>
    );
}
