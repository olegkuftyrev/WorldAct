import { parseVideoEmbed } from "../embeds";
import { enhanceInteractiveBlocks } from "../interactiveBlocks";
import { enhanceNavigationOverlays } from "../navigationOverlays";
import { scrollToMoreFragment } from "../contentFragments";
function enhanceEmbeds(root: ParentNode) {
    for (const wrapper of root.querySelectorAll<HTMLElement>(".wp-block-embed__wrapper")) {
        if (wrapper.querySelector("iframe"))
            continue;
        const embed = parseVideoEmbed((wrapper.textContent || "").trim());
        if (!embed)
            continue;
        const frame = document.createElement("iframe");
        frame.src = embed.src;
        frame.title = embed.title;
        frame.width = String(embed.width);
        frame.height = String(embed.height);
        frame.allowFullscreen = true;
        frame.loading = "lazy";
        frame.referrerPolicy = "strict-origin-when-cross-origin";
        frame.allow = "encrypted-media; picture-in-picture";
        wrapper.replaceChildren(frame);
    }
}
function enhanceArchives(root: ParentNode) {
    const cleanups = [...root.querySelectorAll<HTMLSelectElement>('.wp-block-archives-dropdown select[name="archive-dropdown"]')].map(select => {
        let escapePressed = false;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const keyup = (event: KeyboardEvent) => { escapePressed = event.key === "Escape"; }, click = () => { escapePressed = false; };
        const change = () => { const timer = setTimeout(() => { timers.delete(timer); if (escapePressed || !select.value.startsWith("/") || select.value.startsWith("//"))
            return; try {
            const target = new URL(select.value, location.origin);
            if (target.origin === location.origin && ["http:", "https:"].includes(target.protocol))
                location.assign(target.pathname + target.search + target.hash);
        }
        catch { } }, 250); timers.add(timer); };
        select.addEventListener("keyup", keyup);
        select.addEventListener("click", click);
        select.addEventListener("change", change);
        return () => { select.removeEventListener("keyup", keyup); select.removeEventListener("click", click); select.removeEventListener("change", change); timers.forEach(clearTimeout); };
    });
    return () => cleanups.forEach(cleanup => cleanup());
}
/** Browser-only enhancements never enter the Node public render import graph. */
export function enhancePublicDocument(root: HTMLElement) {
    let active = true;
    const cleanups: Array<() => void> = [];
    enhanceEmbeds(root);
    cleanups.push(enhanceArchives(root), enhanceInteractiveBlocks(root), enhanceNavigationOverlays(root), scrollToMoreFragment(root));
    // The waveform utilities evaluate browser globals. Import only after hydration.
    void import("../playlists").then(({ enhancePlaylists }) => { if (active)
        cleanups.push(enhancePlaylists(root)); }).catch(() => { });
    return () => { active = false; for (const cleanup of cleanups.reverse())
        cleanup(); };
}
