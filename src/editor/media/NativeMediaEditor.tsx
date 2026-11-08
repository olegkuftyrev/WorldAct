import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import apiFetch from "@wordpress/api-fetch";
import { createRegistry, dispatch, RegistryProvider, useRegistry, type DataRegistry } from "@wordpress/data";
import { BlockEditorProvider, privateApis as blockEditorPrivateApis, useSettings, store as blockEditorStore } from "@wordpress/block-editor";
import { privateApis as mediaEditorPrivateApis } from "@wordpress/media-editor";
import { store as coreDataStore } from "@wordpress/core-data";
import { SnackbarNotices, store as noticesStore } from "@wordpress/notices";
import { decodeEntities } from "@wordpress/html-entities";
import {
  altTextField, attachedToField, authorField, captionField, dateAddedField,
  descriptionField, filenameField, filesizeField, mediaDimensionsField, mimeTypeField,
} from "@wordpress/media-fields";
import { unlock } from "@worldact/wordpress-lock-unlock";
import { createMediaModalOwner, type MediaModalOptions } from "./modalOwner";
import { nativeAspectRatioPresets } from "./aspectRatios";
import { createOpeningRegistry } from "./openingRegistry";
import { api, type Media } from "../../api";
import "../../../node_modules/@wordpress/media-editor/build-style/style.css";
import "../../../node_modules/@wordpress/media-fields/build-style/style.css";
import "@wordpress/notices/build-style/style.css";
import "@wordpress/dataviews/build-style/style.css";
import "./native-media.css";
import { changedImageAttributes, imageAttributes, type ImageAttributes, type NativeImageChange } from "./sourceRebase";
import type { Block } from "@wordpress/blocks";

type ImageSnapshot = Map<string, ImageAttributes>;
export type NativeMediaDocument = {
  update: (change: NativeImageChange) => void;
  undo: (runNativeUndo: () => NativeImageChange | undefined) => void;
};
function snapshot(registry: DataRegistry | null): ImageSnapshot {
  const result: ImageSnapshot = new Map();
  const visit = (blocks: Block[]) => { for (const block of blocks) { const attributes=imageAttributes(block); if(attributes)result.set(block.clientId,attributes); visit(block.innerBlocks || []); } };
  if(registry)visit(registry.select(blockEditorStore).getBlocks());
  return result;
}
function NativeDocumentBridge({ connect }: { connect: (registry: DataRegistry) => () => void }) {
  const registry=useRegistry(); useLayoutEffect(()=>connect(registry),[connect,registry]); return null;
}

const { store, MediaEditorModal } = unlock(mediaEditorPrivateApis);
const { mediaEditKey, openMediaEditorModalKey } = unlock(blockEditorPrivateApis);
// The public wrapper deliberately strips Symbol settings. Use the installed
// source provider so Image's real private callbacks reach its native hook.
export const NativeBlockEditorProvider: typeof BlockEditorProvider = unlock(blockEditorPrivateApis).ExperimentalBlockEditorProvider;

// The title field is the small source fields/title definition from the supplied
// wp-includes/js/dist/editor.js. Other fields are the official media-fields.
// Its DataForm supplies the native text control; no core/editor store is loaded.
const titleField = {
  type: "text", id: "title", label: "Title", placeholder: "No title",
  getValue: ({ item }: any) => decodeEntities(typeof item.title === "string" ? item.title : item.title?.rendered ?? item.title?.raw ?? "") || "(no title)",
  enableHiding: true, enableGlobalSearch: true, filterBy: false,
};
const fields = [dateAddedField, authorField, filenameField, mimeTypeField, filesizeField,
  mediaDimensionsField, attachedToField, titleField, altTextField, captionField, descriptionField];

function NativeMediaModalContent({ registry }: { registry: ReturnType<typeof createRegistry> }) {
  const [defaults, theme, showDefaults] = useSettings(
    "dimensions.aspectRatios.default", "dimensions.aspectRatios.theme", "dimensions.defaultAspectRatios",
  );
  const aspectRatioPresets = useMemo(() => nativeAspectRatioPresets(defaults, theme, showDefaults), [defaults, theme, showDefaults]);
  return <RegistryProvider value={registry}><MediaEditorModal fields={fields} aspectRatioPresets={aspectRatioPresets} /></RegistryProvider>;
}

type Opening = {
  key: number;
  registry: ReturnType<typeof createRegistry>;
  owner: ReturnType<typeof createMediaModalOwner>;
  closed: boolean;
  retired: boolean;
  unsubscribe: () => void;
  dispose: () => void;
};

