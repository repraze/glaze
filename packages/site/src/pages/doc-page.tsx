import {Badge} from "@repraze/kernelkit/components/badge";
import {
    PageHeader,
    PageHeaderDescription,
    PageHeaderEyebrow,
    PageHeaderTitle,
} from "@repraze/kernelkit/components/page-header";
import {Pager, PagerLink} from "@repraze/kernelkit/components/pager";
import {SiteAside, SiteMain} from "@repraze/kernelkit/components/site-layout";
import {Toc, TocItem, TocList, TocTitle, useTocActive} from "@repraze/kernelkit/components/toc";
import {Link, useLoaderData} from "@tanstack/react-router";
import {ExternalLinkIcon} from "lucide-react";

import {Demo, PropsTable, slugify} from "@/lib/doc-kit";
import {DOCS, DOCS_BY_SLUG} from "@/lib/docs-index";
import {GITHUB_URL, usePageTitle} from "@/lib/site";

export function DocPage() {
    const doc = useLoaderData({from: "/docs/$slug"});
    usePageTitle(doc.title);
    const meta = DOCS_BY_SLUG.get(doc.slug);
    const index = meta ? DOCS.indexOf(meta) : -1;
    const prev = DOCS[index - 1];
    const next = DOCS[index + 1];
    const Notes = doc.notes;

    const sections = [
        ...doc.demos.map((demo) => ({id: slugify(demo.title), title: demo.title})),
        ...(doc.sections ?? []),
        ...(doc.props?.length ? [{id: "api", title: "API"}] : []),
    ];
    const active = useTocActive(sections.map((s) => s.id));

    return (
        <>
            <SiteMain>
                <PageHeader>
                    <PageHeaderEyebrow>
                        <Badge variant="outline">{doc.category}</Badge>
                        {doc.engineFile ? (
                            <Badge
                                variant="secondary"
                                className="font-mono"
                                render={
                                    <a
                                        href={`${GITHUB_URL}/blob/main/packages/glaze/src/${doc.engineFile}`}
                                        target="_blank"
                                        rel="noreferrer"
                                    />
                                }
                            >
                                {doc.engineFile} <ExternalLinkIcon />
                            </Badge>
                        ) : null}
                    </PageHeaderEyebrow>
                    <PageHeaderTitle>{doc.title}</PageHeaderTitle>
                    <PageHeaderDescription>{doc.description}</PageHeaderDescription>
                </PageHeader>

                {doc.demos.map((demo, i) => (
                    <Demo key={demo.title} demo={demo} code={doc.demoSources[i] ?? ""} />
                ))}

                {Notes ? (
                    <div className="flex flex-col gap-4">
                        <Notes />
                    </div>
                ) : null}

                {doc.props?.length ? (
                    <section id="api" className="flex scroll-mt-24 flex-col gap-6">
                        <h2 className="font-heading text-xl font-semibold">API</h2>
                        {doc.props.map((p) => (
                            <PropsTable key={p.component} {...p} />
                        ))}
                    </section>
                ) : null}

                <Pager>
                    {prev ? (
                        <PagerLink direction="previous" render={<Link to="/docs/$slug" params={{slug: prev.slug}} />}>
                            {prev.title}
                        </PagerLink>
                    ) : null}
                    {next ? (
                        <PagerLink direction="next" render={<Link to="/docs/$slug" params={{slug: next.slug}} />}>
                            {next.title}
                        </PagerLink>
                    ) : null}
                </Pager>
            </SiteMain>
            {sections.length > 1 ? (
                <SiteAside>
                    <Toc>
                        <TocTitle>On this page</TocTitle>
                        <TocList>
                            {sections.map((s) => (
                                <TocItem key={s.id} href={`#${s.id}`} active={s.id === active}>
                                    {s.title}
                                </TocItem>
                            ))}
                        </TocList>
                    </Toc>
                </SiteAside>
            ) : null}
        </>
    );
}
