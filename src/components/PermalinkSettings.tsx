import { useEffect, useRef, useState } from "react";
import { permalinkTokenHelp } from "../../shared/permalink-tokens";

// wp-admin/options-permalink.php default_structures; old /posts/%postname%/
// remains a custom value and is never rewritten by opening this screen.
export const permalinkPresets = [
  { id: "plain", label: "Plain", value: "" },
  { id: "day-name", label: "Day and name", value: "/%year%/%monthnum%/%day%/%postname%/" },
  { id: "month-name", label: "Month and name", value: "/%year%/%monthnum%/%postname%/" },
  { id: "numeric", label: "Numeric", value: "/archives/%post_id%" },
  { id: "post-name", label: "Post name", value: "/%postname%/" },
] as const;

export default function PermalinkSettings({ value, siteURL, onChange }: { value: string; siteURL: string; onChange: (value: string) => void }) {
  const [custom, setCustom] = useState(!permalinkPresets.some(preset => preset.value === value));
  const input = useRef<HTMLInputElement>(null);
  const ownValue = useRef(value);
  useEffect(() => {
    if (ownValue.current === value) return;
    ownValue.current = value;
    setCustom(!permalinkPresets.some(preset => preset.value === value));
  }, [value]);
  function change(next: string, customSelection: boolean) {
    ownValue.current = next; setCustom(customSelection); onChange(next);
  }
  const base = siteURL.replace(/\/$/, ""), sampleDate = new Date().toISOString().slice(0, 10).split("-");
  const examples: Record<string, string> = {
    plain: "/?p=123", "day-name": `/${sampleDate.join("/")}/sample-post/`,
    "month-name": `/${sampleDate.slice(0, 2).join("/")}/sample-post/`, numeric: "/archives/123", "post-name": "/sample-post/",
  };
  return <fieldset className="structure-selection worldact-permalink-selection">
    <legend className="screen-reader-text">Permalink structure</legend>
    {permalinkPresets.map(preset => <div className="row" key={preset.id}>
      <input id={`permalink-input-${preset.id}`} name="permalink" type="radio" value={preset.value}
        aria-describedby={`permalink-${preset.id}`} checked={!custom && value === preset.value}
        onChange={() => change(preset.value, false)} />
      <div><label htmlFor={`permalink-input-${preset.id}`}>{preset.label}</label>
        <p><code id={`permalink-${preset.id}`}>{base}{examples[preset.id]}</code></p></div>
    </div>)}
    <div className="row">
      <input id="custom_selection" name="permalink" type="radio" value="custom" checked={custom}
        onChange={() => { setCustom(true); input.current?.focus(); }} />
      <div className="worldact-custom-permalink"><label htmlFor="custom_selection">Custom Structure</label>
        <p><label className="screen-reader-text" htmlFor="permalink_structure">Custom Structure</label>
          <code id="permalink-custom">{base}</code>{" "}
          <input ref={input} id="permalink_structure" className="regular-text code" aria-describedby="permalink-custom permalink-tags"
            value={value} onChange={event => change(event.target.value, true)} /></p>
        <p id="permalink-tags" className="description">Available tags: {permalinkTokenHelp}.</p>
      </div>
    </div>
  </fieldset>;
}
