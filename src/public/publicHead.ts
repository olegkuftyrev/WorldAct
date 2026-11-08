import type { PublicHead } from "../../shared/public-document";
/** Adopt only the public head nodes emitted by the server, and remove them on departure. */
export function applyPublicHead(head: PublicHead) {
    document.head.querySelectorAll('[data-worldact-public-head],[data-worldact-default-head]').forEach(node => node.remove());
    document.title = head.title;
    const title=document.head.querySelector("title");if(title)title.dataset.worldactPublicHead="";
    const nodes: HTMLElement[] = title ? [title] : [];
    const meta = (name: string, content: string, property = false) => { const node = document.createElement("meta"); node.setAttribute(property ? "property" : "name", name); node.content = content; node.dataset.worldactPublicHead = ""; document.head.append(node); nodes.push(node); };
    const link = (rel: string, href: string, sizes?: string) => { const node = document.createElement("link"); node.rel = rel; node.href = href; if (sizes)
        node.sizes = sizes; node.dataset.worldactPublicHead = ""; document.head.append(node); nodes.push(node); };
    if (head.robots)
        meta("robots", head.robots);
    if (head.canonical)
        link("canonical", head.canonical);
    if(head.pingback)link("pingback",head.pingback);
    if (head.seo) {
        const seo = head.seo;
        meta("description", seo.description);
        meta("og:title", seo.title, true);
        meta("og:description", seo.description, true);
        meta("og:type", seo.type, true);
        meta("og:url", seo.url, true);
        if (seo.image)
            meta("og:image", seo.image, true);
    }
    for (const icon of head.icons)
        link(icon.rel, icon.href, icon.sizes);
    if (head.tileImage)
        meta("msapplication-TileImage", head.tileImage);
    return () => nodes.forEach(node => node.remove());
}
