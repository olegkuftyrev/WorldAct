import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, json } from "../api";
import { ConnectorOperation } from "../connectors";
import { canCheckMailbox, mailCategoryOptions, mailboxChanges, mailboxDirty, mailboxDraft, mailOutcome, rebaseMailboxDraft, type Mailbox, type MailDraft, type MailSummary, type MailCategory } from "../mailIntake";
import { errorText, Notice, Session } from "./AdminUI";
import "../mailIntake.css";

export default function MailIntakeSettings({ categories }: {categories: MailCategory[]}) {
  const {user} = useContext(Session);
  const [saved, setSaved] = useState<Mailbox | null>(null), [draft, setDraft] = useState<MailDraft | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "check" | "">("load");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const operation = useRef(new ConnectorOperation()), draftRef = useRef(draft);
  const baseline = useRef<Mailbox | null>(null);
  draftRef.current = draft;
  useEffect(() => {
    setSaved(null); setDraft(null); setNotice(""); setError("");
    baseline.current = null;
    const owner = operation.current.start(); setBusy("load");
    api<{mailbox: Mailbox}>("/tools/mail-intake", {signal: owner.signal}).then(({mailbox}) => {
      if (!owner.current()) return;
      baseline.current = mailbox; setSaved(mailbox); setDraft(mailboxDraft(mailbox));
    }).catch(reason => {if (owner.current()) setError(errorText(reason));})
      .finally(() => {if (owner.current()) setBusy("");});
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {operation.current.cancel(); window.clearInterval(timer);};
  }, [user?.id, user?.role]);
  const dirty = Boolean(draft && baseline.current && mailboxDirty(draft, baseline.current));
  const changedElsewhere = Boolean(saved && baseline.current && saved.version !== baseline.current.version);
  function set<K extends keyof MailDraft>(key: K, value: MailDraft[K]) {
    setDraft(current => current ? {...current, [key]: value} : current);
  }
  async function refresh() {
    const owner = operation.current.start(); setBusy("load"); setError("");
    try {
      const {mailbox} = await api<{mailbox: Mailbox}>("/tools/mail-intake", {signal: owner.signal});
      if (!owner.current()) return;
      const previous = baseline.current;
      baseline.current = mailbox;
      setSaved(mailbox);
      setDraft(current => current && previous ? rebaseMailboxDraft(current, mailboxDraft(previous), mailbox) : mailboxDraft(mailbox));
      if (previous && previous.version !== mailbox.version) setNotice("Latest saved mail settings loaded. Your unsaved changes are preserved.");
      setNow(Date.now());
    } catch (reason) {if (owner.current()) setError(errorText(reason));}
    finally {if (owner.current()) setBusy("");}
  }
  async function save() {
    if (!saved || !draft || !baseline.current || busy || !dirty) return;
    const submitted = draft, owner = operation.current.start();
    const previous = baseline.current;
    setBusy("save"); setError(""); setNotice("");
    try {
      const {mailbox} = await api<{mailbox: Mailbox}>("/tools/mail-intake", {
        ...json("PUT", {...mailboxChanges(submitted, previous), version: previous.version}), signal: owner.signal,
      });
      if (!owner.current()) return;
      baseline.current = mailbox; setSaved(mailbox);
      setDraft(current => current ? rebaseMailboxDraft(current, submitted, mailbox) : current);
      setNotice(draftRef.current === submitted ? "Mail settings saved." : "Mail settings saved. Your newer changes are still unsaved.");
    } catch (reason) {if (owner.current()) setError(`${errorText(reason)} Your input is preserved. Refresh saved status before retrying if the settings changed.`);}
    finally {if (owner.current()) setBusy("");}
  }
  async function check() {
    if (!saved || !draft || busy || dirty || changedElsewhere || !canCheckMailbox(saved, Date.now())) return;
    const version = saved.version, owner = operation.current.start();
    setBusy("check"); setError(""); setNotice("");
    try {
      const {outcome, ...summary} = await api<MailSummary & {outcome: string}>("/tools/mail-intake/check", {...json("POST", {}), signal: owner.signal});
      if (!owner.current()) return;
      setSaved(current => current?.version === version ? {...current, outcome, summary, busy: false} : current);
      setNotice("Mail check finished. The saved status below reports the result.");
    } catch (reason) {if (owner.current()) setError(errorText(reason));}
    finally {
      if (owner.current()) {
        try {
          const {mailbox} = await api<{mailbox: Mailbox}>("/tools/mail-intake", {signal: owner.signal});
          if (owner.current()) {
            setSaved(mailbox); setNow(Date.now());
            if (mailbox.version !== version) setNotice("Mailbox settings changed during the check. Your input is preserved; review the saved status before saving.");
          }
        } catch (reason) {if (owner.current()) setError(current => `${current}${current ? " " : ""}Status could not be refreshed: ${errorText(reason)}`);}
        if (owner.current()) setBusy("");
      }
    }
  }
  const field = (label: string, id: string, children: ReactNode) => <tr><th scope="row"><label htmlFor={id}>{label}</label></th><td>{children}</td></tr>;
  return <section className="worldact-mail-intake" aria-labelledby="post-via-email-title" aria-busy={Boolean(busy)}
    onKeyDown={event => {if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {event.preventDefault(); void save();}}}>
    <h2 id="post-via-email-title">Post via email</h2>
    <p>To post to WorldAct by email, configure a dedicated POP3 mailbox. Messages from a matching author account may be published; other messages are held for review. Supported text messages are imported before deletion is requested. Messages with attachments remain in the mailbox.</p>
    {error && <Notice error>{error}</Notice>}
    {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
    {!draft && busy && <p role="status">Loading mail settings…</p>}
    {draft && saved && <>
      <table className="form-table"><tbody>
        {field("Mail Server", "mailserver-url", <div className="mailserver-address">
          <input id="mailserver-url" className="regular-text code" value={draft.host} maxLength={253} autoComplete="off" onChange={e => set("host", e.target.value)} />
          <label htmlFor="mailserver-port">Port</label>
          <select id="mailserver-port" value={draft.port} onChange={e => setDraft(current => current ? {...current, port: Number(e.target.value) as 110 | 995, secure: e.target.value === "995"} : current)}>
            <option value="110">110</option><option value="995">995</option>
          </select>
          <p className="description">Port 995 uses certificate-verified implicit TLS. Port 110 uses unencrypted POP3.</p>
        </div>)}
        {field("Login Name", "mailserver-login", <input id="mailserver-login" className="regular-text" value={draft.username} maxLength={1024} autoComplete="off" onChange={e => set("username", e.target.value)} />)}
        {field("Password", "mailserver-pass", <>
          <input id="mailserver-pass" type="password" className="regular-text" value={draft.password} autoComplete="new-password" maxLength={1024} disabled={draft.clearPassword} onChange={e => set("password", e.target.value)} />
          <p className="description">{saved.passwordConfigured ? "A password is saved. Leave blank to keep it." : "No password is saved."} The saved password is never displayed.</p>
          <label><input type="checkbox" checked={draft.clearPassword} onChange={e => setDraft(current => current ? {...current, clearPassword: e.target.checked, ...(e.target.checked ? {password: "", enabled: false, polling: false} : {})} : current)} /> Clear the saved password and disable mail checks</label>
        </>)}
        {field("Default Mail Category", "default-email-category", <>
          <select id="default-email-category" value={draft.categoryId ?? ""} onChange={e => set("categoryId", e.target.value ? Number(e.target.value) : null)}>
            <option value="">Default category</option>
            {draft.categoryId !== null && !categories.some(category => category.id === draft.categoryId) && <option value={draft.categoryId}>Unavailable category — default category will be used</option>}
            {mailCategoryOptions(categories).map(category => <option key={category.id} value={category.id}>{"\u00a0".repeat(category.depth * 3)}{category.name}</option>)}
          </select>
          <p className="description">If the saved category is deleted, imported posts use the site’s default category.</p>
        </>)}
        {field("Mail checks", "mail-intake-enabled", <div className="worldact-stacked-fields">
          <label><input id="mail-intake-enabled" type="checkbox" checked={draft.enabled} disabled={draft.clearPassword} onChange={e => set("enabled", e.target.checked)} /> Enable post via email</label>
          <label><input type="checkbox" checked={draft.polling} disabled={draft.clearPassword} onChange={e => set("polling", e.target.checked)} /> Check automatically in production</label>
          <p className="description">Automatic checks require both settings. Manual checks use the saved, enabled configuration. Checks are limited to once every five minutes.</p>
        </div>)}
      </tbody></table>
      <div className="mail-intake-actions">
        <button type="button" className="button" disabled={Boolean(busy) || !dirty} onClick={() => void save()}>{busy === "save" ? "Saving mail settings…" : "Save Mail Settings"}</button>
        <button type="button" className="button" disabled={Boolean(busy) || dirty || changedElsewhere || !canCheckMailbox(saved, now)} onClick={() => void check()}>{busy === "check" ? "Checking mail…" : "Check mail now"}</button>
        <button type="button" className="button-link" disabled={Boolean(busy)} onClick={() => void refresh()}>Refresh saved status</button>
      </div>
      {dirty && <p className="description">Mail settings have unsaved changes. Save Mail Settings before checking mail. Save Changes below applies to the other Writing settings.</p>}
      {changedElsewhere && <p role="status">Saved mail settings changed. Refresh saved status to load the latest values while keeping your changes.</p>}
      <div className="mail-intake-status" aria-live="polite">
        <p><strong>Saved configuration:</strong> {saved.configured ? "Configured" : "Incomplete"}; {saved.enabled ? "enabled" : "disabled"}. Environment: {saved.environment}.</p>
        <p>{saved.automaticChecksActive ? "Automatic checks are active." : saved.environment !== "production" ? `Automatic checks are suppressed in the ${saved.environment} environment. An explicit manual check can connect to the saved mailbox.` : "Automatic checks are off."}</p>
        <p>{saved.busy ? "A mail check is already running." : mailOutcome(saved.outcome)} {saved.lastChecked && <>Last checked: <time dateTime={saved.lastChecked}>{new Date(saved.lastChecked).toLocaleString()}</time>.</>} {saved.nextCheckAt && new Date(saved.nextCheckAt).getTime() > now && <>Next check available: <time dateTime={saved.nextCheckAt}>{new Date(saved.nextCheckAt).toLocaleString()}</time>.</>}</p>
        {Object.keys(saved.summary).length > 0 && <dl className="mail-intake-summary">{([
          ["examined", "Examined"], ["imported", "Imported"], ["skipped", "Skipped"], ["duplicates", "Duplicates"], ["deletionRequested", "Deletion requested"], ["deletionCommitted", "Deletion committed"],
        ] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{saved.summary[key] || 0}</dd></div>)}</dl>}
      </div>
    </>}
    {!draft && !busy && <button type="button" className="button" onClick={() => void refresh()}>Retry loading mail settings</button>}
  </section>;
}
