import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createPOP3Transport, normalizePOP3Configuration, pop3SocketOptions, POP3Error, MAX_POP3_MESSAGE_BYTES } from "../server/pop3.js";

const configuration = { host: "mail.example.test", port: 995 as const, secure: true, username: "mailbox@example.test", password: "fakeMailboxSecret7" };
const address = { address: "93.184.216.34", family: 4 };
class Peer extends EventEmitter {
  remoteAddress = address.address;
  authorized = true;
  commands: string[] = [];
  destroyed = false;
  holdClose = false;
  constructor(readonly replies: (command: string) => string | Buffer | undefined = defaultReply) { super(); }
  write(value: string) {
    this.commands.push(value);
    const result = this.replies(value.replace(/\r\n$/, ""));
    if (result !== undefined) queueMicrotask(() => this.emit("data", Buffer.from(result)));
    return true;
  }
  setTimeout() { return this; }
  end() { this.destroy(); return this; }
  destroy() { this.destroyed = true; if (!this.holdClose) queueMicrotask(() => this.emit("close")); return this; }
  ready(secure = true) {
    queueMicrotask(() => { this.emit(secure ? "secureConnect" : "connect"); this.emit("data", Buffer.from("+OK mailbox ready\r\n")); });
    return this as unknown as Socket;
  }
}
function defaultReply(command: string) {
  if (command.startsWith("USER ") || command.startsWith("PASS ")) return "+OK\r\n";
  if (command === "UIDL") return "+OK\r\n1 uid-one\r\n2 uid-two\r\n.\r\n";
  if (command === "LIST") return "+OK\r\n1 120\r\n2 240\r\n.\r\n";
  if (command === "RETR 1") return "+OK 120 octets\r\nSubject: A message\r\n\r\nFirst line\r\n..dot\r\n...two dots\r\n.\r\n";
  if (command.startsWith("DELE ") || command === "QUIT") return "+OK\r\n";
  throw new Error("Unexpected fixed command");
}
const is = (outcome: POP3Error["outcome"]) => (error: unknown) => error instanceof POP3Error && error.outcome === outcome;
const fixture = (peer = new Peer(), deadlineMs = 500) => ({
  peer,
  open: createPOP3Transport({ resolve: async () => [address], connect: options => {
    assert.deepEqual(Object.keys(options).sort(), ["host", "pinned", "port", "secure"]);
    assert.equal(options.host, configuration.host); assert.deepEqual(options.pinned, address);
    return peer.ready(options.secure);
  }, deadlineMs }),
});

test("POP configuration permits only explicit source plaintext110 or TLS995 without command/host injection", () => {
  assert.equal(normalizePOP3Configuration(configuration).host, configuration.host);
  assert.equal(normalizePOP3Configuration({ ...configuration, host: "MAIL.Example.TEST." }).host, configuration.host);
  assert.equal(normalizePOP3Configuration({ ...configuration, port: 110, secure: false }).port, 110);
  assert.equal(normalizePOP3Configuration({ ...configuration, host: "2606:4700:4700::1111" }).host, "2606:4700:4700::1111");
  for (const host of ["127.0.0.1", "localhost", "mail.internal", "[::1]", "user:pass@public.test", "public.test:995", "public.test:443", "[2606:4700:4700::1111]:443", "public.test/other", "2130706433", "0x7f000001", "[::ffff:127.0.0.1]"])
    assert.throws(() => normalizePOP3Configuration({ ...configuration, host }), is("configuration"));
  for (const patch of [{ username: "reader\r\nDELE 1" }, { password: "secret\nQUIT" }, { password: "" }, { port: 110 }, { secure: false }, { host: "mail.example.test\u0000" }])
    assert.throws(() => normalizePOP3Configuration({ ...configuration, ...patch } as any), is("configuration"));
});

test("real socket options pin all lookup forms, keep original TLS identity and never contain credentials", () => {
  const options = pop3SocketOptions({ host: configuration.host, port: 995, secure: true, pinned: address });
  assert.equal(options.servername, configuration.host); assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.host, configuration.host); assert.equal(options.autoSelectFamily, false);
  options.lookup("ignored", {}, (error: unknown, value: unknown, family: unknown) => { assert.equal(error, null); assert.equal(value, address.address); assert.equal(family, 4); });
  options.lookup("ignored", { all: true }, (error: unknown, value: unknown) => { assert.equal(error, null); assert.deepEqual(value, [address]); });
  assert.ok(!JSON.stringify(options).includes(configuration.password));
});

