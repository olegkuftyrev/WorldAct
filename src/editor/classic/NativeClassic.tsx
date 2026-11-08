/**
 * Source port: @wordpress/block-library/src/freeform/{edit,modal,convert-to-blocks-button}.jsx.
 * Copyright Gutenberg contributors; GPL-2.0-or-later (see NOTICE.md).
 * UI/editor behavior is retained. Bridge additions place ClassicMediaSlot and
 * the source link dialog inside Modal for genuine nested focus ownership.
 */
import { useEffect, useRef, useState } from "react";
import {
  BlockControls,
  BlockIcon,
  store as blockEditorStore,
  useBlockProps,
} from "@wordpress/block-editor";
import {
  Button,
  Flex,
  FlexItem,
  Modal,
  Placeholder,
  ToolbarButton,
  ToolbarGroup,
} from "@wordpress/components";
import { useDispatch, useSelect } from "@wordpress/data";
import { RawHTML } from "@wordpress/element";
import { rawHandler, serialize } from "@wordpress/blocks";
import { __ } from "@wordpress/i18n";
import { classic, fullscreen } from "@wordpress/icons";
import { useViewportMatch } from "@wordpress/compose";
import { ClassicMediaSlot } from "./ClassicSupport";
import { classicImageWindow } from "./imageWindow";
import { containClassicToolbar, containClassicWindow } from "./floating";
import { protectClassicCaptionAttributes } from "./content";
import type { ClassicWindow } from "./lifecycle";
function ConvertToBlocks({ clientId }: { clientId: string }) {
  const { replaceBlocks } = useDispatch(blockEditorStore),
    block = useSelect(
      (select) => select(blockEditorStore).getBlock(clientId),
      [clientId],
    );
  return (
    <ToolbarButton
      disabled={!block}
      onClick={() => {
        if (block)
          replaceBlocks(block.clientId, rawHandler({ HTML: protectClassicCaptionAttributes(serialize(block)) }));
      }}
    >
      {__("Convert to blocks")}
    </ToolbarButton>
  );
}
function AuxiliaryActions({
  onClick,
  isModalFullScreen,
}: {
  onClick: () => void;
  isModalFullScreen: boolean;
}) {
  const mobile = useViewportMatch("small", "<");
  if (mobile) return null;
  return (
    <Button
      size="compact"
      onClick={onClick}
      icon={fullscreen}
      isPressed={isModalFullScreen}
      label={isModalFullScreen ? __("Exit fullscreen") : __("Enter fullscreen")}
    />
  );
}
function ClassicEdit({
  id,
  defaultValue,
}: {
  id: string;
  defaultValue: string;
}) {
  const styles = useSelect(
    (select) => select(blockEditorStore).getSettings().styles,
    [],
  );
  useEffect(() => {
    const win = window as unknown as ClassicWindow,
      { baseURL, suffix, settings } = win.wpEditorL10n.tinymce;
    // Source wpLink is a singleton. Keep its fixed DOM inside the owning modal
    // while mounted, then return it before React removes the modal subtree.
    const host = document
      .getElementById(id)
      ?.closest(".components-modal__content");
    const dialogs = ["wp-link-backdrop", "wp-link-wrap"]
      .map((key) => document.getElementById(key))
      .filter((node): node is HTMLElement => !!node);
    if (host) dialogs.forEach((node) => host.appendChild(node));
    win.tinymce.EditorManager.overrideDefaults({ base_url: baseURL, suffix });
    win.wp.oldEditor.initialize(id, {
      tinymce: {
        ...settings,
        setup(editor: any) {
          editor.on("BeforeSetContent", (event: any) => {
            if (event.format !== "raw") event.content = protectClassicCaptionAttributes(event.content);
          }, true);
          editor.on("init", () => {
            const doc = editor.getDoc();
            const sourceOpen = editor.windowManager.open;
            editor.windowManager.open = function (spec: any, ...args: any[]) {
              return sourceOpen.call(
                this,
                spec.title === "Insert/edit image" ||
                  spec.title === "Insert/edit media"
                  ? classicImageWindow(
                      spec,
                      window.innerWidth,
                      window.innerHeight,
                    )
                  : spec,
                ...args,
              );
            };
            editor.on("dblclick", (event: any) => {
              const node = editor.dom.getParent(
                event.target,
                "[data-mce-object=audio],[data-mce-object=video]",
              );
              if (node) {
                editor.selection.select(node);
                editor.execCommand("mceMedia");
              }
            });
            editor.on("OpenWindow", (event: any) => {
              const frame = document
                .getElementById(id)
                ?.closest(".components-modal__frame");
              if (frame)
                containClassicWindow(event.win, frame as HTMLElement, window);
            });
            editor.on("wptoolbar", (event: any) => {
              const frame = document
                .getElementById(id)
                ?.closest(".components-modal__frame");
              if (frame)
                containClassicToolbar(
                  event.toolbar,
                  frame as HTMLElement,
                  window,
                );
            });
            (styles || []).forEach(({ css }) => {
              if (!css) return;
              const style = doc.createElement("style");
              style.innerHTML = css;
              doc.head.appendChild(style);
            });
          });
        },
      },
    });
    return () => {
      win.wp.oldEditor.remove(id);
      dialogs.forEach((node) => document.body.appendChild(node));
      const blocker = document.getElementById("mce-modal-block");
      if (blocker && host?.contains(blocker))
        document.body.appendChild(blocker);
    };
  }, []);
  return <textarea id={id} defaultValue={defaultValue} />;
}
function ModalEdit({
  clientId,
  content,
  onClose,
  onChange,
}: {
  clientId: string;
  content: string;
  onClose: () => void;
  onChange: (html: string) => void;
}) {
  const [full, setFull] = useState(false),
    id = `editor-${clientId}`;
  return (
    <Modal
      title={__("Classic Editor")}
      onRequestClose={onClose}
      shouldCloseOnClickOutside={false}
      overlayClassName="block-editor-freeform-modal"
      isFullScreen={full}
      className="block-editor-freeform-modal__content"
      headerActions={
        <AuxiliaryActions
          onClick={() => setFull(!full)}
          isModalFullScreen={full}
        />
      }
    >
      <ClassicEdit id={id} defaultValue={content} />
      <ClassicMediaSlot />
      <Flex
        className="block-editor-freeform-modal__actions"
        justify="flex-end"
        expanded={false}
      >
        <FlexItem>
          <Button __next40pxDefaultSize variant="tertiary" onClick={onClose}>
            {__("Cancel")}
          </Button>
        </FlexItem>
        <FlexItem>
          <Button
            __next40pxDefaultSize
            variant="primary"
            onClick={() => {
              onChange(
                (window as unknown as ClassicWindow).wp.oldEditor.getContent(
                  id,
                ),
              );
              onClose();
            }}
          >
            {__("Save")}
          </Button>
        </FlexItem>
      </Flex>
    </Modal>
  );
}
export function NativeClassicEdit({
  attributes,
  setAttributes,
  clientId,
}: {
  attributes: { content: string };
  setAttributes: (attributes: { content: string }) => void;
  clientId: string;
}) {
  const [open, setOpen] = useState(false),
    editButton = useRef<HTMLButtonElement>(null),
    canRemove = useSelect(
      (select) => select(blockEditorStore).canRemoveBlock(clientId),
      [clientId],
    );
  return (
    <>
      {canRemove && (
        <BlockControls>
          <ToolbarGroup className="worldact-classic-tools">
            <ConvertToBlocks clientId={clientId} />
          </ToolbarGroup>
        </BlockControls>
      )}
      <BlockControls>
        <ToolbarGroup className="worldact-classic-tools">
          <ToolbarButton ref={editButton} onClick={() => setOpen(true)}>
            {__("Edit")}
          </ToolbarButton>
        </ToolbarGroup>
      </BlockControls>
      <div {...useBlockProps()}>
        {attributes.content ? (
          <RawHTML>{attributes.content}</RawHTML>
        ) : (
          <Placeholder
            icon={<BlockIcon icon={classic} />}
            label={__("Classic")}
            instructions={__("Use the classic editor to add content.")}
          >
            <Button
              __next40pxDefaultSize
              variant="primary"
              onClick={() => setOpen(true)}
            >
              {__("Edit contents")}
            </Button>
          </Placeholder>
        )}
        {open && (
          <ModalEdit
            clientId={clientId}
            content={attributes.content}
            onClose={() => {
              setOpen(false);
              editButton.current?.focus();
            }}
            onChange={(content) => setAttributes({ content })}
          />
        )}
      </div>
    </>
  );
}
