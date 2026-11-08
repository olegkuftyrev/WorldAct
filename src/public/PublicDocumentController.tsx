import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PublicDocumentModel } from "../../shared/public-document";
import { api, ApiError, json } from "../api";
import { errorText, ResourceState } from "../components/PublicPrimitives";
import { PublicDocumentView, initialPublicInteraction, type PublicDocumentActions, type PublicInteractionState } from "./PublicDocumentView";
import { gatePublicRoot, exposePublicRoot, loadPublicDocument, publicPath } from "./publicOwnership";
import { applyPublicHead } from "./publicHead";
import { enhancePublicDocument } from "./publicEnhancers";
type Owner = {
    path: string;
    generation: number;
    sequence: number;
    lifecycle: number;
};
export default function PublicDocumentController({ initialModel, initialError = "", generation }: {
    initialModel: PublicDocumentModel | null;
    initialError?: string;
    generation: number;
}) {
    const location = useLocation(), navigate = useNavigate(), path = location.pathname + location.search;
    const ownerRef = useRef<Owner>({ path, generation, sequence: 0, lifecycle: window.__worldactPublicLifecycle?.generation || 0 });
    if (ownerRef.current.path !== path || ownerRef.current.generation !== generation)
        ownerRef.current = { path, generation, sequence: ownerRef.current.sequence + 1, lifecycle: window.__worldactPublicLifecycle?.generation || 0 };
    const edits=useRef(0);
    const owner = ownerRef.current, pending = useRef<AbortController | null>(null), alive = useRef(false), request = useRef(0), mutation = useRef(false);
    const [snapshot, setDocument] = useState<{
        owner: Owner;
        model: PublicDocumentModel | null;
        error: string;
    }>({ owner, model: initialModel?.requestPath === path ? initialModel : null, error: initialError });
    const [interaction, setInteraction] = useState(() => initialModel ? initialPublicInteraction(initialModel) : null);
    const model = snapshot.owner === owner ? snapshot.model : null, state = interaction && model ? interaction : model ? initialPublicInteraction(model) : null;
    const modelRef = useRef(model), stateRef = useRef(state);
    modelRef.current = model;
    stateRef.current = state;
    const [feedbackForm, setFeedbackForm] = useState<{
        owner: Owner;
        form: HTMLFormElement;
    } | null>(null);
    const localError = Boolean(state?.error && feedbackForm?.owner === owner && feedbackForm.form.isConnected);
    const sourceRoot = useRef<HTMLDivElement>(null), replyFocus = useRef<Owner | null>(null);
    const current = (captured: Owner) => alive.current && ownerRef.current === captured && publicPath() === captured.path && (window.__worldactPublicLifecycle?.generation || 0) === captured.lifecycle;
    const refresh = async (captured: Owner, reset = false) => {
        if (!current(captured))
            return;
        pending.current?.abort();
        const number = ++request.current, abort = new AbortController();
        pending.current = abort;
        try {
            const fresh = await loadPublicDocument(captured.path, abort.signal);
            if (!current(captured) || number !== request.current)
                return;
            setDocument({ owner: captured, model: fresh, error: "" });
            if (reset)
                setInteraction(initialPublicInteraction(fresh));
        }
        catch (error) {
            if (current(captured) && number === request.current)
                setDocument({ owner: captured, model: null, error: errorText(error) });
        }
    };
    useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; pending.current?.abort(); }; }, []);
    useEffect(() => {
        // The boot model is consumed only by the first matching owner. Every departed
        // route/account and every restoration gets a fresh request-scoped model.
        if (snapshot.owner === owner && (snapshot.model || snapshot.error))
            return;
        gatePublicRoot();
        setInteraction(null);
        mutation.current = false;
        setFeedbackForm(null);
        void refresh(owner, true);
    }, [owner]);
    useLayoutEffect(() => { if (localError)
        feedbackForm?.form.querySelector<HTMLElement>('[data-worldact-comment-error]')?.scrollIntoView({ block: "nearest" }); }, [localError, state?.error, feedbackForm]);
    useLayoutEffect(() => {
        if (!model || !state)
            return;
        documentBody();
        const cleanup = applyPublicHead(model.head);
        exposePublicRoot();
        return cleanup;
    }, [model]);
    useLayoutEffect(() => { if (snapshot.owner === owner && snapshot.error) {
        documentBody();
        exposePublicRoot();
    } }, [snapshot, owner]);
    useEffect(() => {
        if (!model)
            return;
        const root = documentRoot();
        if (!root)
            return;
        const cleanup = enhancePublicDocument(root);
        let active = true;
        const nativeSubmit = (event: Event) => {
            if (event.defaultPrevented)
                return;
            const form = event.target;
            if (!(form instanceof HTMLFormElement) || !form.closest("[data-worldact-public-island]"))
                return;
            if (form.matches("form.worldact-native-password-form")) {
                event.preventDefault();
                void unlockForm(form, owner);
            }
            else if (form.matches("form.worldact-native-comment-form, .wp-block-post-comments-form form, form.comment-form")) {
                event.preventDefault();
                void submitForm(form, owner);
            }
            else if (form.getAttribute("action") === "/logout") {
                event.preventDefault();
                void logout(owner);
            }
        };
        const click = (event: Event) => {
            const mouse = event as globalThis.MouseEvent;
            if (mouse.defaultPrevented || mouse.button || mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey)
                return;
            const target = mouse.target;
            if (!(target instanceof Element) || !target.closest("[data-worldact-public-island]"))
                return;
            const reply = target.closest<HTMLAnchorElement>("[data-comment-reply]"), cancel = target.closest<HTMLElement>("[data-comment-cancel]");
            if (reply || cancel) {
                const form = root.querySelector<HTMLFormElement>("form.worldact-native-comment-form, .wp-block-post-comments-form form, form.comment-form");
                if (!form)
                    return;
                mouse.preventDefault();
                const id = Number(reply?.dataset.commentReply) || 0;
                let parent = form.querySelector<HTMLInputElement>('[name="parentId"],[name="comment_parent"]');
                if (!parent) {
                    parent = document.createElement("input");
                    parent.type = "hidden";
                    parent.name = "parentId";
                    form.append(parent);
                }
                parent.value = String(id);
                retireRead();edits.current++;
                patch({ reply: reply ? { id, name: reply.dataset.commentAuthor || "comment" } : null, notice: reply ? `Replying to ${reply.dataset.commentAuthor || "comment"}.` : "" }, owner);
                form.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                form.scrollIntoView({ behavior: "smooth", block: "center" });
                return;
            }
            navigateAnchor(mouse);

        };
        const input=(event:Event)=>{if(event.target instanceof Element && event.target.closest("[data-worldact-public-island]") && event.target.closest("form")){retireRead();edits.current++;}};
        root.addEventListener("input",input);
        root.addEventListener("submit", nativeSubmit);
        root.addEventListener("click", click);
        const parent = root.querySelector<HTMLInputElement>('form.worldact-native-comment-form [name="parentId"],form.comment-form [name="comment_parent"]');
        if (parent)
            parent.value = String(stateRef.current?.reply?.id || 0);
        if (replyFocus.current !== owner && model.controls.replyParentId) {
            replyFocus.current = owner;
            root.querySelector<HTMLTextAreaElement>('form.worldact-native-comment-form textarea,#comment-content')?.focus();
        }
        if (!model.viewer && model.site.settings.commentCookieConsent !== false)
            void api<{
                author: PublicInteractionState["comment"] | null;
            }>("/public/comment-author").then(({ author }) => {
                if (!active || !current(owner) || !author)
                    return;
                if (model.presentation.kind === "source") {
                    const checkbox = root.querySelector<HTMLInputElement>('input[name="rememberAuthor"],input[name="wp-comment-cookies-consent"]');
                    if (!checkbox)
                        return;
                    for (const key of ["authorName", "authorEmail", "authorUrl"] as const) {
                        const field = root.querySelector<HTMLInputElement>(`input[name="${key}"]`);
                        if (field && !field.value)
                            field.value = author[key] || "";
                    }
                    checkbox.checked = true;
                }
                else
                    setInteraction(previous => previous ? { ...previous, comment: { ...previous.comment, authorName: previous.comment.authorName || author.authorName, authorEmail: previous.comment.authorEmail || author.authorEmail, authorUrl: previous.comment.authorUrl || author.authorUrl }, rememberAuthor: true } : previous);
            }).catch(() => { });
        return () => { active = false; cleanup(); root.removeEventListener("submit", nativeSubmit); root.removeEventListener("click", click);root.removeEventListener("input",input); };
    }, [model, owner, navigate]);
    function retireRead(){request.current++;pending.current?.abort();pending.current=null;}
    function edit(values:Partial<PublicInteractionState>,captured:Owner){if(!current(captured))return;retireRead();edits.current++;patch(values,captured);}
    function navigateAnchor(event:Pick<globalThis.MouseEvent,"defaultPrevented"|"button"|"metaKey"|"ctrlKey"|"shiftKey"|"altKey"|"target"|"preventDefault">){
        if(event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element))return;
        const anchor=event.target.closest<HTMLAnchorElement>("a[href]");if(!anchor || anchor.hasAttribute("download") || anchor.target && anchor.target!=="_self" || anchor.rel.split(/\s+/).includes("external"))return;
        let url:URL;try{url=new URL(anchor.href,window.location.origin);}catch{return;}
        if(url.origin!==window.location.origin || !["http:","https:"].includes(url.protocol) || /^\/(?:api|uploads|vendor|assets|wp-json|feed|comments\/feed|sitemap\.xml|robots\.txt)(?:\/|$)/.test(url.pathname))return;
        if(url.pathname===location.pathname && url.search===location.search){if(!url.hash){event.preventDefault();window.scrollTo(0,0);}return;}
        event.preventDefault();gatePublicRoot();navigate(url.pathname+url.search+url.hash);window.scrollTo(0,0);
    }
    function patch(values: Partial<PublicInteractionState>, captured: Owner) { if (current(captured))
        setInteraction(previous => ({ ...previous || initialPublicInteraction(modelRef.current!), ...values })); }
    async function submitForm(form: HTMLFormElement, captured: Owner) {
        if (!current(captured) || mutation.current)
            return;
        const post = modelRef.current?.post;
        const data = new FormData(form), value = (...names: string[]) => names.map(name => data.get(name)).find(item => typeof item === "string" && item) || "";
        const postId = Number(value("postId", "comment_post_ID") || post?.id);
        if (!Number.isSafeInteger(postId) || postId < 1)
            return;
        retireRead();const submittedEdits=edits.current;
        mutation.current = true;
        patch({ busy: true, error: "", notice: "" }, captured);
        try {
            const result = await api<{
                comment: {
                    id: number;
                    status: string;
                };
            }>("/public/comments", json("POST", { postId, parentId: Number(value("parentId", "comment_parent")) || null, authorName: String(value("authorName", "author")), authorEmail: String(value("authorEmail", "email")), authorUrl: String(value("authorUrl", "url")), content: String(value("content", "comment")), ...(form.querySelector('input[name="rememberAuthor"],input[name="wp-comment-cookies-consent"]') ? { rememberAuthor: data.has("rememberAuthor") || data.has("wp-comment-cookies-consent") } : {}) }));
            if (!current(captured))
                return;
            const remembered = data.has("rememberAuthor") || data.has("wp-comment-cookies-consent");
            const untouched=edits.current===submittedEdits;
            if (untouched && modelRef.current?.presentation.kind === "source") {
                if (remembered) {
                    const field = form.querySelector<HTMLTextAreaElement>("textarea");
                    if (field)
                        field.value = "";
                }
                else
                    form.reset();
                const parent = form.querySelector<HTMLInputElement>('[name="parentId"],[name="comment_parent"]');
                if (parent)
                    parent.value = "0";
            }
            patch({notice:result.comment.status==="approved" ? "Your comment has been published.":"Your comment is awaiting moderation.",...(untouched?{reply:null,comment:remembered ? {...stateRef.current!.comment,content:""}:{authorName:"",authorEmail:"",authorUrl:"",content:""}}:{})},captured);
            if(untouched && result.comment.status==="approved")void refresh(captured);

        }
        catch (error) {
            if (current(captured)) {
                if(modelRef.current?.presentation.kind === "source") setFeedbackForm({ owner: captured, form });
                patch({ error: errorText(error) }, captured);
            }
        }
        finally {
            if (current(captured)) {
                mutation.current = false;
                patch({ busy: false }, captured);
            }
        }
    }
    async function unlockForm(form: HTMLFormElement, captured: Owner) {
        if (!current(captured) || mutation.current)
            return;
        const selected = modelRef.current?.post, data = new FormData(form), slug = String(data.get("postSlug") || selected?.slug || "");
        if (!slug)
            return;
        retireRead();
        mutation.current = true;
        patch({ busy: true, error: "" }, captured);
        try {
            const result = await api<{
                post: {
                    id: number;
                };
            }>(`/public/posts/${encodeURIComponent(slug)}/unlock`, json("POST", { password: String(data.get("password") || "") }));
            if (!current(captured))
                return;
            if (selected && slug === selected.slug && result.post.id !== selected.id)
                throw new ApiError("Post not found.", 404);
            patch({ password: "" }, captured);
            await refresh(captured);
        }
        catch (error) {
            patch({ error: errorText(error) }, captured);
        }
        finally {
            if (current(captured)) {
                mutation.current = false;
                patch({ busy: false }, captured);
            }
        }
    }
    async function logout(captured: Owner) { if (!current(captured) || mutation.current)
        return; mutation.current = true; try {
        await api("/auth/logout", json("POST"));
    }
    catch (error) {
        patch({ error: errorText(error) }, captured);
        if (current(captured))
            mutation.current = false;
    } }
    if (!model || !state)
        return snapshot.owner === owner && snapshot.error ? <div className="public-site"><main className="site-main"><ResourceState loading={false} error={snapshot.error} retry={() => { gatePublicRoot(); void refresh(owner, true); }}/></main></div> : null;
    const actions: PublicDocumentActions = { sourceRoot, navigate:navigateAnchor, submit: event => { event.preventDefault(); void submitForm(event.currentTarget, owner); }, unlock: event => { event.preventDefault(); void unlockForm(event.currentTarget, owner); }, logout: event => { event.preventDefault(); void logout(owner); }, reply: reply => { edit({ reply }, owner); if(reply){document.getElementById("comment-reply-title")?.scrollIntoView({ block: "center" }); document.getElementById("comment-content")?.focus({ preventScroll: true });} }, comment: comment => edit({ comment }, owner), password: password => edit({ password }, owner), rememberAuthor: rememberAuthor => edit({ rememberAuthor }, owner), publicSearch: publicSearch => edit({ publicSearch }, owner), search: event => { event.preventDefault(); const query = new URLSearchParams(new FormData(event.currentTarget) as unknown as URLSearchParams); const target = location.pathname + (query.size ? "?" + query : ""); if (target !== path) {
            gatePublicRoot();
            navigate(target);
        } } };
    return <><PublicDocumentView model={model} state={{ ...state, errorLocal: localError }} actions={actions}/>{localError && feedbackForm && createPortal(<div className="worldact-public-notice" role="alert" data-worldact-comment-error="true">{state.error}</div>, feedbackForm.form)}</>;
}
function documentRoot() { return document.getElementById("root")?.querySelector<HTMLElement>(".public-site") || null; }
function documentBody() { document.body.className = "public-body"; document.body.style.removeProperty("--wp-admin-theme-color"); document.getElementById("worldact-admin-color-scheme")?.remove(); }
