export interface Connector {
  id: "akismet";
  name: string;
  description: string;
  pluginSlug: "akismet";
  installed: boolean;
  active: boolean;
  sendComments: boolean;
  connected: boolean;
  apiKeyConfigured: boolean;
  apiKeyHint?: string;
  keyVerified: boolean;
  verifiedAt: string | null;
  lastServiceError: string | null;
}

/** A dismissed settings opening never owns a later draft or verification step. */
export class ConnectorOperation {
  private controller: AbortController | null = null;
  start() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      current: () => this.controller === controller && !controller.signal.aborted,
    };
  }
  cancel() {
    this.controller?.abort();
    this.controller = null;
  }
}

type Request = <T>(path: string, options: RequestInit) => Promise<T>;
export async function saveConnector(
  request: Request,
  input: { apiKey: string; sendComments: boolean; clearApiKey?: boolean },
  operation: ReturnType<ConnectorOperation["start"]>,
  receive: (connector: Connector) => void,
) {
  const options = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body), signal: operation.signal });
  const saved = await request<{ connector: Connector }>("/connectors/akismet", options("PUT", input));
  if (!operation.current()) return;
  receive(saved.connector);
  if (input.clearApiKey) return "Akismet disconnected. The saved API key was removed.";
  if (!input.sendComments) return "Settings saved. Comment processing is disabled.";
  const verified = await request<{ result: string; connector: Connector }>("/connectors/akismet/verify", options("POST", {}));
  if (!operation.current()) return;
  receive(verified.connector);
  if (verified.result !== "valid") throw new Error(verified.result === "invalid"
    ? "Akismet could not verify this key. Check your API key and site address."
    : "Akismet is unavailable. Your settings were saved, but the connection could not be verified.");
  return "Akismet connected.";
}

/** Keep validation on the server; do not silently truncate or discard invalid lines. */
export const pingServiceLines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
