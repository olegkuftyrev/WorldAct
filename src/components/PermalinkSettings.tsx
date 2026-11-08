import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { permalinkTokens } from "../../shared/permalink-tokens";

// wp-admin/options-permalink.php default_structures; old /posts/%postname%/
// remains a custom value and is never rewritten by opening this screen.
export const permalinkPresets = [
  { id: "plain", label: "Plain", value: "" },
  { id: "day-name", label: "Day and name", value: "/%year%/%monthnum%/%day%/%postname%/" },
  { id: "month-name", label: "Month and name", value: "/%year%/%monthnum%/%postname%/" },
  { id: "numeric", label: "Numeric", value: "/archives/%post_id%" },
  { id: "post-name", label: "Post name", value: "/%postname%/" },
] as const;

// wp-admin/options-permalink.php available_tags; keep controls driven by the
// shared supported-token inventory, including new tokens when they are enabled.
const tagExplanations: Record<string, string> = {
  year: "The year of the post, four digits, for example 2004.",
  monthnum: "Month of the year, for example 05.",
  day: "Day of the month, for example 28.",
  hour: "Hour of the day, for example 15.",
  minute: "Minute of the hour, for example 43.",
  second: "Second of the minute, for example 33.",
  post_id: "The unique ID of the post, for example 423.",
  postname: "The sanitized post title (slug).",
  category: "Category slug. Nested sub-categories appear as nested directories in the URL.",
  author: "A sanitized version of the author name.",
};
const selectionFor = (value: string) => permalinkPresets.some(preset => preset.value === value) ? value : "custom";

export default function PermalinkSettings({ value, siteURL, onChange }: { value: string; siteURL: string; onChange: (value: string) => void }) {
  const [selection, setSelection] = useState(() => selectionFor(value));
  const [tagValue, setTagValue] = useState(value);
  const [announcement, setAnnouncement] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const inputFocused = useRef(false);
  const pendingSelection = useRef<{ value: string; position: number } | null>(null);
  const ownValue = useRef(value);
  useEffect(() => {
    if (ownValue.current === value) return;
    ownValue.current = value;
    pendingSelection.current = null;
    setSelection(selectionFor(value));
    setTagValue(value);
  }, [value]);
  // Apply the source cursor/focus behavior after React commits the new value.
  // There is no delayed callback that can act on a later settings generation.
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    pendingSelection.current = null;
    if (pending && input.current?.value === pending.value) {
      input.current.setSelectionRange(pending.position, pending.position);
      input.current.focus();
    }
  });
  function change(next: string, nextSelection: string) {
    ownValue.current = next; setSelection(nextSelection); onChange(next);
  }
  function toggleTag(name: string) {
    const field = input.current;
    if (!field) return;
    const token = `%${name}%`, current = field.value;
    // wp-admin/js/common.js: a used tag removes its first tag-plus-slash,
    // preserving the selected radio and button focus, even for a preset.
    if (current.includes(token)) {
      const removed = current.replace(token + "/", "");
      const next = removed === "/" ? "" : removed;
      change(next, selection);
      setTagValue(next);
      setAnnouncement(`${name} removed from permalink structure`);
      return;
    }
    let start = field.selectionStart ?? 0, end = field.selectionEnd ?? 0;
    if (!inputFocused.current && start === 0 && end === 0) start = end = current.length;
    let inserted = token;
    if (current.slice(0, start).slice(-1) !== "/") inserted = "/" + inserted;
    if (current.slice(end, end + 1) !== "/") inserted += "/";
    const next = current.slice(0, start) + inserted + current.slice(end);
    if (inputFocused.current) pendingSelection.current = { value: next, position: start + inserted.length };
    change(next, "custom");
    setTagValue(next);
    setAnnouncement(`${name} added to permalink structure`);
  }
  const base = siteURL.replace(/\/$/, ""), sampleDate = new Date().toISOString().slice(0, 10).split("-");
  const examples: Record<string, string> = {
    plain: "/?p=123", "day-name": `/${sampleDate.join("/")}/sample-post/`,
    "month-name": `/${sampleDate.slice(0, 2).join("/")}/sample-post/`, numeric: "/archives/123", "post-name": "/sample-post/",
  };
  return <fieldset className="structure-selection worldact-permalink-selection">
    <legend className="screen-reader-text">Permalink structure</legend>
    {permalinkPresets.map(preset => <div className="row" key={preset.id}>
      <input id={`permalink-input-${preset.id}`} name="selection" type="radio" value={preset.value}
        aria-describedby={`permalink-${preset.id}`} checked={selection === preset.value}
        onChange={() => { change(preset.value, preset.value); setTagValue(preset.value); }} />
      <div><label htmlFor={`permalink-input-${preset.id}`}>{preset.label}</label>
        <p><code id={`permalink-${preset.id}`}>{base}{examples[preset.id]}</code></p></div>
    </div>)}
    <div className="row">
      <input id="custom_selection" name="selection" type="radio" value="custom" checked={selection === "custom"}
        onChange={() => setSelection("custom")} />
      <div className="worldact-custom-permalink"><label htmlFor="custom_selection">Custom Structure</label>
        <p><label className="screen-reader-text" htmlFor="permalink_structure">Customize permalink structure by selecting available tags</label>
          <span className="code"><code id="permalink-custom">{base}</code>
            <input ref={input} name="permalink_structure" id="permalink_structure" type="text" className="regular-text code" aria-describedby="permalink-custom"
              value={value} onClick={() => setSelection("custom")} onFocus={() => { inputFocused.current = true; }}
              onChange={event => change(event.target.value, "custom")} onBlur={event => setTagValue(event.target.value)} /></span></p>
        <div className="available-structure-tags hide-if-no-js">
          <div id="custom_selection_updated" aria-live="assertive" className="screen-reader-text">{announcement}</div>
          <fieldset><legend>Available tags:</legend>
            <ul role="list">{permalinkTokens.map(({ name }) => {
              const token = `%${name}%`, used = tagValue.includes(token);
              const label = `${name} (${tagExplanations[name]})`;
              const usedLabel = `${name} (already used in permalink structure)`;
              return <li key={name}><button type="button" className={`button button-secondary${used ? " active" : ""}`}
                aria-label={used ? usedLabel : label} aria-pressed={used}
                data-label={label} data-used={usedLabel} data-added={`${name} added to permalink structure`} data-removed={`${name} removed from permalink structure`}
                onClick={() => toggleTag(name)}>{token}</button></li>;
            })}</ul>
          </fieldset>
        </div>
      </div>
    </div>
  </fieldset>;
}
