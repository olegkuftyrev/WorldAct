import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { ConnectorOperation, pingServiceLines, saveConnector, type Connector } from "../src/connectors.js";

const connector = { id: "akismet", installed: true, active: true, apiKeyConfigured: true, sendComments: false, connected: false } as Connector;
test("saving without consent never verifies, while connecting waits for the shared saved configuration", async () => {
  const calls: {path:string;body:any}[] = [], received: Connector[] = [];
  const request = async <T>(path: string, options: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(options.body)) });
    return (path.endsWith("verify") ? { result: "valid", connector: { ...connector, sendComments: true, connected: true } } : { connector }) as T;
  };
  await saveConnector(request, { apiKey: "", sendComments: false }, new ConnectorOperation().start(), value => received.push(value));
  assert.deepEqual(calls.map(item => item.path), ["/connectors/akismet"]);
  calls.length = 0;
  await saveConnector(request, { apiKey: "", sendComments: true }, new ConnectorOperation().start(), value => received.push(value));
  assert.deepEqual(calls.map(item => item.path), ["/connectors/akismet", "/connectors/akismet/verify"]);
  assert.equal(calls[0].body.apiKey, "", "blank retains the saved key through the real API contract");
  assert.equal(received.at(-1)?.connected, true);
});

test("a dismissed opening cannot receive a delayed save or start verification for a reopened draft", async () => {
  const scope = new ConnectorOperation(), first = scope.start();
  let release!: (value: unknown) => void;
  const barrier = new Promise(resolve => { release = resolve; });
  const received: Connector[] = [], calls: string[] = [];
  const pending = saveConnector(async <T>(path: string) => { calls.push(path); return await barrier as T; }, { apiKey: "fakeDraft12345", sendComments: true }, first, value => received.push(value));
  scope.cancel();
  const reopened = scope.start();
  release({ connector }); await pending;
  assert.equal(first.signal.aborted, true);
  assert.equal(reopened.current(), true);
  assert.deepEqual(received, []);
  assert.deepEqual(calls, ["/connectors/akismet"]);
});

test("failed verification retains the actual saved unconnected state and service lines retain server-invalid input", async () => {
  const received: Connector[] = [];
  await assert.rejects(saveConnector(async <T>(path: string) => (path.endsWith("verify") ? { result: "invalid", connector: { ...connector, lastServiceError: "invalid" } } : { connector }) as T, { apiKey: "fakeKey12345", sendComments: true }, new ConnectorOperation().start(), value => received.push(value)), /could not verify/);
  assert.equal(received.at(-1)?.connected, false);
  assert.equal(received.at(-1)?.lastServiceError, "invalid");
  assert.deepEqual(pingServiceLines(" \r\n https://rpc.pingomatic.com/ \r\n javascript:invalid \n"), ["https://rpc.pingomatic.com/", "javascript:invalid"]);
  assert.equal(pingServiceLines(Array.from({length:21},(_,i)=>`https://example${i}.com`).join("\n")).length,21,"the server must report excess lines instead of a silent client truncation");
  assert.deepEqual(pingServiceLines("  \n"), []);
});