test("fixed POP commands preserve UIDL identity and binary dot unstuffing; deletion is explicit and QUIT closes", async () => {
  const { open, peer } = fixture();
  const client = await open(configuration);
  assert.deepEqual(await client.list(), [{ number: 1, uid: "uid-one", size: 120 }, { number: 2, uid: "uid-two", size: 240 }]);
  const message = await client.retrieve(1);
  assert.equal(message.toString(), "Subject: A message\r\n\r\nFirst line\r\n.dot\r\n..two dots\r\n");
  assert.ok(!peer.commands.some(command => command.startsWith("DELE")));
  await client.remove(1); await client.quit(); await client.closed;
  assert.deepEqual(peer.commands.map(command => command.split(" ")[0].trim()), ["USER", "PASS", "UIDL", "LIST", "RETR", "DELE", "QUIT"]);
  assert.equal(peer.destroyed, true);
});

test("every DNS answer, actual peer and TLS authorization are checked before any credential command", async () => {
  let connections = 0;
  const open = createPOP3Transport({ resolve: async () => [address, { address: "10.0.0.1", family: 4 }], connect: () => { connections++; throw Error(); } });
  await assert.rejects(open(configuration), is("configuration")); assert.equal(connections, 0);
  for (const patch of [{ remoteAddress: "10.0.0.1" }, { remoteAddress: "8.8.8.8" }, { authorized: false }]) {
    const peer = new Peer(); Object.assign(peer, patch); const f = fixture(peer);
    await assert.rejects(f.open(configuration), is("configuration"));
    assert.equal(peer.commands.length, 0); assert.equal(peer.destroyed, true);
  }
});

test("authentication errors and malformed/duplicate/non-ASCII UIDLs never expose remote response or password", async () => {
  for (const replies of [
    (command: string) => command.startsWith("PASS ") ? "-ERR " + configuration.password + "\r\n" : defaultReply(command),
    (command: string) => command === "UIDL" ? "+OK\r\n1 duplicate\r\n2 duplicate\r\n.\r\n" : defaultReply(command),
    (command: string) => command === "UIDL" ? Buffer.from("+OK\r\n1 \xc1\r\n.\r\n", "latin1") : defaultReply(command),
  ]) {
    const peer = new Peer(replies), f = fixture(peer);
    let client: Awaited<ReturnType<typeof f.open>> | undefined;
    try { client = await f.open(configuration); await client.list(); assert.fail("Expected a bounded protocol failure"); }
    catch (error) { assert.ok(error instanceof POP3Error); assert.ok(!String(error).includes(configuration.password)); }
    finally { if (client) await client.abort(); }
    assert.equal(peer.destroyed, true);
  }
});

test("message and line bounds close the connection and never issue automatic deletion", async () => {
  for (const payload of [Buffer.from("+OK\r\n" + "x".repeat(16385)), Buffer.from("+OK\r\n" + ("x".repeat(1000) + "\r\n").repeat(Math.ceil(MAX_POP3_MESSAGE_BYTES / 1000)) + ".\r\n")]) {
    const peer = new Peer(command => command.startsWith("RETR ") ? payload : defaultReply(command)), f = fixture(peer);
    const client = await f.open(configuration);
    await assert.rejects(client.retrieve(1), is("limits")); await client.closed;
    assert.ok(!peer.commands.some(command => command.startsWith("DELE")));
  }
});

test("logical timeout keeps the single connection reservation until actual socket close", async () => {
  let calls = 0;
  const peer = new Peer(command => command.startsWith("PASS ") ? undefined : defaultReply(command)); peer.holdClose = true;
  const open = createPOP3Transport({ resolve: async () => [address], connect: () => { calls++; return peer.ready(); }, deadlineMs: 25 });
  await assert.rejects(open(configuration), is("unavailable"));
  assert.equal(peer.destroyed, true);
  await assert.rejects(open(configuration), is("busy")); assert.equal(calls, 1);
  peer.emit("close");
  // A closed old socket releases capacity; a subsequent attempt may connect.
  await assert.rejects(open(configuration), is("unavailable")); assert.equal(calls, 2); peer.emit("close");
});

test("timed-out DNS keeps its physical lookup slots and never starts a socket", async () => {
  const resolvers: Array<(value: typeof address[]) => void> = [];
  let calls = 0, sockets = 0;
  const open = createPOP3Transport({ resolve: async () => { calls++; return new Promise(resolve => resolvers.push(resolve)); }, connect: () => { sockets++; throw Error(); }, deadlineMs: 15 });
  try {
    await assert.rejects(open(configuration), is("unavailable"));
    await assert.rejects(open(configuration), is("unavailable"));
    await assert.rejects(open(configuration), is("busy"));
    assert.equal(calls, 2); assert.equal(sockets, 0);
  } finally { resolvers.forEach(resolve => resolve([address])); }
});
