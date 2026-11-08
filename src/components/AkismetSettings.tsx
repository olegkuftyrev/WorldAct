import "./AkismetSettings.css";
import { useEffect, useState } from "react";
export interface AkismetPluginState {
  enabled?: boolean;
  settings: Record<string, unknown>;
  apiKeyConfigured?: boolean;
  apiKeyHint?: string;
  keyVerified?: boolean;
  verifiedAt?: string | null;
  lastServiceError?: string | null;
}
export default function AkismetSettings({
  plugin,
  busy,
  onSave,
  onVerify,
}: {
  plugin: AkismetPluginState;
  busy: boolean;
  onSave: (
    settings: Record<string, unknown>,
    credentials: { apiKey?: string; clearApiKey?: boolean },
  ) => void;
  onVerify: () => void;
}) {
  const [apiKey, setApiKey] = useState(""),
    [clear, setClear] = useState(false),
    [send, setSend] = useState(Boolean(plugin.settings.sendComments));
  useEffect(() => {
    setApiKey("");
    setClear(false);
    setSend(Boolean(plugin.settings.sendComments));
  }, [plugin.settings, plugin.apiKeyHint]);
  return (
    <form
      className="worldact-plugin-settings worldact-akismet-settings"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(
          { sendComments: send },
          {
            ...(apiKey ? { apiKey } : {}),
            ...(clear ? { clearApiKey: true } : {}),
          },
        );
      }}
    >
      <h3>Akismet Settings</h3>
      <p>
        <strong>Status:</strong>{" "}
        {!plugin.apiKeyConfigured
          ? "Set up an API key"
          : plugin.keyVerified
            ? "API key verified"
            : "API key needs verification"}
        {plugin.apiKeyHint ? ` (${plugin.apiKeyHint})` : ""}
      </p>
      {plugin.lastServiceError && (
        <p role="status">
          {plugin.lastServiceError === "invalid"
            ? "Akismet could not verify this API key. Check your key and site address."
            : "Akismet is unavailable. New comments requiring a check are held for moderation."}
        </p>
      )}
      <label>
        API key
        <input
          type="password"
          autoComplete="new-password"
          maxLength={128}
          disabled={busy || clear}
          value={apiKey}
          placeholder={
            plugin.apiKeyConfigured
              ? "Leave empty to keep your saved key"
              : "Enter your Akismet API key"
          }
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      {plugin.apiKeyConfigured && (
        <label>
          <input
            type="checkbox"
            checked={clear}
            disabled={busy}
            onChange={(event) => setClear(event.target.checked)}
          />{" "}
          Clear the saved API key
        </label>
      )}
      <label>
        <input
          type="checkbox"
          checked={send}
          disabled={busy}
          onChange={(event) => setSend(event.target.checked)}
        />{" "}
        Enable Akismet comment processing
      </label>
      <p className="description">
        When this plugin is active and processing is enabled, comment content,
        author details, IP address and browser information are sent to Akismet.
        Save your key, then verify it before comments are checked. Comments are
        held for moderation if a configured check cannot complete.
      </p>
      <p className="worldact-inline-actions">
        <button className="button button-primary" disabled={busy}>
          Save settings
        </button>
        <button
          type="button"
          className="button"
          disabled={
            busy ||
            !plugin.enabled ||
            !plugin.apiKeyConfigured ||
            !plugin.settings.sendComments
          }
          onClick={onVerify}
        >
          Verify API key
        </button>
      </p>
      <p className="description">
        A saved key is never displayed or included in exports. Moderation
        feedback is sent for comments that Akismet checked; original submission
        metadata expires after 30 days.
      </p>
    </form>
  );
}
