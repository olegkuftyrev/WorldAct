import { PUBLIC_LIFECYCLE_STYLE } from "../../shared/public-lifecycle";
import type { PublicDocumentModel } from "../../shared/public-document";
import { ApiError } from "../api";
declare global {
    interface Window {
        __worldactPublicLifecycle?: {
            generation: number;
            timer?: number;
        };
    }
}
export function installPublicLifecycle() {
    if (!document.head.querySelector('[data-worldact-public-gate]')) {
        const style = document.createElement("style");
        style.dataset.worldactPublicGate = "";
        style.textContent = PUBLIC_LIFECYCLE_STYLE;
        document.head.append(style);
    }
    if (window.__worldactPublicLifecycle)
        return;
    window.__worldactPublicLifecycle = { generation: 0, timer: 0 };
    window.addEventListener("pagehide", () => { retirePublicOwnership(); window.dispatchEvent(new Event("worldact-public-retire")); });
    window.addEventListener("pageshow", event => { if (event.persisted) {
        gatePublicRoot();
        window.dispatchEvent(new Event("worldact-public-restore"));
    } });
}
export function retirePublicOwnership() { gatePublicRoot(); if (window.__worldactPublicLifecycle)
    window.__worldactPublicLifecycle.generation++; }
export const publicPath = () => location.pathname + location.search;
export function gatePublicRoot() {
    document.documentElement.setAttribute("data-worldact-public-gated", "");
    const root = document.getElementById("root");
    if (root)
        root.inert = true;
    if (window.__worldactPublicLifecycle) {
        clearTimeout(window.__worldactPublicLifecycle.timer);
        window.__worldactPublicLifecycle.timer = window.setTimeout(() => {
            if (!document.documentElement.hasAttribute("data-worldact-public-gated") || document.getElementById("worldact-public-failure"))
                return;
            const box = document.createElement("div"), message = document.createElement("p"), retry = document.createElement("button");
            box.id = "worldact-public-failure";
            box.className = "worldact-public-notice";
            box.setAttribute("role", "alert");
            message.textContent = "Unable to load this page safely. Please try again.";
            retry.type = "button";
            retry.textContent = "Try again";
            retry.addEventListener("click", () => location.reload());
            box.append(message, retry);
            document.body.append(box);
        }, 12000);
    }
}
export function exposePublicRoot() {
    if(!document.title)document.title="WorldAct";
    clearTimeout(window.__worldactPublicLifecycle?.timer);
    document.getElementById("worldact-public-failure")?.remove();
    const root = document.getElementById("root");
    if (root)
        root.inert = false;
    document.documentElement.removeAttribute("data-worldact-public-gated");
}
export function validPublicModel(value: unknown, path: string): value is PublicDocumentModel {
    if (!value || typeof value !== "object")
        return false;
    const model = value as Partial<PublicDocumentModel>;
    return model.schema === 1 && model.requestPath === path && [200, 404].includes(model.status || 0) && Boolean(model.route && model.site && model.design && model.presentation && model.head && model.controls && Array.isArray(model.comments));
}
export class ApplicationDocumentRequired extends Error {}
export async function loadPublicDocument(path: string, signal: AbortSignal): Promise<PublicDocumentModel> {
    const response = await fetch("/api/public/document?" + new URLSearchParams({ path }), { credentials: "same-origin", cache: "no-store", signal, headers: { Accept: "application/json" } });
    const value: unknown = await response.json().catch(() => null);
    if(response.status===400 && value && typeof value==="object" && "kind" in value && value.kind==="framework")throw new ApplicationDocumentRequired();
    if ((response.ok || response.status === 404) && validPublicModel(value, path))
        return value;
    const error = value && typeof value === "object" && "error" in value ? String(value.error) : `Request failed (${response.status}).`;
    throw new ApiError(error, response.status);
}
const frameworkPaths = new Set(["/login", "/register", "/check-email", "/privacy/confirm", "/confirm-admin-email", "/confirm-profile-email", "/install", "/lost-password", "/reset-password", "/admin", "/admin/posts", "/admin/posts/categories", "/admin/posts/tags", "/admin/pages", "/admin/media", "/admin/comments", "/admin/users", "/admin/profile", "/admin/settings", "/admin/settings/connectors", "/admin/appearance", "/admin/appearance/editor", "/admin/appearance/menus", "/admin/appearance/fonts", "/admin/plugins", "/admin/tools", "/admin/about"]);
export function isFrameworkPath(path: string) {
    let route: string;
    try {
        route = "/" + new URL(path, "https://worldact.invalid").pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment).replaceAll("/", "%2F")).join("/").toLowerCase();
    }
    catch {
        return false;
    }
    return frameworkPaths.has(route) || /^\/wp-admin(?:\/|$)/.test(route) || /^\/(?:wp-login\.php|preview\/[^/]+|admin\/(?:posts|pages|content|media|users)\/[^/]+)$/.test(route);
}
