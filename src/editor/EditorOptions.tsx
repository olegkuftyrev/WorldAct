import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Button, Card, CardBody, CardHeader, DropdownMenu, FlexItem, MenuGroup, MenuItem, MenuItemsChoice, Modal, Navigator, Notice, TabPanel, ToggleControl, __experimentalHStack as HStack, __experimentalItem as Item, __experimentalItemGroup as ItemGroup, __experimentalText as Text } from "@wordpress/components";
import { chevronLeft, chevronRight, external, moreVertical } from "@wordpress/icons";
import type { EditorPreferences } from "../../shared/editor-preferences";
import type { EditorPreferencePatch } from "./preferenceQueue";
import "./options.css";

export const appleKeyboard = () => /Mac|iPod|iPhone|iPad/.test(navigator.platform);
export function shortcutLabels() { const apple = appleKeyboard(); return { mode: apple ? "⇧⌥⌘M" : "Ctrl+Shift+Alt+M", distraction: apple ? "⇧⌘\\" : "Ctrl+Shift+\\", help: apple ? "⌃⌥H" : "Alt+Shift+H", undo: apple ? "⌘Z" : "Ctrl+Z", redo: apple ? "⇧⌘Z" : "Ctrl+Shift+Z" }; }
function useLargeViewport() { const [large, setLarge] = useState(() => matchMedia("(min-width:782px)").matches); useEffect(() => { const media = matchMedia("(min-width:782px)"), changed = () => setLarge(media.matches); media.addEventListener("change", changed); return () => media.removeEventListener("change", changed); }, []); return large; }
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) { return <fieldset className="preferences-modal__section"><legend className="preferences-modal__section-legend"><h2 className="preferences-modal__section-title">{title}</h2>{description && <p className="preferences-modal__section-description">{description}</p>}</legend><div className="preferences-modal__section-content">{children}</div></fieldset>; }
function RetireMenu({ disabled, close }: { disabled: boolean; close: () => void }) {
  useLayoutEffect(() => { if (disabled) close(); }, [disabled, close]);
  return null;
}

/** Source MoreMenu/PreferencesModal composition with WorldAct's account owner.
 * Public components replace the source private preference/editor store hooks.
 */
