import PostTemplateSelect from "../components/PostTemplateSelect";
import { postLink } from "../publicLinks";
import { postFormats, type Author, type PostFormat } from "./PostBulkEdit";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  ApiError,
  json,
  date,
  type Post,
  type Media,
  type Term,
  type Revision,
  type Autosave,
  type SerializedBlock,
  type Footnote,
  type Settings,
} from "../api";
import {
  Session,
  Brand,
  Icon,
  Notice,
  ResourceState,
  Modal,
  errorText,
  useResource,
} from "../components/AdminUI";
import GutenbergEditor, {type GutenbergEditorHandle} from "../editor/GutenbergEditor";
import EditorOptions from "../editor/EditorOptions";
import { useEditorPreferences } from "../editor/EditorPreferences";
import { useEditorShortcuts } from "../editor/editorShortcuts";
import type { EditorPreferencePatch } from "../editor/preferenceQueue";
import { documentRecovery, editorOwnerMatches, editorTargetMatches } from "../editor/documentRecovery";
import { formatPostCivil } from "../../shared/post-civil-date";
import { publicationActionInstant, publicationDateChange, publicationDatePayload } from "../editor/publicationDate";

type DocumentState = {
  title: string;
  content: string;
  blocks: SerializedBlock[] | null;
  footnotes: Footnote[];
  excerpt: string;
  slug: string;
  status: Post["status"];
  scheduledAt: string;
  postDate: string;
  postDateOriginal: string;
  postDateGmt: string | null;
  postDateIntent?: string | null;
  visibility: "public" | "private" | "password";
  password?: string;
  categoryIds: number[];
  tagIds: number[];
  featuredMediaId: number | null;
  parentId: number | null;
  menuOrder: number;
  templateSlug: string;
  authorId?: number;
  format?: PostFormat;
  commentStatus?: "open" | "closed";
  pingStatus?: "open" | "closed";
  sticky: boolean;
};
const emptyDocument = (): DocumentState => ({
  title: "",
  content: "",
  blocks: null,
  footnotes: [],
  excerpt: "",
  slug: "",
  status: "draft",
  scheduledAt: "",
  postDate: "",
  postDateOriginal: "",
  postDateGmt: null,
  visibility: "public",
  categoryIds: [],
  tagIds: [],
  featuredMediaId: null,
  parentId: null,
  menuOrder: 0,
  templateSlug: "",
  sticky: false,
});
const postDocument = (post: Post): DocumentState => ({
  title: post.title,
  content: (post as Post & { rawContent?: string }).rawContent || post.content,
  blocks: post.blocks || null,
  footnotes: post.footnotes || [],
  excerpt: post.excerpt,
  slug: post.slug,
  status: post.status,
  scheduledAt: post.scheduledAt || "",
  postDate: post.postDate,
  postDateOriginal: post.postDate,
  postDateGmt: post.postDateGmt,
  visibility:
    post.status === "private"
      ? "private"
      : post.hasPassword
        ? "password"
        : "public",
  categoryIds:
    post.categoryIds || post.categories?.map((term) => term.id) || [],
  tagIds: post.tagIds || post.tags?.map((term) => term.id) || [],
  featuredMediaId: post.featuredMediaId || null,
  parentId: post.parentId || null,
  menuOrder: post.menuOrder || 0,
  templateSlug: post.templateSlug || "",
  commentStatus: post.commentStatus || "open",
  pingStatus:
    (post as Post & { pingStatus?: "open" | "closed" }).pingStatus || "closed",
  authorId: post.authorId,
  format: post.format || "standard",
  sticky: post.sticky || false,
});
const statuses: Record<Post["status"], string> = {
  publish: "Published",
  draft: "Draft",
  pending: "Pending Review",
  future: "Scheduled",
  private: "Private",
  trash: "Trash",
};
type Recovery = Autosave & { source: "server" | "browser" };

