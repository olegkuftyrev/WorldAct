import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { canCheckMailbox, mailboxChanges, mailboxDirty, mailboxDraft, rebaseMailboxDraft, type Mailbox } from "../src/mailIntake.js";
import { commentTypeFilter, commentTypeLabel, commentTypeOptions, isNotification } from "../src/commentTypes.js";
import { ConnectorOperation } from "../src/connectors.js";
const mailbox: Mailbox = {version: "original", host: "mail.example.test", username: "mail-reader", port: 995, secure: true, enabled: false, polling: false, categoryId: 1, passwordConfigured: true, configured: true, lastChecked: null, nextCheckAt: null, outcome: "", summary: {}, busy: false, environment: "local", automaticChecksActive: false};

test("mail saves rebase normalized saved fields without erasing a newer host, password or category draft", () => {
  const submitted = {...mailboxDraft(mailbox), host: "MAIL.EXAMPLE.TEST", password: "synthetic-first"};
  const newer = {...submitted, host: "newer.example.test", password: "synthetic-later", categoryId: 2};
  const saved = {...mailbox, version: "new-version", host: "mail.example.test"};
  const result = rebaseMailboxDraft(newer, submitted, saved);
  assert.equal(result.host, newer.host); assert.equal(result.password, newer.password); assert.equal(result.categoryId, 2);
  assert.equal(mailboxDirty(result, saved), true);
  const accepted = rebaseMailboxDraft(submitted, submitted, saved);
  assert.deepEqual(accepted, mailboxDraft(saved)); assert.equal(accepted.password, ""); assert.equal(mailboxDirty(accepted, saved), false);
  const refreshed = rebaseMailboxDraft({...mailboxDraft(mailbox), host: "my-draft.example.test"}, mailboxDraft(mailbox), {...mailbox, username: "changed-by-other-admin"});
  assert.equal(refreshed.host, "my-draft.example.test"); assert.equal(refreshed.username, "changed-by-other-admin");
  assert.deepEqual(mailboxChanges(refreshed, {...mailbox, username: "changed-by-other-admin"}), {host: "my-draft.example.test"});
  const clear = rebaseMailboxDraft({...mailboxDraft(mailbox), clearPassword: true}, mailboxDraft(mailbox), {...mailbox, enabled: true, polling: true});
  assert.equal(clear.enabled, false); assert.equal(clear.polling, false); assert.equal(clear.password, "");
});

test("manual checks require saved configuration and obey actual persistent throttle rather than production-only polling", () => {
  const active = {...mailbox, enabled: true, nextCheckAt: new Date(10_000).toISOString()};
  assert.equal(canCheckMailbox(active, 9_999), false);
  assert.equal(canCheckMailbox(active, 10_000), true);
  assert.equal(canCheckMailbox({...active, busy: true}, 20_000), false);
  assert.equal(canCheckMailbox({...active, configured: false}, 20_000), false);
  assert.equal(canCheckMailbox({...active, enabled: false}, 20_000), false);
});

test("scoped type availability groups both notifications, preserves a selected loading filter, and leaves moderator permissions independent", () => {
  assert.deepEqual(commentTypeOptions({comment: 1, pings: 2}, "pings", false).map(option => option.value), ["all", "comment", "pings"]);
  assert.deepEqual(commentTypeOptions({comment: 0, pings: 0}, "pings", true).map(option => option.value), ["all", "pings"]);
  assert.deepEqual(commentTypeOptions({comment: 1, pings: 0}, "all", false).map(option => option.value), ["all", "comment"]);
  assert.equal(commentTypeFilter("unsupported"), "all");
  for (const type of ["pingback", "trackback"] as const) {assert.equal(isNotification({type}), true); assert.notEqual(commentTypeLabel({type}), "Comment");}
  assert.equal(isNotification({}), false); assert.equal(isNotification({type: "comment"}), false);
});

test("dismissed mail/check ownership cannot repaint a later settings opening or another account", () => {
  const operations = new ConnectorOperation(), first = operations.start();
  const next = operations.start(); assert.equal(first.current(), false); assert.equal(first.signal.aborted, true); assert.equal(next.current(), true);
  operations.cancel(); assert.equal(next.current(), false); assert.equal(next.signal.aborted, true);
});