export function useNativeMediaEditor(onError: (message: string) => void, onMediaUpdate: (item: Media) => void, resetKey: number, document?: NativeMediaDocument) {
  const parentRegistry = useRegistry();
  const mounted = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const refreshes = useRef(new Set<AbortController>());
  const sequence = useRef(0);
  const entries = useRef(new Set<Opening>());
  const activeRef = useRef<Opening | null>(null);
  const documentRegistry = useRef<DataRegistry | null>(null), documentOwner = useRef(document); documentOwner.current=document;
  const connectDocument = useCallback((registry: DataRegistry) => { documentRegistry.current=registry; return ()=>{ if(documentRegistry.current===registry)documentRegistry.current=null; }; },[]);
  const [active, setActive] = useState<Opening | null>(null);
  const [openings, setOpenings] = useState<Opening[]>([]);

  const remove = useCallback((entry: Opening) => {
    if (!entries.current.delete(entry)) return;
    entry.unsubscribe();
    entry.dispose();
    if (mounted.current) setOpenings(current => current.filter(value => value !== entry));
  }, []);
  const retire = useCallback((entry: Opening) => {
    entry.retired = true;
    entry.owner.dispose();
    remove(entry);
  }, [remove]);
  useEffect(() => {
    mounted.current = true;
    setActive(null);
    setOpenings([]);
    return () => {
      mounted.current = false;
      pending.current?.abort();
      for (const request of refreshes.current) request.abort();
      refreshes.current.clear();
      for (const entry of entries.current) retire(entry);
      activeRef.current = null;
    };
  }, [retire, resetKey]);

  const open = useCallback(async (options: MediaModalOptions) => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    try {
      // A visible local image is not necessarily editable by this actor.
      // Do not mount the source modal around a forbidden/missing record.
      const record = await apiFetch<any>({ path: `/wp/v2/media/${options.id}?context=edit`, signal: request.signal });
      if (request.signal.aborted || !mounted.current) return;
      dispatch(coreDataStore).receiveEntityRecords("postType", "attachment", record);
      // Each opening owns the genuine source stores. An old async onSaved
      // may finish after retirement; its unconditional native close/notice
      // must remain in that old registry, never affect the next opening.
      const scope = createOpeningRegistry(parentRegistry);
      const registry = scope.registry;
      registry.register(store);
      registry.register(noticesStore);
      // A retired source save clears its attachment edits after /edit resolves.
      // Own the genuine entity store too, so reopening the same image cannot
      // have its new Details draft erased by that older save.
      registry.register(coreDataStore);
      try {
        await registry.dispatch(coreDataStore).receiveEntityRecords("postType", "attachment", record);
      } catch (error) {
        scope.dispose();
        throw error;
      }
      if (request.signal.aborted || !mounted.current) {
        scope.dispose();
        return;
      }
      if (activeRef.current) retire(activeRef.current);
      const entry: Opening = {
        key: ++sequence.current, registry, closed: false, retired: false,
        unsubscribe: () => {},
        dispose: scope.dispose,
        owner: createMediaModalOwner({
          open: value => (registry.dispatch(store) as any).openMediaEditorModal(value),
          close: () => (registry.dispatch(store) as any).closeMediaEditorModal(),
          currentUpdate: () => (registry.select(store) as any).getOnUpdate(),
        }),
      };
      const removeWhenEmpty = () => {
        if (entry.closed && !(registry.select(noticesStore).getNotices() || []).length) remove(entry);
      };
      entry.unsubscribe = registry.subscribe(() => queueMicrotask(removeWhenEmpty), noticesStore);
      const canvasRegistry=documentRegistry.current;
      let saved: {clientId:string;after:ImageAttributes} | undefined;
      entry.owner.open({
        ...options,
        onUpdate: async update => {
          const before=snapshot(canvasRegistry);
          const result = await options.onUpdate?.(update);
          if(!mounted.current || entry.retired)return result;
          const after=snapshot(canvasRegistry);
          const changed=[...after].filter(([clientId,attributes])=>before.get(clientId)?.id===options.id && attributes.id===update.id && Object.keys(changedImageAttributes(before.get(clientId)!,attributes)).length);
          if(changed.length===1){ const [clientId,attributes]=changed[0]; saved={clientId,after:attributes};documentOwner.current?.update({clientId,expected:before.get(clientId)!,changes:changedImageAttributes(before.get(clientId)!,attributes)}); }
          const refresh = new AbortController();
          refreshes.current.add(refresh);
          // The real React picker also needs newly created attachments and
          // metadata changes. Refresh its ordinary DTO rather than inventing
          // local fields from the native attachment response.
          void api<{ media: Media }>(`/media/${update.id}`, { signal: refresh.signal })
            .then(({ media }) => { if (mounted.current && !entry.retired && !refresh.signal.aborted) onMediaUpdate(media); })
            .catch(() => {})
            .finally(() => refreshes.current.delete(refresh));
          return result;
        },
        onUndo: options.onUndo ? () => {
          if(!mounted.current || entry.retired)return;
          const run=()=>{
            const before=snapshot(canvasRegistry); options.onUndo!(); const after=snapshot(canvasRegistry);
            if(!saved)return;
            const original=before.get(saved.clientId),restored=after.get(saved.clientId);
            if(!original || !restored)return;
            return {clientId:saved.clientId,expected:saved.after,changes:changedImageAttributes(original,restored)};
          };
          if(documentOwner.current)documentOwner.current.undo(run);else run();
        } : undefined,
        onClose: () => {
          if (entry.retired) return;
          entry.closed = true;
          if (activeRef.current === entry) activeRef.current = null;
          if (mounted.current) setActive(current => current === entry ? null : current);
          options.onClose?.();
          // Native onSaved creates its source Undo notice just after close.
          queueMicrotask(removeWhenEmpty);
        },
      });
      entries.current.add(entry);
      activeRef.current = entry;
      setOpenings(current => [...current, entry]);
      setActive(entry);
    } catch (error) {
      if (!request.signal.aborted && mounted.current) onError(error instanceof Error ? error.message : (error as any)?.message || "This media item could not be opened.");
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }, [onError, onMediaUpdate, parentRegistry, remove, retire]);
  const settings = useMemo(() => ({
    imageEditing: true,
    [mediaEditKey]: unlock(dispatch(coreDataStore)).editMediaEntity,
    [openMediaEditorModalKey]: open,
  }), [open]);
  return {
    bridge: <NativeDocumentBridge connect={connectDocument}/>,
    settings,
    modal: active ? <NativeMediaModalContent key={active.key} registry={active.registry} /> : null,
    notices: <div className="worldact-native-media-notice-stack">{openings.map(entry =>
      <RegistryProvider key={entry.key} value={entry.registry}><SnackbarNotices className="worldact-native-media-notices" /></RegistryProvider>
    )}</div>,
  };
}