type EditingLease = {
  userId: number;
  displayName: string;
  expiresAt: string;
  owned: boolean;
};
function usePostEditLease(postId: number | null, userId: number | undefined) {
  const [status, setStatus] = useState<
    "checking" | "owned" | "blocked" | "error"
  >(postId ? "checking" : "owned");
  const [lock, setLock] = useState<EditingLease | null>(null),
    [error, setError] = useState("");
  const [dialog, setDialog] = useState(false),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    owned = useRef<number | null>(null),
    currentId = useRef(postId),
    lastForeignOwner = useRef<number | null>(null);
  currentId.current = postId;
  const applyForeignLock = useCallback((value: EditingLease) => {
    owned.current = null;
    setLock(value);
    setStatus("blocked");
    setError("");
    if (lastForeignOwner.current !== value.userId) setDialog(true);
    lastForeignOwner.current = value.userId;
  }, []);
  const acquire = useCallback(
    async (
      recordId: number,
      takeover = false,
      requestGeneration = generation.current,
    ) => {
      try {
        const result = await api<{ lock: EditingLease }>(
          `/posts/${recordId}/lock`,
          json("PUT", takeover ? { takeover: true } : {}),
        );
        if (
          requestGeneration !== generation.current ||
          currentId.current !== recordId
        )
          return false;
        if (!result.lock?.owned)
          throw new Error("The editing lock could not be acquired. Try again.");
        owned.current = recordId;
        lastForeignOwner.current = null;
        setLock(result.lock);
        setStatus("owned");
        setError("");
        setDialog(false);
        return true;
      } catch (reason) {
        if (
          requestGeneration !== generation.current ||
          currentId.current !== recordId
        )
          return false;
        owned.current = null;
        const foreign =
          reason instanceof ApiError && reason.status === 409
            ? (reason.data.lock as EditingLease | undefined)
            : undefined;
        if (foreign && typeof foreign.displayName === "string")
          applyForeignLock(foreign);
        else {
          setStatus("error");
          setError(errorText(reason));
        }
        return false;
      }
    },
    [applyForeignLock],
  );
  useEffect(() => {
    const recordId = postId,
      requestGeneration = ++generation.current;
    setLock(null);
    lastForeignOwner.current = null;
    setError("");
    setDialog(false);
    if (!recordId || !userId) {
      setStatus("owned");
      return;
    }
    setStatus("checking");
    void acquire(recordId, false, requestGeneration);
    const timer = window.setInterval(() => {
      void acquire(recordId, false, requestGeneration);
    }, 30_000);
    const visible = () => {
      if (document.visibilityState === "visible")
        void acquire(recordId, false, requestGeneration);
    };
    const release = () => {
      if (owned.current !== recordId) return;
      owned.current = null;
      void fetch(`/api/posts/${recordId}/lock`, {
        method: "DELETE",
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => {});
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", release);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [postId, userId, acquire]);
  const retry = useCallback(
    async (takeover = false) => {
      if (!currentId.current) return true;
      setBusy(true);
      try {
        return await acquire(currentId.current, takeover);
      } finally {
        setBusy(false);
      }
    },
    [acquire],
  );
  const checkConflict = useCallback(async () => {
    const recordId = currentId.current;
    if (!recordId) return false;
    try {
      const result = await api<{ lock: EditingLease | null }>(
        `/posts/${recordId}/lock`,
      );
      if (currentId.current !== recordId) return false;
      if (result.lock && !result.lock.owned) {
        applyForeignLock(result.lock);
        return true;
      }
    } catch {
      /* Keep the original save error visible when a status check fails. */
    }
    return false;
  }, [applyForeignLock]);
  return {
    ready: !postId || status === "owned",
    status,
    lock,
    error,
    dialog,
    setDialog,
    busy,
    retry,
    checkConflict,
  };
}

export default function Editor({ type }: { type: "post" | "page" }) {
  const { id } = useParams(),
    navigate = useNavigate(),
    { user } = useContext(Session);
  const siteClock = useResource<{ settings: Pick<Settings, "timezone" | "dateFormat" | "timeFormat"> }>("/public/site");
  const timezone = siteClock.data?.settings.timezone;
  const targetKey = `${user?.id}:${type}:${id || "new"}`;
  const activeTarget = useRef(targetKey); activeTarget.current = targetKey;
  const preferences = useEditorPreferences(), options = preferences.value;
  const editorRoot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = editorRoot.current, header = root?.querySelector<HTMLElement>(".editor-header");
    if (!root || !header) return;
    const measure = () => root.style.setProperty("--worldact-editor-header-height", `${header.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure); observer.observe(header); measure();
    return () => observer.disconnect();
  }, []);
  const [optionsDialog, setOptionsDialog] = useState<"preferences" | "shortcuts" | null>(null), [typing, setTyping] = useState(false);
  const canPublish =
    user?.role === "administrator" ||
    user?.role === "editor" ||
    user?.role === "author";
  const canUpload = canPublish,
    canPages = user?.role === "administrator" || user?.role === "editor";
  const base = `/admin/${type === "post" ? "posts" : "pages"}`;
  const [doc, setDoc] = useState<DocumentState>(emptyDocument);
  const [postId, setPostId] = useState<number | null>(id ? Number(id) : null);
  const lease = usePostEditLease(postId, user?.id);
  const leaseReady = useRef(lease.ready);
  leaseReady.current = lease.ready;
  const [version, setVersion] = useState(0);
  const [permalink, setPermalink] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [loading, setLoading] = useState(!!id),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [loadFailure, setLoadFailure] = useState<{ target: string; message: string } | null>(null);
  const loadError = loadFailure?.target === targetKey ? loadFailure.message : "";
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [conflict, setConflict] = useState(false);
  const [sidebar, setSidebar] = useState(
      () => window.matchMedia("(min-width:783px)").matches,
    ),
    [inspectorTab, setInspectorTab] = useState<"post" | "block">("post"),
    [inserter, setInserter] = useState(false),
    [listView, setListView] = useState(false);
  const listViewIntent = useRef(false), listViewInitialized = useRef(false);
  useEffect(() => {
    if (preferences.loading || listViewInitialized.current) return;
    listViewInitialized.current = true;
    if (!listViewIntent.current && !options.distractionFree && matchMedia("(min-width:782px)").matches) setListView(options.showListViewByDefault);
  }, [preferences.loading, options.showListViewByDefault, options.distractionFree]);
  useEffect(() => { if (options.distractionFree) { setInserter(false); setListView(false); } }, [options.distractionFree]);
  const updatePreference = (patch: EditorPreferencePatch) => { if (patch.editorMode && patch.editorMode !== options.editorMode) { const frame = editorRoot.current?.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]'); (frame?.contentDocument?.activeElement as HTMLElement | null)?.blur(); } if (patch.distractionFree === true) { setInserter(false); setListView(false); } setTyping(false); preferences.update(patch); };
  const [media, setMedia] = useState<Media[]>([]),
    [terms, setTerms] = useState<Term[]>([]),
    [pages, setPages] = useState<Post[]>([]),
    [picker, setPicker] = useState(false),
    [pickerError, setPickerError] = useState("");
  const [authors, setAuthors] = useState<Author[]>([]),
    [authorError, setAuthorError] = useState("");
  const [defaults, setDefaults] = useState<{
    format: PostFormat;
    commentStatus: "open" | "closed";
    pingStatus: "open" | "closed";
  }>({ format: "standard", commentStatus: "open", pingStatus: "closed" });
  const [newTag, setNewTag] = useState(""),
    [tagBusy, setTagBusy] = useState(false),
    [tagError, setTagError] = useState("");
  const [recovery, setRecovery] = useState<Recovery | null>(null),
    [autosavedAt, setAutosavedAt] = useState(""),
    [autosaveError, setAutosaveError] = useState("");
  const [revisionOpen, setRevisionOpen] = useState(false),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [revision, setRevision] = useState<Revision | null>(null),
    [revisionBusy, setRevisionBusy] = useState(false),
    [revisionError, setRevisionError] = useState("");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const title = titleRef.current, parent = title?.parentElement;
    if (!title || !parent) return;
    const resize = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
    resize();
    let width = parent.clientWidth;
    const observer = new ResizeObserver(() => { if (parent.clientWidth !== width) { width = parent.clientWidth; resize(); } });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [doc.title, loading]);
  const docRef = useRef(doc),
    blockEditor = useRef<GutenbergEditorHandle>(null),
    idRef = useRef(postId),
    versionRef = useRef(version),
    busyRef = useRef(false),
    dirtyRef = useRef(dirty),
    savedFingerprint = useRef(""),
    draftCreation = useRef<Promise<number> | null>(null),
    loadGeneration = useRef(0),
    documentGeneration = useRef(0),
    createdRoute = useRef<number | null>(null),
    loadedTarget = useRef(targetKey);
  docRef.current = doc;
  idRef.current = postId;
  versionRef.current = version;
  dirtyRef.current = dirty;
  const storageKey = useCallback(
    (recordId: number | null) =>
      `worldact-editor-${user?.id}-${type}-${recordId || "new"}`,
    [user?.id, type],
  );
  useEffect(()=>()=>{loadGeneration.current++;},[]);
  const change = useCallback((patch: Partial<DocumentState>) => {
    docRef.current = { ...docRef.current, ...patch };
    setDoc(docRef.current);
    setDirty(true);
    setNotice("");
  }, []);
  const documentSnapshot = useCallback((): DocumentState => {
    const editor = blockEditor.current, current = docRef.current;
    return editor ? { ...current, content: editor.getHTML(), blocks: editor.getBlocks(), footnotes: editor.getFootnotes() } : current;
  }, []);
  const targetMatches = editorTargetMatches(id, postId, createdRoute.current) && editorOwnerMatches(loadedTarget.current, targetKey, `${user?.id}:${type}:new`, postId, createdRoute.current);
  const documentReady = targetMatches && !loading && !loadError;
  const renderedDocumentGeneration = documentGeneration.current;
  useEditorShortcuts(editorRoot, action => {
    if (action === "mode") updatePreference({ editorMode: options.editorMode === "visual" ? "text" : "visual" });
    else if (action === "distraction") updatePreference({ distractionFree: !options.distractionFree });
    else if (action === "help") setOptionsDialog("shortcuts");
    else if (options.distractionFree) { setTyping(false); requestAnimationFrame(() => editorRoot.current?.querySelector<HTMLButtonElement>('.worldact-editor-options button')?.focus()); }
    else return false;
  }, !!user && user.role !== "subscriber" && (type === "post" || canPages) && documentReady, () => { if (options.distractionFree) setTyping(true); }, () => { if (options.distractionFree) setTyping(false); }, options.keepCaretInsideBlock);
  useEffect(() => {
    const recordId = id ? Number(id) : null;
    return () => {
      if (!dirtyRef.current || (recordId === null && createdRoute.current !== null && createdRoute.current === idRef.current)) return;
      try { localStorage.setItem(storageKey(recordId), JSON.stringify(documentRecovery(documentSnapshot(), versionRef.current))); }
      catch { /* A failed browser copy never changes the current server record. */ }
    };
  }, [id, storageKey, documentSnapshot]);
  function applyPost(post: Post) {
    documentGeneration.current++;
    const document = postDocument(post);
    loadedTarget.current = targetKey;
    docRef.current = document; idRef.current = post.id; versionRef.current = post.version; dirtyRef.current = false;
    busyRef.current = false; setBusy(false);
    setDoc(document);
    setPermalink(postLink(post));
    setPostId(post.id);
    setVersion(post.version);
    setDirty(false);
    setResetKey((key) => key + 1);
    savedFingerprint.current = JSON.stringify(postDocument(post));
    setConflict(false);
  }
  useEffect(() => {
    if (id && createdRoute.current === Number(id)) {
      loadedTarget.current = targetKey;
      createdRoute.current = null;
      return;
    }
    const generation = ++loadGeneration.current;
    busyRef.current = false; setBusy(false); setOptionsDialog(null); setTyping(false);
    setLoadFailure(null); setPostId(id ? Number(id) : null); setDirty(false); setRevisionOpen(false); setRevisionBusy(false);
    dirtyRef.current = false;
    setError("");
    setNotice("");
    setRecovery(null);
    setAutosavedAt("");
    setAutosaveError("");
    setRevisions([]);
    setRevision(null);
    setConflict(false);
    if (!id) {
      documentGeneration.current++;
      loadedTarget.current = targetKey;
      docRef.current = emptyDocument(); setDoc(docRef.current);
      setPostId(null);
      setVersion(0);
      setDirty(false);
      setResetKey((key) => key + 1);
      setLoading(false);
      const local = localStorage.getItem(storageKey(null));
      if (local) {
        try {
          setRecovery({ ...JSON.parse(local), source: "browser" });
        } catch {
          localStorage.removeItem(storageKey(null));
        }
      }
      return;
    }
    setLoading(true);
    api<{ post: Post }>(`/posts/${id}`)
      .then(async ({ post }) => {
        if (generation !== loadGeneration.current) return;
        if (post.type !== type) {
          navigate(
            `/admin/${post.type === "page" ? "pages" : "posts"}/${post.id}`,
            { replace: true },
          );
          return;
        }
        applyPost(post);
        let latest: Recovery | null = null;
        try {
          const { autosave } = await api<{ autosave: Autosave | null }>(
            `/posts/${post.id}/autosave`,
          );
          if (
            autosave &&
            new Date(autosave.savedAt).getTime() >
              new Date(post.updatedAt).getTime() &&
            (autosave.content !== post.content ||
              autosave.title !== post.title ||
              autosave.excerpt !== post.excerpt ||
              JSON.stringify(autosave.footnotes || []) !== JSON.stringify(post.footnotes || []))
          )
            latest = { ...autosave, source: "server" };
        } catch {
          /* Recovery from this browser remains available when the server cannot return an autosave. */
        }
        const local = localStorage.getItem(storageKey(post.id));
        if (local) {
          try {
            const candidate = JSON.parse(local) as Autosave;
            if (
              new Date(candidate.savedAt).getTime() >
                new Date(post.updatedAt).getTime() &&
              (!latest || candidate.savedAt > latest.savedAt)
            )
              latest = { ...candidate, source: "browser" };
          } catch {
            localStorage.removeItem(storageKey(post.id));
          }
        }
        if (generation === loadGeneration.current) setRecovery(latest);
      })
      .catch((e) => {
        if (generation === loadGeneration.current) setLoadFailure({ target: targetKey, message: errorText(e) });
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
    return () => {
      loadGeneration.current++;
    };
  }, [id, type, navigate, storageKey]);
  useEffect(() => {
    let cancelled = false;
    api<{ authors: Author[]; defaults: typeof defaults }>("/authors")
      .then((result) => {
        if (!cancelled) {
          setAuthors(result.authors);
          setDefaults(result.defaults);
          setAuthorError("");
        }
      })
      .catch((reason) => {
        if (!cancelled) setAuthorError(errorText(reason));
      });
    api<{ terms: Term[] }>("/terms")
      .then(({ terms }) => {
        if (!cancelled) setTerms(terms);
      })
      .catch((e) => setTagError(errorText(e)));
    if (canUpload)
      api<{ media: Media[] }>("/media")
        .then(({ media }) => {
          if (!cancelled) setMedia(media);
        })
        .catch((e) => setPickerError(errorText(e)));
    if (type === "page" && canPages)
      api<{ posts: Post[] }>("/posts?type=page&status=all&perPage=100")
        .then(({ posts }) => {
          if (!cancelled) setPages(posts);
        })
        .catch((e) => setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [canUpload, canPages, type]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, []);
  useEffect(() => {
    if (!dirty || loading) return;
    const timeout = window.setTimeout(() => {
      const current = documentSnapshot();
      try {
        localStorage.setItem(
          storageKey(idRef.current),
          JSON.stringify(documentRecovery(current, versionRef.current)),
        );
      } catch {
        /* Saving to the server continues when browser storage is full. */
      }
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [doc, dirty, loading, storageKey, documentSnapshot]);
  function payload(current: DocumentState, nextStatus: Post["status"]) {
    const effective =
      nextStatus === "publish" && current.visibility === "private"
        ? "private"
        : nextStatus;
    const { visibility: _visibility, password: _password, scheduledAt: _scheduledAt,
      postDate: _postDate, postDateOriginal: _postDateOriginal, postDateGmt: _postDateGmt, postDateIntent, ...fields } = current;
    return {
      ...fields,
      blocks: current.blocks || [],
      status: effective,
      ...publicationDatePayload(postDateIntent),
      categoryIds: current.categoryIds,
      tagIds: current.tagIds,
      ...(current.visibility === "password"
        ? current.password === undefined
          ? {}
          : { password: current.password }
        : { password: "" }),
      version: versionRef.current || undefined,
      type,
    };
  }
  const ensureDraft = useCallback((): Promise<number> => {
    if(idRef.current)return Promise.resolve(idRef.current);
    if(draftCreation.current)return draftCreation.current;
    const snapshot=documentSnapshot(),generation=loadGeneration.current;
    draftCreation.current=api<{post:Post}>("/posts",json("POST",payload(snapshot,"draft"))).then(({post})=>{
      if(loadGeneration.current!==generation)return post.id;
      idRef.current=post.id;versionRef.current=post.version;
      setPostId(post.id);setVersion(post.version);setPermalink(postLink(post));
      setDoc(current => ({ ...current, postDateOriginal: post.postDate, postDateGmt: post.postDateGmt,
        ...(current.postDate === snapshot.postDate && current.postDateIntent === snapshot.postDateIntent
          ? { postDate: post.postDate, postDateIntent: undefined, scheduledAt: post.scheduledAt || "" }
          : publicationDateChange(current.postDate, post.postDate)) }));
      createdRoute.current=post.id;
      localStorage.removeItem(storageKey(null));
      navigate(`${base}/${post.id}`,{replace:true});
      return post.id;
    }).finally(()=>{draftCreation.current=null;});
    return draftCreation.current;
  },[base,navigate,storageKey,type,documentSnapshot]);
  useEffect(()=>{
    if(loading || !dirty || recovery || idRef.current)return;
    const current=docRef.current;
    const text=current.content.replace(/<!--[\s\S]*?-->/g,"").replace(/<[^>]*>/g,"").replace(/&nbsp;/g,"").trim();
    const hasBlock=current.blocks?.some(block=>!["core/paragraph","core/heading"].includes(block.name));
    if(!current.title.trim() && !text && !hasBlock)return;
    const generation = loadGeneration.current, requestSession = documentGeneration.current;
    void ensureDraft().catch(reason=>{ if (generation === loadGeneration.current && requestSession === documentGeneration.current) setAutosaveError(`Autosave failed: ${errorText(reason)} Your changes are stored in this browser.`); });
  },[doc,dirty,loading,recovery,ensureDraft]);
  useEffect(() => {
    if (loading || !dirty || recovery || !lease.ready) return;
    const timeout = window.setTimeout(async () => {
      if (busyRef.current || !dirtyRef.current || !leaseReady.current) return;
      const generation = loadGeneration.current, requestSession = documentGeneration.current;
      const isCurrent = () => generation === loadGeneration.current && requestSession === documentGeneration.current;
      const current = docRef.current;
      if (!current.title.trim() && !current.content.trim()) return;
      busyRef.current = true;
      setAutosaveError("");
      try {
        if (!idRef.current) {
          await ensureDraft();
        }
        if (!isCurrent()) return;
        if (idRef.current && !leaseReady.current && !(await lease.retry()))
          return;
        const latest = documentSnapshot();
        const { autosave } = await api<{ autosave: Autosave }>(
          `/posts/${idRef.current}/autosave`,
          json("PUT", {
            title: latest.title,
            content: latest.content,
            excerpt: latest.excerpt,
            blocks: latest.blocks || [],
            footnotes: latest.footnotes,
            version: versionRef.current,
          }),
        );
        if (isCurrent()) setAutosavedAt(autosave.savedAt);
      } catch (e) {
        if (!isCurrent()) return;
        if (e instanceof ApiError && e.status === 409)
          await lease.checkConflict();
        setAutosaveError(
          `Autosave failed: ${errorText(e)} Your changes are stored in this browser.`,
        );
      } finally {
        if (isCurrent()) busyRef.current = false;
      }
    }, 8000);
    return () => window.clearTimeout(timeout);
  }, [
    doc,
    dirty,
    loading,
    recovery,
    base,
    navigate,
    storageKey,
    lease.ready,
    lease.retry,
    lease.checkConflict,
    ensureDraft,
    documentSnapshot,
  ]);
  const loadRevisions = useCallback(async () => {
    if (!idRef.current) return;
    const generation = loadGeneration.current;
    setRevisionBusy(true);
    setRevisionError("");
    try {
      const data = await api<{ revisions: Revision[] }>(
        `/posts/${idRef.current}/revisions`,
      );
      if (generation !== loadGeneration.current) return;
      setRevisions(data.revisions);
      setRevision(data.revisions[0] || null);
    } catch (e) {
      if (generation === loadGeneration.current) setRevisionError(errorText(e));
    } finally {
      if (generation === loadGeneration.current) setRevisionBusy(false);
    }
  }, []);
  async function save(nextStatus: Post["status"]) {
    if (!documentReady || busyRef.current || !leaseReady.current) return;
    if (
      nextStatus === "future" &&
      (!scheduleInstant || Date.parse(scheduleInstant) <= Date.now())
    ) {
      setError("Choose a future publication date before scheduling.");
      return;
    }
    if (
      doc.visibility === "password" &&
      doc.password !== undefined &&
      !doc.password.trim()
    ) {
      setError("Enter a password, or change visibility to Public.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setConflict(false);
    const generation = loadGeneration.current, requestSession = documentGeneration.current, wasNew = !idRef.current;
    const isCurrent = () => generation === loadGeneration.current && requestSession === documentGeneration.current;
    try {
      await blockEditor.current?.flushEntities();
      if (!isCurrent()) return;
      const snapshot = documentSnapshot(), fingerprint = JSON.stringify(snapshot);
      const currentId = idRef.current || await ensureDraft();
      if (!isCurrent()) return;
      const { post } = await api<{ post: Post }>(
        currentId ? `/posts/${currentId}` : "/posts",
        json(currentId ? "PUT" : "POST", payload(snapshot, nextStatus)),
      );
      if (!isCurrent()) return;
      setPostId(post.id);
      setPermalink(postLink(post));
      idRef.current = post.id;
      setVersion(post.version);
      versionRef.current = post.version;
      setDoc((current) => ({
        ...current,
        footnotes:JSON.stringify(current.footnotes)===JSON.stringify(snapshot.footnotes)?post.footnotes || []:current.footnotes,
        status: post.status,
        slug: post.slug,
        scheduledAt: post.scheduledAt || "",
        postDateOriginal: post.postDate,
        postDateGmt: post.postDateGmt,
        ...(current.postDate === snapshot.postDate && current.postDateIntent === snapshot.postDateIntent
          ? { postDate: post.postDate, postDateIntent: undefined }
          : publicationDateChange(current.postDate, post.postDate)),
      }));
      blockEditor.current?.acknowledgeFootnotes(post.footnotes || [],snapshot.footnotes);
      const unchanged = JSON.stringify(docRef.current) === fingerprint;
      setDirty(!unchanged);
      savedFingerprint.current = fingerprint;
      setNotice(
        post.status === "publish"
          ? `${type === "post" ? "Post" : "Page"} published.`
          : post.status === "future"
            ? "Publication scheduled."
            : post.status === "private"
              ? "Private content saved."
              : post.status === "pending"
                ? "Submitted for review."
                : "Draft saved.",
      );
      setAutosaveError("");
      setRecovery(null);
      setAutosavedAt("");
      if (unchanged) {
        localStorage.removeItem(storageKey(currentId));
        localStorage.removeItem(storageKey(post.id));
        await api(`/posts/${post.id}/autosave`, json("DELETE")).catch(() => {});
      }
      if (wasNew) {
        if (!isCurrent()) return;
        createdRoute.current = post.id;
        navigate(`${base}/${post.id}`, { replace: true });
      }
    } catch (e) {
      if (!isCurrent()) return;
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 409) {
        if (!(await lease.checkConflict())) setConflict(true);
      }
    } finally {
      if (isCurrent()) { busyRef.current = false; setBusy(false); }
    }
  }
  function leave() {
    if (!documentReady || !dirty || window.confirm("You have unsaved changes. Leave the editor?"))
      navigate(base);
  }
  async function previewChanges() {
    if(!documentReady || busyRef.current || !leaseReady.current || !idRef.current)return;
    const recordId=idRef.current,generation=loadGeneration.current,tab=window.open("about:blank","_blank");
    if(tab)tab.opener=null;
    busyRef.current=true;setBusy(true);setError("");
    try {
      await blockEditor.current?.flushEntities();
      if(generation!==loadGeneration.current){tab?.close();return;}
      const snapshot=documentSnapshot();
      const {autosave}=await api<{autosave:Autosave}>(`/posts/${recordId}/autosave`,json("PUT",{title:snapshot.title,content:snapshot.content,excerpt:snapshot.excerpt,blocks:snapshot.blocks || [],footnotes:snapshot.footnotes,version:versionRef.current}));
      if(generation===loadGeneration.current)setAutosavedAt(autosave.savedAt);
      if(tab)tab.location.replace(`/preview/${recordId}`);
      else window.open(`/preview/${recordId}`,"_blank","noopener,noreferrer");
    } catch(reason){tab?.close();if(generation===loadGeneration.current){setError(errorText(reason));if(reason instanceof ApiError && reason.status===409)await lease.checkConflict();}}
    finally{if(generation===loadGeneration.current){busyRef.current=false;setBusy(false);}}
  }
  async function recover() {
    if (!recovery) return;
    documentGeneration.current++;
    change({
      title: recovery.title,
      content:
        (recovery as Recovery & { rawContent?: string }).rawContent ||
        recovery.content,
      excerpt: recovery.excerpt,
      blocks: recovery.blocks,
      footnotes: recovery.footnotes || [],
    });
    setResetKey((key) => key + 1);
    setRecovery(null);
    setNotice(
      "Autosaved changes restored in the editor. Save to apply them to this document.",
    );
  }
  async function discardRecovery() {
    setError("");
    try {
      if (postId) await api(`/posts/${postId}/autosave`, json("DELETE"));
      localStorage.removeItem(storageKey(postId));
      setRecovery(null);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function upload(files: File[]) {
    const uploaded: Media[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      const { media: item } = await api<{ media: Media }>("/media", {
        method: "POST",
        body: form,
      });
      uploaded.push(item);
    }
    setMedia((current) => [...uploaded, ...current]);
    return uploaded;
  }
  async function addTag(event: FormEvent) {
    event.preventDefault();
    const names = newTag
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) return;
    setTagBusy(true);
    setTagError("");
    try {
      const added: Term[] = [];
      for (const name of names) {
        const existing = terms.find(
          (term) =>
            term.taxonomy === "tag" &&
            term.name.toLowerCase() === name.toLowerCase(),
        );
        if (!existing && !canPublish)
          throw new Error(
            "Choose an existing tag. Creating tags requires an author, editor, or administrator.",
          );
        added.push(
          existing ||
            (
              await api<{ term: Term }>(
                "/terms",
                json("POST", { taxonomy: "tag", name }),
              )
            ).term,
        );
      }
      setTerms((current) => [
        ...current,
        ...added.filter((term) => !current.some((item) => item.id === term.id)),
      ]);
      change({
        tagIds: Array.from(
          new Set([...doc.tagIds, ...added.map((term) => term.id)]),
        ),
      });
      setNewTag("");
    } catch (e) {
      setTagError(errorText(e));
    } finally {
      setTagBusy(false);
    }
  }
  async function restoreRevision() {
    if (!revision || !postId || !leaseReady.current) return;
    if (
      dirty &&
      !window.confirm("Replace your current edits with this revision?")
    )
      return;
    setRevisionBusy(true);
    setRevisionError("");
    const generation = loadGeneration.current, requestSession = documentGeneration.current;
    const fingerprint = JSON.stringify(documentSnapshot());
    const isCurrent = () => generation === loadGeneration.current && requestSession === documentGeneration.current;
    try {
      const { post } = await api<{ post: Post }>(
        `/posts/${postId}/revisions/${revision.id}/restore`,
        json("POST", { version }),
      );
      if (!isCurrent()) return;
      const unchanged = JSON.stringify(documentSnapshot()) === fingerprint;
      setRevisionBusy(false);
      if (unchanged) applyPost(post);
      else { versionRef.current = post.version; setVersion(post.version); savedFingerprint.current = JSON.stringify(postDocument(post)); }
      versionRef.current = post.version;
      setRevisionOpen(false);
      setNotice(unchanged ? "Revision restored." : "Revision restored. Your newer changes are still unsaved.");
      if (unchanged) localStorage.removeItem(storageKey(post.id));
    } catch (e) {
      if (!isCurrent()) return;
      if (e instanceof ApiError && e.status === 409)
        await lease.checkConflict();
      setRevisionError(errorText(e));
    } finally {
      if (isCurrent()) setRevisionBusy(false);
    }
  }
  function isDescendant(candidate: Post) {
    let parent = candidate.parentId;
    const seen = new Set<number>();
    while (parent && !seen.has(parent)) {
      if (parent === postId) return true;
      seen.add(parent);
      parent = pages.find((page) => page.id === parent)?.parentId || null;
    }
    return candidate.id === postId;
  }
  const scheduleInstant = publicationActionInstant(doc, timezone);
  const primaryStatus: Post["status"] = !canPublish
    ? doc.status === "private"
      ? "private"
      : "pending"
    : doc.status === "draft" || doc.status === "pending"
      ? scheduleInstant && Date.parse(scheduleInstant) > Date.now()
        ? "future"
        : "publish"
      : doc.status;
  const primaryLabel =
    primaryStatus === "pending"
      ? "Submit for Review"
      : primaryStatus === "future"
        ? "Schedule"
        : ["publish", "private"].includes(doc.status)
          ? "Save"
          : "Publish";
  const featured = media.find((item) => item.id === doc.featuredMediaId);
  const words = doc.content
    .replace(/<[^>]+>/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const sidebarTabs = (
    <div className="editor-settings-title editor-inspector-tabs">
      <button
        className={inspectorTab === "post" ? "active" : ""}
        onClick={() => setInspectorTab("post")}
      >
        {type === "post" ? "Post" : "Page"}
      </button>
      <button
        className={inspectorTab === "block" ? "active" : ""}
        onClick={() => setInspectorTab("block")}
      >
        Block
      </button>
      <button
        className="editor-icon-button"
        aria-label="Close settings"
        onClick={() => setSidebar(false)}
      >
        <Icon name="no-alt" />
        {options.showIconLabels && <span>Close settings</span>}
      </button>
    </div>
  );
  const forbidden =
    !user || user.role === "subscriber" || (type === "page" && !canPages);
  async function copyAllBlocks() {
    const generation = loadGeneration.current, content = blockEditor.current?.getHTML() ?? docRef.current.content;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(content);
      if (generation === loadGeneration.current) setNotice("All content copied.");
    } catch {
      if (generation === loadGeneration.current) setError("Content could not be copied. Select the text in the Code editor and copy it with your keyboard.");
    }
  }
  return (
    <div ref={editorRoot} className={`block-editor-screen ${sidebar && !options.distractionFree ? "with-sidebar" : ""} ${options.fullscreenMode ? "is-fullscreen-mode" : ""} ${options.distractionFree ? "is-distraction-free" : ""} ${options.distractionFree && typing && !optionsDialog ? "is-writing" : ""} ${options.showIconLabels ? "show-icon-labels" : ""} ${options.editorMode === "text" ? "is-code-mode" : ""}`} onMouseMove={() => { if (options.distractionFree) setTyping(false); }}>
      <header className="editor-header" inert={options.distractionFree && typing && !optionsDialog}>
        <button
          className="editor-home"
          aria-label={`Back to ${type === "post" ? "posts" : "pages"}`}
          onClick={leave}
        >
          <Brand />
        </button>
        <div className="editor-tools">
          <button
            className={`editor-add ${inserter ? "is-pressed" : ""}`}
            aria-label="Add block"
            aria-expanded={inserter}
            onClick={() => {
              setInserter(!inserter);
              setListView(false);
              if (options.distractionFree) updatePreference({ distractionFree: false });
            }}
          >
            <Icon name={inserter ? "no-alt" : "plus"} />
            {options.showIconLabels && <span>{inserter ? "Close" : "Add block"}</span>}
          </button>
          <button
            className={`editor-icon-button ${listView ? "is-pressed" : ""}`}
            aria-label="List view"
            aria-pressed={listView}
            onClick={() => {
              setListView(!listView);
              setInserter(false);
              listViewIntent.current = true;
              if (options.distractionFree) updatePreference({ distractionFree: false });
            }}
          >
            <Icon name="editor-ul" />
            {options.showIconLabels && <span>List View</span>}
          </button>
          <span className="editor-document-name">
            {documentReady ? doc.title || (type === "post" ? "New post" : "New page") : "Loading…"}{" "}
            <span>· {type === "post" ? "Post" : "Page"}</span>
          </span>
        </div>
        <div className="editor-actions">
          {!["publish", "private", "future"].includes(doc.status) && (
            <button
              className="button-link"
              disabled={busy || !documentReady || forbidden || !lease.ready}
              onClick={() => void save("draft")}
            >
              Save draft
            </button>
          )}
          {documentReady && ["publish", "private"].includes(doc.status) && doc.slug && (
            <Link
              className="editor-icon-button"
              to={
                doc.status === "private"
                  ? `/preview/${postId}`
                  : permalink ||
                    `/${type === "post" ? "posts" : "pages"}/${doc.slug}`
              }
              aria-label="View published content"
            >
              <Icon name="external" />
              {options.showIconLabels && <span>View {type}</span>}
            </Link>
          )}
          {documentReady && postId && (
            <button
              className="editor-icon-button"
              aria-label="Preview"
              disabled={busy || !lease.ready}
              onClick={() => void previewChanges()}
            >
              <Icon name="visibility" />
              {options.showIconLabels && <span>Preview</span>}
            </button>
          )}
          <button
            className="editor-icon-button"
            aria-label="Settings"
            aria-pressed={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            <Icon name="admin-settings" />
            {options.showIconLabels && <span>Settings</span>}
          </button>
          <button
            className="button button-primary"
            disabled={busy || !documentReady || forbidden || !lease.ready}
            onClick={() => void save(primaryStatus)}
          >
            {busy ? "Saving…" : primaryLabel}
          </button>
          <EditorOptions value={options} update={updatePreference} disabled={!documentReady || forbidden} dialog={optionsDialog} setDialog={setOptionsDialog} error={preferences.error} dismissError={preferences.dismiss} copy={() => void copyAllBlocks()}/>
        </div>
      </header>
      <main className="editor-main">
        <ResourceState loading={loading || !targetMatches} error={loadError} />
        {forbidden ? (
          <Notice error>
            You do not have permission to edit this content.
          </Notice>
        ) : (
          documentReady && (
            <>
              <div className="editor-notices">
                {preferences.error && <Notice error onDismiss={preferences.dismiss}>{preferences.error}</Notice>}
                {postId && lease.status === "checking" && (
                  <Notice>Checking editing status…</Notice>
                )}
                {lease.status === "blocked" && (
                  <Notice error>
                    {lease.lock?.displayName || "Another user"} is currently
                    editing this {type}. Your edits are preserved in this
                    browser.
                    <p>
                      <button
                        className="button"
                        disabled={lease.busy}
                        onClick={() => void lease.retry(true)}
                      >
                        Take over
                      </button>{" "}
                      <button
                        className="button-link"
                        onClick={() => lease.setDialog(true)}
                      >
                        View editing details
                      </button>
                    </p>
                  </Notice>
                )}
                {lease.status === "error" && (
                  <Notice error>
                    Saving is paused. {lease.error} Your edits are preserved in
                    this browser.
                    <p>
                      <button
                        className="button"
                        disabled={lease.busy}
                        onClick={() => void lease.retry()}
                      >
                        Retry editing connection
                      </button>
                    </p>
                  </Notice>
                )}
                {error && (
                  <Notice error>
                    {error}
                    {conflict && (
                      <p>
                        Your edits are preserved in this browser.{" "}
                        <button
                          className="button-link"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Load the latest saved version? Unsaved changes will remain available as a recovery copy.",
                              )
                            )
                              window.location.reload();
                          }}
                        >
                          Load latest version
                        </button>
                      </p>
                    )}
                  </Notice>
                )}
                {notice && (
                  <Notice onDismiss={() => setNotice("")}>
                    {notice}{" "}
                    {doc.status === "publish" && (
                      <Link
                        to={
                          permalink ||
                          `/${type === "post" ? "posts" : "pages"}/${doc.slug}`
                        }
                      >
                        View {type}
                      </Link>
                    )}
                  </Notice>
                )}
                {autosaveError && <Notice error>{autosaveError}</Notice>}
                {recovery && (
                  <div
                    className="notice notice-warning recovery-notice"
                    role="status"
                  >
                    <p>
                      There is a more recent autosave of this {type} from{" "}
                      {new Date(recovery.savedAt).toLocaleString()}.{" "}
                      <button
                        className="button-link"
                        onClick={() => void recover()}
                      >
                        Restore autosave
                      </button>{" "}
                      <button
                        className="button-link"
                        onClick={() => void discardRecovery()}
                      >
                        Dismiss
                      </button>
                    </p>
                  </div>
                )}
              </div>
              <div className="editor-title-canvas">
                <textarea
                  ref={titleRef}
                  className="editor-title"
                  placeholder="Add title"
                  aria-label="Add title"
                  rows={1}
                  value={doc.title}
                  onChange={(e) => {
                    change({ title: e.target.value });
                    e.currentTarget.style.height = "auto";
                    e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                  }}
                />
              </div>
              <GutenbergEditor
                ref={blockEditor}
                postId={postId || undefined}
                postType={type}
                initialBlocks={doc.blocks}
                initialHTML={doc.content}
                initialFootnotes={doc.footnotes}
                onMetadataChange={(footnotes) => {
                  if (activeTarget.current !== targetKey || documentGeneration.current !== renderedDocumentGeneration) return;
                  if(JSON.stringify(footnotes)!==JSON.stringify(docRef.current.footnotes))change({footnotes});
                }}
                resetKey={resetKey}
                onChange={(blocks, content) => {
                  if (activeTarget.current !== targetKey || documentGeneration.current !== renderedDocumentGeneration) return;
                  if (
                    content !== docRef.current.content ||
                    JSON.stringify(blocks) !==
                      JSON.stringify(docRef.current.blocks)
                  )
                    change({ blocks, content });
                }}
                media={media}
                preferences={options}
                onModeChange={editorMode => updatePreference({ editorMode })}
                onTypingChange={setTyping}
                inserterOpen={inserter && !options.distractionFree}
                onInserterClose={() => setInserter(false)}
                listViewOpen={listView && !options.distractionFree}
                inspectorOpen={sidebar && inspectorTab === "block" && !options.distractionFree && options.editorMode !== "text"}
                onUpload={canUpload ? upload : undefined}
                onError={message => { if (activeTarget.current === targetKey && documentGeneration.current === renderedDocumentGeneration) setError(message); }}
              />
            </>
          )
        )}
      </main>
      {documentReady && sidebar && !options.distractionFree && (
        <aside
          className={`editor-settings ${inspectorTab === "block" ? "block-tab" : ""}`}
        >
          {sidebarTabs}
          {inspectorTab === "post" && (
            <>
              <div className="editor-summary">
                <h2>
                  {doc.title || (type === "post" ? "New post" : "New page")}
                </h2>
                <p>
                  {words} words · {statuses[doc.status]}
                </p>
                <div className="editor-meta-fields">
                  <label>
                    Status
                    <select
                      value={doc.status}
                      onChange={(e) =>
                        change({ status: e.target.value as Post["status"] })
                      }
                    >
                      {(
                        [
                          "draft",
                          "pending",
                          ...(canPublish
                            ? ["publish", "future", "private"]
                            : doc.status === "private"
                              ? ["private"]
                              : []),
                          ...(doc.status === "trash" ? ["trash"] : []),
                        ] as Post["status"][]
                      ).map((status) => (
                        <option key={status} value={status}>
                          {statuses[status]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {canPublish && (
                    <>
                      <label>
                        Publish
                        <input
                          type="datetime-local"
                          aria-label="Publication date"
                          aria-describedby="publication-date-zone"
                          step="1"
                          min="0001-01-01T00:00:00"
                          max="9999-12-31T23:59:59"
                          disabled={!timezone}
                          value={doc.postDate}
                          onChange={(e) =>
                            change({
                              ...publicationDateChange(e.target.value, doc.postDateOriginal),
                              ...(!e.target.value && doc.status === "future" ? { status: "draft" as const } : {}),
                            })
                          }
                        />
                      </label>
                      <p className="description" id="publication-date-zone">
                        {timezone ? `Site timezone: ${timezone}.` : siteClock.error || "Loading site timezone…"}{" "}
                        {doc.postDate && timezone
                          ? (() => { try { return `Publication time: ${formatPostCivil(doc.postDate, "Y-m-d H:i:s", timezone)}`; } catch { return "Choose a valid publication date."; } })()
                          : "Immediately"}
                      </p>
                      {doc.postDate && (
                        <button
                          className="button-link"
                          onClick={() =>
                            change({
                              postDate: "", postDateIntent: null,
                              ...(doc.status === "future"
                                ? { status: "draft" as const }
                                : {}),
                            })
                          }
                        >
                          Reset to immediately
                        </button>
                      )}
                      <label>
                        Visibility
                        <select
                          value={doc.visibility}
                          onChange={(e) =>
                            change({
                              visibility: e.target
                                .value as DocumentState["visibility"],
                              ...(e.target.value !== "password"
                                ? { password: "" }
                                : {}),
                            })
                          }
                        >
                          <option value="public">Public</option>
                          <option value="private">Private</option>
                          <option value="password">Password protected</option>
                        </select>
                      </label>
                      {doc.visibility === "password" && (
                        <label>
                          Password
                          <input
                            type="text"
                            autoComplete="off"
                            value={doc.password || ""}
                            placeholder={
                              doc.password === undefined
                                ? "Leave blank to keep existing password"
                                : "Enter password"
                            }
                            onChange={(e) =>
                              change({ password: e.target.value })
                            }
                          />
                        </label>
                      )}
                    </>
                  )}
                </div>
                {postId && (
                  <p>
                    <button
                      className="button-link"
                      onClick={() => {
                        setRevisionOpen(true);
                        void loadRevisions();
                      }}
                    >
                      Revisions
                    </button>
                  </p>
                )}
              </div>
              <details open>
                <summary>Link</summary>
                <label>
                  Slug
                  <input
                    value={doc.slug}
                    placeholder="Generated from title"
                    onChange={(e) => change({ slug: e.target.value })}
                  />
                </label>
              </details>
              <details>
                <summary>Author</summary>
                <label>
                  Author
                  <select
                    value={doc.authorId ?? user?.id ?? ""}
                    disabled={!authors.length}
                    onChange={(event) =>
                      change({ authorId: Number(event.target.value) })
                    }
                  >
                    {doc.authorId &&
                      !authors.some((author) => author.id === doc.authorId) && (
                        <option value={doc.authorId}>
                          Current author (#{doc.authorId})
                        </option>
                      )}
                    {authors.map((author) => (
                      <option value={author.id} key={author.id}>
                        {author.displayName} ({author.username})
                      </option>
                    ))}
                  </select>
                </label>
                {authorError && (
                  <p className="field-error" role="alert">
                    {authorError}
                  </p>
                )}
              </details>
              {type === "post" && (
                <details>
                  <summary>Format</summary>
                  <label>
                    Post Format
                    <select
                      value={doc.format ?? defaults.format}
                      onChange={(event) =>
                        change({ format: event.target.value as PostFormat })
                      }
                    >
                      {postFormats.map((format) => (
                        <option value={format} key={format}>
                          {format[0].toUpperCase() + format.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                </details>
              )}
              {type === "post" && (
                <>
                  <details open>
                    <summary>Categories</summary>
                    <div className="editor-term-checklist">
                      {terms
                        .filter((term) => term.taxonomy === "category")
                        .map((term) => (
                          <label className="checkbox-label" key={term.id}>
                            <input
                              type="checkbox"
                              checked={doc.categoryIds.includes(term.id)}
                              onChange={(e) =>
                                change({
                                  categoryIds: e.target.checked
                                    ? [...doc.categoryIds, term.id]
                                    : doc.categoryIds.filter(
                                        (id) => id !== term.id,
                                      ),
                                })
                              }
                            />
                            {term.parentId ? "— " : ""}
                            {term.name}
                          </label>
                        ))}
                    </div>
                    {canPages && (
                      <Link
                        to="/admin/posts/categories"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Manage categories ↗
                      </Link>
                    )}
                  </details>
                  <details>
                    <summary>Tags</summary>
                    <div className="editor-tag-chips">
                      {terms
                        .filter(
                          (term) =>
                            term.taxonomy === "tag" &&
                            doc.tagIds.includes(term.id),
                        )
                        .map((term) => (
                          <button
                            key={term.id}
                            title={`Remove ${term.name}`}
                            onClick={() =>
                              change({
                                tagIds: doc.tagIds.filter(
                                  (id) => id !== term.id,
                                ),
                              })
                            }
                          >
                            {term.name} ×
                          </button>
                        ))}
                    </div>
                    <form onSubmit={addTag}>
                      <label>
                        {canPublish ? "Add new tag" : "Add existing tag"}
                        <input
                          value={newTag}
                          onChange={(e) => setNewTag(e.target.value)}
                          list="worldact-existing-tags"
                        />
                      </label>
                      <datalist id="worldact-existing-tags">
                        {terms
                          .filter((term) => term.taxonomy === "tag")
                          .map((term) => (
                            <option key={term.id} value={term.name} />
                          ))}
                      </datalist>
                      <button
                        className="button"
                        disabled={tagBusy || !newTag.trim()}
                      >
                        {tagBusy ? "Adding…" : "Add"}
                      </button>
                      <p className="description">Separate tags with commas.</p>
                    </form>
                    {tagError && (
                      <p className="field-error" role="alert">
                        {tagError}
                      </p>
                    )}
                  </details>
                </>
              )}
              {canUpload && (
                <details open>
                  <summary>Featured image</summary>
                  {featured ? (
                    <>
                      <img
                        className="featured-image-preview"
                        src={featured.url}
                        alt={featured.alt || "Featured image"}
                      />
                      <button
                        className="button-link"
                        onClick={() => setPicker(true)}
                      >
                        Replace featured image
                      </button>
                      <p>
                        <button
                          className="button-link button-link-delete"
                          onClick={() => change({ featuredMediaId: null })}
                        >
                          Remove featured image
                        </button>
                      </p>
                    </>
                  ) : (
                    <button
                      className="button-link"
                      onClick={() => setPicker(true)}
                    >
                      Set featured image
                    </button>
                  )}
                </details>
              )}
              <details open>
                <summary>Template</summary>
                <PostTemplateSelect
                  type={type}
                  value={doc.templateSlug}
                  onChange={(templateSlug) =>
                    change({ templateSlug: templateSlug || "" })
                  }
                />
              </details>
              {type === "page" && (
                <details open>
                  <summary>Page Attributes</summary>
                  <label>
                    Parent
                    <select
                      value={doc.parentId || ""}
                      onChange={(e) =>
                        change({
                          parentId: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    >
                      <option value="">(no parent)</option>
                      {pages
                        .filter((page) => !isDescendant(page))
                        .map((page) => (
                          <option key={page.id} value={page.id}>
                            {page.title || "(no title)"}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Order
                    <input
                      type="number"
                      value={doc.menuOrder}
                      onChange={(e) =>
                        change({ menuOrder: Number(e.target.value) || 0 })
                      }
                    />
                  </label>
                </details>
              )}
              <details>
                <summary>Excerpt</summary>
                <label>
                  Write an excerpt (optional)
                  <textarea
                    rows={5}
                    value={doc.excerpt}
                    onChange={(e) => change({ excerpt: e.target.value })}
                  />
                </label>
              </details>
              <details>
                <summary>Discussion</summary>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={
                      (doc.commentStatus ?? defaults.commentStatus) === "open"
                    }
                    onChange={(e) =>
                      change({
                        commentStatus: e.target.checked ? "open" : "closed",
                      })
                    }
                  />{" "}
                  Allow comments
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={(doc.pingStatus ?? defaults.pingStatus) === "open"}
                    onChange={(event) =>
                      change({
                        pingStatus: event.target.checked ? "open" : "closed",
                      })
                    }
                  />
                  Allow pingbacks and trackbacks
                </label>
                <p className="description">
                  Comment moderation follows the site's Discussion settings.
                </p>
              </details>
              {type === "post" && canPages && (
                <details>
                  <summary>Post options</summary>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={doc.sticky}
                      onChange={(e) => change({ sticky: e.target.checked })}
                    />{" "}
                    Stick to the top of the blog
                  </label>
                </details>
              )}
            </>
          )}
        </aside>
      )}
      <footer className="editor-status">
        <span>{type === "post" ? "Post" : "Page"}</span>
        <span>{documentReady ? words : 0} words</span>
        <span className="save-indicator">
          {!documentReady ? loadError ? "Saving paused" : "Loading…" : !lease.ready
            ? lease.status === "blocked"
              ? "Editing locked"
              : "Saving paused"
            : busy
              ? "Saving…"
              : autosavedAt
                ? `Autosaved at ${new Date(autosavedAt).toLocaleTimeString()}`
                : dirty
                  ? "Unsaved changes"
                  : statuses[doc.status]}
        </span>
      </footer>
      {lease.dialog && lease.status === "blocked" && (
        <Modal
          title={`This ${type} is already being edited`}
          close={() => lease.setDialog(false)}
        >
          <p>
            <strong>{lease.lock?.displayName || "Another user"}</strong> is
            currently working on this {type}. You can return to the list or take
            over editing.
          </p>
          {dirty && <p>Your unsaved edits are preserved in this browser.</p>}
          <div className="worldact-inline-actions">
            <button type="button" className="button" onClick={leave}>
              Back to {type === "post" ? "Posts" : "Pages"}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={lease.busy}
              onClick={() => void lease.retry(true)}
            >
              {lease.busy ? "Taking over…" : "Take over"}
            </button>
          </div>
        </Modal>
      )}
      {picker && (
        <Modal title="Featured image" close={() => setPicker(false)}>
          {pickerError && <Notice error>{pickerError}</Notice>}
          <label className="button featured-upload">
            Upload image
            <input
              type="file"
              accept="image/*"
              className="screen-reader-text"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const uploaded = await upload([file]);
                  change({ featuredMediaId: uploaded[0].id });
                  setPicker(false);
                } catch (error) {
                  setPickerError(errorText(error));
                }
              }}
            />
          </label>
          <div className="media-grid picker-grid">
            {media
              .filter((item) => item.mimeType.startsWith("image/"))
              .map((item) => (
                <button
                  className="media-item"
                  key={item.id}
                  aria-label={`Use ${item.title} as featured image`}
                  onClick={() => {
                    change({ featuredMediaId: item.id });
                    setPicker(false);
                  }}
                >
                  <img src={item.url} alt={item.alt || item.title} />
                </button>
              ))}
          </div>
          {!media.some((item) => item.mimeType.startsWith("image/")) && (
            <p>No images available. Upload your first image above.</p>
          )}
        </Modal>
      )}
      {revisionOpen && (
        <Modal title="Revisions" close={() => setRevisionOpen(false)}>
          <ResourceState
            loading={revisionBusy}
            error={revisionError}
            retry={loadRevisions}
          />
          {revisions.length ? (
            <>
              <div className="revision-toolbar">
                <label>
                  Revision
                  <select
                    value={revision?.id || ""}
                    onChange={async (e) => {
                      setRevisionError("");
                      const generation = loadGeneration.current;
                      try {
                        const { revision } = await api<{ revision: Revision }>(
                          `/posts/${postId}/revisions/${e.target.value}`,
                        );
                        if (generation === loadGeneration.current) setRevision(revision);
                      } catch (error) {
                        if (generation === loadGeneration.current) setRevisionError(errorText(error));
                      }
                    }}
                  >
                    {revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {new Date(revision.createdAt).toLocaleString()} by{" "}
                        {revision.authorName} (version {revision.version})
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button-primary"
                  disabled={revisionBusy || !revision || !lease.ready}
                  onClick={() => void restoreRevision()}
                >
                  Restore This Revision
                </button>
              </div>
              {revision && (
                <div className="revision-comparison">
                  <section>
                    <h2>Revision from {date(revision.createdAt)}</h2>
                    <h3>{revision.title || "(no title)"}</h3>
                    <p className="description">
                      {revision.authorName} · {statuses[revision.status]} · /
                      {revision.slug}
                    </p>
                    <RevisionText
                      value={revision.content}
                      other={doc.content}
                      kind="removed"
                    />
                    <h4>Excerpt</h4>
                    <p>{revision.excerpt || "—"}</p>
                    <h4>Footnotes</h4>
                    {revision.footnotes?.length ? <ol>{revision.footnotes.map(note=><li key={note.id}>{note.content.replace(/<[^>]+>/g," ")}</li>)}</ol> : <p>—</p>}
                  </section>
                  <section>
                    <h2>Current document</h2>
                    <h3>{doc.title || "(no title)"}</h3>
                    <p className="description">
                      Version {version} · {statuses[doc.status]} · /{doc.slug}
                    </p>
                    <RevisionText
                      value={doc.content}
                      other={revision.content}
                      kind="added"
                    />
                    <h4>Excerpt</h4>
                    <p>{doc.excerpt || "—"}</p>
                    <h4>Footnotes</h4>
                    {doc.footnotes.length ? <ol>{doc.footnotes.map(note=><li key={note.id}>{note.content.replace(/<[^>]+>/g," ")}</li>)}</ol> : <p>—</p>}
                  </section>
                </div>
              )}
            </>
          ) : (
            !revisionBusy && (
              <p>
                No revisions yet. Saving a change creates a revision of the
                previous version.
              </p>
            )
          )}
        </Modal>
      )}
    </div>
  );
}
function RevisionText({
  value,
  other,
  kind,
}: {
  value: string;
  other: string;
  kind: "added" | "removed";
}) {
  const text =
    new DOMParser().parseFromString(value, "text/html").body.textContent || "";
  const comparison =
    new DOMParser().parseFromString(other, "text/html").body.textContent || "";
  const tokens = text.split(/(\s+)/),
    known = new Set(comparison.split(/\s+/));
  return (
    <pre className={`revision-text revision-${kind}`}>
      {tokens.map((token, index) =>
        known.has(token) || !token.trim() ? (
          token
        ) : (
          <mark key={index}>{token}</mark>
        ),
      )}
    </pre>
  );
}