export default function EditorOptions({ value, update, copy, disabled = false, dialog, setDialog, error, dismissError }: { value: EditorPreferences; update: (patch: EditorPreferencePatch) => void; copy: () => void; disabled?: boolean; dialog: "preferences" | "shortcuts" | null; setDialog: (value: "preferences" | "shortcuts" | null) => void; error?: string; dismissError?: () => void }) {
  const large = useLargeViewport(), keys = shortcutLabels();
  const toggle = (key: "fixedToolbar" | "distractionFree" | "focusMode" | "fullscreenMode") => update({ [key]: !value[key] });
  const check = (key: "fixedToolbar" | "distractionFree" | "focusMode" | "fullscreenMode", label: string, info: string, shortcut?: string) => <MenuItem role="menuitemcheckbox" isSelected={value[key]} onClick={() => toggle(key)} info={info} shortcut={shortcut}>{label}</MenuItem>;
  const control = (key: Exclude<keyof EditorPreferences, "editorMode" | "fullscreenMode">, label: string, help: string) => <ToggleControl className="preference-base-option" label={label} help={help} checked={value[key]} onChange={next => update({ [key]: next })} __nextHasNoMarginBottom />;
  const sections = [
    { name: "general", title: "General", content: <Section title="Interface">{control("showListViewByDefault", "Always open List View", "Opens the List View panel by default.")}{control("showBlockBreadcrumbs", "Show block breadcrumbs", "Display the block hierarchy trail at the bottom of the editor.")}</Section> },
    { name: "appearance", title: "Appearance", content: <Section title="Appearance" description="Customize the editor interface to suit your needs.">{control("fixedToolbar", "Top toolbar", "Access all block and document tools in a single place.")}{control("distractionFree", "Distraction free", "Reduce visual distractions by hiding the toolbar and other elements to focus on writing.")}{control("focusMode", "Spotlight mode", "Highlights the current block and fades other content.")}</Section> },
    { name: "accessibility", title: "Accessibility", content: <><Section title="Navigation" description="Optimize the editing experience for enhanced control.">{control("keepCaretInsideBlock", "Contain text cursor inside block", "Keeps the text cursor within blocks while navigating with arrow keys, preventing it from moving to other blocks and enhancing accessibility for keyboard users.")}</Section><Section title="Interface">{control("showIconLabels", "Show button text labels", "Show text instead of icons on buttons across the interface.")}</Section></> },
  ];
  return <>
    <DropdownMenu icon={value.showIconLabels ? null : moreVertical} label="Options" text={value.showIconLabels ? "Options" : undefined} className="worldact-editor-options" popoverProps={{ placement: "bottom-end", className: "more-menu-dropdown__content" }} toggleProps={{ showTooltip: !value.showIconLabels, ...(value.showIconLabels ? { variant: "tertiary" as const } : {}), tooltipPosition: "bottom", size: "compact", disabled }}>
      {({ onClose }) => <>
        <RetireMenu disabled={disabled} close={onClose}/>
        <MenuGroup label="View">
          {check("fixedToolbar", "Top toolbar", "Access all block and document tools in a single place")}
          {check("distractionFree", "Distraction free", "Write with calmness", keys.distraction)}
          {check("focusMode", "Spotlight mode", "Focus on one block at a time")}
          {check("fullscreenMode", "Fullscreen mode", "Show and hide the admin user interface")}
        </MenuGroup>
        <MenuGroup label="Editor"><MenuItemsChoice choices={[{ value: "visual", label: "Visual editor", ...(value.editorMode !== "visual" ? { shortcut: keys.mode } : {}) }, { value: "text", label: "Code editor", ...(value.editorMode !== "text" ? { shortcut: keys.mode } : {}) }]} value={value.editorMode} onSelect={next => { update({ editorMode: next as "visual" | "text" }); onClose(); }} /></MenuGroup>
        <MenuGroup label="Tools">
          <MenuItem shortcut={keys.help} onClick={() => { onClose(); setDialog("shortcuts"); }}>Keyboard shortcuts</MenuItem>
          <MenuItem onClick={() => { copy(); onClose(); }}>Copy all blocks</MenuItem>
          <MenuItem icon={external} href="https://wordpress.org/documentation/article/wordpress-block-editor/" {...{ target: "_blank", rel: "noopener noreferrer" }}>Help<span className="screen-reader-text"> (opens in a new tab)</span></MenuItem>
        </MenuGroup>
        <MenuGroup><MenuItem onClick={() => { onClose(); setDialog("preferences"); }}>Preferences</MenuItem></MenuGroup>
      </>}
    </DropdownMenu>
    {dialog === "preferences" && <Modal className="preferences-modal worldact-editor-preferences" title="Preferences" onRequestClose={() => setDialog(null)}>
      {error && <Notice status="error" onRemove={dismissError}>{error}</Notice>}
      {large ? <TabPanel className="preferences__tabs" orientation="vertical" tabs={sections.map(({ name, title }) => ({ name, title }))}>{tab => <div className="preferences__tabs-tabpanel">{sections.find(section => section.name === tab.name)?.content}</div>}</TabPanel> : <Navigator initialPath="/" className="preferences__provider"><Navigator.Screen path="/"><Card isBorderless size="small"><CardBody><ItemGroup>{sections.map(section => <Navigator.Button key={section.name} path={`/${section.name}`} as={Item}><HStack justify="space-between"><FlexItem>{section.title}</FlexItem><FlexItem><span aria-hidden="true">›</span></FlexItem></HStack></Navigator.Button>)}</ItemGroup></CardBody></Card></Navigator.Screen>{sections.map(section => <Navigator.Screen key={section.name} path={`/${section.name}`}><Card isBorderless size="large"><CardHeader isBorderless={false} justify="left" size="small" gap="6" as="div"><Navigator.BackButton icon={chevronLeft} label="Back"/><Text size="16">{section.title}</Text></CardHeader><CardBody>{section.content}</CardBody></Card></Navigator.Screen>)}</Navigator>}
    </Modal>}
    {dialog === "shortcuts" && <Modal title="Keyboard shortcuts" className="worldact-editor-shortcuts" onRequestClose={() => setDialog(null)}><h2>Global shortcuts</h2><dl>{[["Switch between visual editor and code editor.", keys.mode], ["Enter or exit distraction free mode.", keys.distraction], ["Display these keyboard shortcuts.", keys.help], ["Undo your last changes.", keys.undo], ["Redo your last undo.", keys.redo]].map(([description, key]) => <div key={description}><dt>{description}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl></Modal>}
  </>;
}
