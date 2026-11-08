import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, json } from "../api";
import { Notice, ResourceState, ScreenTabs, errorText } from "../components/AdminUI";
import { ConnectorOperation, saveConnector, type Connector } from "../connectors";
import "../connectors.css";

export default function Connectors() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState(""), [send, setSend] = useState(false);
  const operation = useRef(new ConnectorOperation()), loadingOperation = useRef(new ConnectorOperation());
  const revision = useRef(0), actionRef = useRef<HTMLButtonElement>(null), inputRef = useRef<HTMLInputElement>(null);
  const connector = connectors?.find(item => item.id === "akismet");
  const receive = (next: Connector) => setConnectors(current => (current || []).map(item => item.id === next.id ? next : item));
  async function load(clearError = true) {
    const owner = loadingOperation.current.start();
    setLoading(true); if (clearError) setError("");
    try {
      const result = await api<{ connectors: Connector[] }>("/connectors", { signal: owner.signal });
      if (owner.current()) {
        setConnectors(result.connectors);
        if (!result.connectors.find(item => item.id === "akismet")?.active) setExpanded(false);
      }
    } catch (reason) { if (owner.current()) setError(errorText(reason)); }
    finally { if (owner.current()) setLoading(false); }
  }
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("worldact-plugins-updated", refresh);
    return () => { operation.current.cancel(); loadingOperation.current.cancel(); window.removeEventListener("worldact-plugins-updated", refresh); };
  }, []);
  useEffect(() => { if (expanded) inputRef.current?.focus(); }, [expanded]);
  function close() {
    operation.current.cancel(); revision.current++; setBusy(false); setExpanded(false); setApiKey("");
    actionRef.current?.focus();
  }
  async function open() {
    if (!connector) return;
    if (expanded) { close(); return; }
    if (connector.active) {
      revision.current++; setApiKey(""); setSend(connector.sendComments); setExpanded(true); setError(""); return;
    }
    const owner = operation.current.start(); setBusy(true); setError(""); setNotice("");
    try {
      if (!connector.installed) await api("/plugins/akismet/install", { ...json("POST", {}), signal: owner.signal });
      if (!owner.current()) return;
      await api("/plugins/akismet", { ...json("PUT", { enabled: true }), signal: owner.signal });
      if (!owner.current()) return;
      const result = await api<{ connectors: Connector[] }>("/connectors", { signal: owner.signal });
      if (!owner.current()) return;
      const next = result.connectors.find(item => item.id === "akismet");
      setConnectors(result.connectors); setSend(Boolean(next?.sendComments)); setExpanded(true);
      setNotice("Plugin for Akismet activated successfully.");
      window.dispatchEvent(new Event("worldact-plugins-updated"));
    } catch (reason) { if (owner.current()) { setError(errorText(reason)); void load(false); } }
    finally { if (owner.current()) setBusy(false); }
  }
  async function save(clear = false) {
    const owner = operation.current.start(), draft = revision.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const message = await saveConnector(api, { apiKey: clear ? "" : apiKey, sendComments: clear ? false : send, ...(clear ? { clearApiKey: true } : {}) }, owner, receive);
      if (!owner.current()) return;
      if (draft === revision.current) {
        setApiKey("");
        if (clear) setSend(false);
      }
      setNotice(message || "Settings saved.");
      window.dispatchEvent(new Event("worldact-plugins-updated"));
    } catch (reason) { if (owner.current()) { setError(errorText(reason)); void load(false); } }
    finally { if (owner.current()) setBusy(false); }
  }
  return <>
    <ScreenTabs />
    <main className="wrap worldact-connectors">
      <h1>Connectors</h1>
      {error && <Notice error onDismiss={() => setError("")}>{error}</Notice>}
      {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
      <ResourceState loading={loading && !connectors} error="" />
      {!loading && !connectors && <button type="button" className="button" onClick={() => void load()}>Try again</button>}
      <div className="connectors-page" role="list">
        {connector && <section className="connector-item" role="listitem" aria-labelledby="akismet-connector-name">
          <div className="connector-item__header">
            <div className="connector-item__identity"><img src="/vendor/wordpress/connectors/akismet.svg" width="40" height="40" alt=""/><h2 id="akismet-connector-name">{connector.name}</h2></div>
            <div className="connector-item__actions">
              {connector.connected && <span className="connector-connected">Connected</span>}
              <button ref={actionRef} className={expanded || connector.connected ? "button-link" : "button"} type="button" aria-expanded={expanded} aria-controls="akismet-connector-settings" disabled={busy && !expanded} onClick={() => void open()}>{expanded ? "Cancel" : busy ? connector.installed ? "Activating…" : "Installing…" : !connector.installed ? "Install" : !connector.active ? "Activate" : connector.connected ? "Edit" : "Set up"}</button>
            </div>
          </div>
          <p>{connector.description}</p>
          <p className="description connector-status">{!connector.installed ? "Plugin not installed." : !connector.active ? "Plugin installed, but inactive." : !connector.apiKeyConfigured ? "No API key configured." : connector.connected ? "API key verified. Comment processing is enabled." : connector.lastServiceError === "invalid" ? "API key verification failed." : connector.lastServiceError ? "The last verification could not reach Akismet." : !connector.sendComments ? "API key saved. Comment processing is disabled." : "API key saved. Verification required."}</p>
          {expanded && connector.active && <form id="akismet-connector-settings" className="connector-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
            <label htmlFor="connector-api-key">API key</label>
            <input ref={inputRef} id="connector-api-key" type="password" autoComplete="new-password" maxLength={128} value={apiKey} onChange={event => { revision.current++; setApiKey(event.target.value); }} placeholder={connector.apiKeyConfigured ? "Leave empty to keep your saved key" : "Enter your Akismet API key"} aria-describedby="connector-key-help" />
            <p id="connector-key-help" className="description">{connector.apiKeyHint ? `Saved key: ${connector.apiKeyHint}. ` : ""}Your saved key is never displayed. <a href="https://akismet.com/account/" target="_blank" rel="noreferrer">Get an API key</a>.</p>
            <label className="connector-consent"><input type="checkbox" checked={send} onChange={event => { revision.current++; setSend(event.target.checked); }} /> Enable Akismet comment processing</label>
            <p className="description">When active and processing is enabled, comment content, author details, IP address and browser information are sent to Akismet. Connecting verifies the key with Akismet. <a href="https://akismet.com/privacy/" target="_blank" rel="noreferrer">Akismet privacy policy</a>.</p>
            <div className="connector-settings__actions"><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : send ? "Save and connect" : "Save"}</button>{connector.apiKeyConfigured && <button type="button" className="button-link connector-disconnect" disabled={busy} onClick={() => void save(true)}>Disconnect and remove key</button>}</div>
          </form>}
        </section>}
      </div>
      <p className="connector-plugin-link"><Link to="/admin/plugins">Manage installed plugins</Link></p>
    </main>
  </>;
}
