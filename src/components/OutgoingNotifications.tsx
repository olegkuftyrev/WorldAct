import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { errorText } from "./AdminUI";
import "../connectors.css";

type Status = { environment: string; dispatchEnabled: boolean; counts: { state: string; count: number }[] };
export default function OutgoingNotifications({ hidden, value, onChange }: { hidden: boolean; value: string; onChange: (value: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<Status>("/tools/outgoing-pings", { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setStatus(value); }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => controller.abort();
  }, [retry]);
  return <section className="worldact-update-services" aria-labelledby="update-services-title">
    <h2 id="update-services-title">Update Services</h2>
    {hidden ? <p>WorldAct is not notifying any <a href="https://developer.wordpress.org/advanced-administration/wordpress/update-services/" target="_blank" rel="noreferrer">Update Services</a> because of your site’s <Link to="/admin/settings?tab=reading">visibility settings</Link>.</p> : <>
      <p><label htmlFor="ping-services">When you publish a new post, WorldAct automatically notifies the following site update services. For more about this, see the <a href="https://developer.wordpress.org/advanced-administration/wordpress/update-services/" target="_blank" rel="noreferrer">Update Services</a> documentation article. Separate multiple service URLs with line breaks.</label></p>
      <textarea id="ping-services" aria-label="Update Services" rows={3} value={value} onChange={event => onChange(event.target.value)} />
      <p className="description">Enter up to 20 public HTTP or HTTPS URLs. Leave empty to disable update services.</p>
    </>}
    {status && !status.dispatchEnabled && <p className="description">Notifications are suppressed in the <strong>{status.environment}</strong> environment. They are delivered only in production. Saving these settings does not send a test notification.</p>}
    {status?.dispatchEnabled && <p className="description">The production environment allows delivery when publication and visibility settings permit it.</p>}
    {error && <p role="alert">Notification status: {error} <button type="button" className="button-link" onClick={() => setRetry(value => value + 1)}>Try again</button></p>}
    {status && <details><summary>View notification status</summary><p>Environment: {status.environment}. {status.dispatchEnabled ? "Delivery enabled." : "Delivery suppressed."}</p><div className="notification-counts">{status.counts.length ? status.counts.map(item => <span key={item.state}>{item.state}: {item.count}</span>) : <span>No publication notifications recorded.</span>}</div></details>}
  </section>;
}
