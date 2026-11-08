export type MailSummary = {examined: number; imported: number; duplicates: number; skipped: number; deletionRequested: number; deletionCommitted: number};
export type Mailbox = {
  version: string; host: string; username: string; port: 110 | 995; secure: boolean;
  enabled: boolean; polling: boolean; categoryId: number | null; passwordConfigured: boolean; configured: boolean;
  lastChecked: string | null; outcome: string; summary: Partial<MailSummary>; busy: boolean;
  nextCheckAt: string | null; environment: string; automaticChecksActive: boolean;
};
export type MailDraft = Pick<Mailbox, "host" | "username" | "port" | "secure" | "enabled" | "polling" | "categoryId"> & {password: string; clearPassword: boolean};
export function mailboxDraft(mailbox: Mailbox): MailDraft {
  const {host, username, port, secure, enabled, polling, categoryId} = mailbox;
  return {host, username, port, secure, enabled, polling, categoryId, password: "", clearPassword: false};
}
export type MailCategory = {id: number; name: string; parentId?: number | null};
export function mailCategoryOptions(categories: MailCategory[]) {
  const result: (MailCategory & {depth: number})[] = [], seen = new Set<number>();
  const ordered = [...categories].sort((a, b) => a.name.localeCompare(b.name));
  function add(category: MailCategory, depth: number) {
    if (seen.has(category.id)) return;
    seen.add(category.id); result.push({...category, depth});
    if (depth < 10) for (const child of ordered.filter(value => value.parentId === category.id)) add(child, depth + 1);
  }
  for (const category of ordered.filter(value => !value.parentId || !categories.some(parent => parent.id === value.parentId))) add(category, 0);
  for (const category of ordered) add(category, 0);
  return result;
}
/** A successful earlier save may update status/version, never a newer field draft. */
export function rebaseMailboxDraft(current: MailDraft, submitted: MailDraft, saved: Mailbox): MailDraft {
  const next = {...current}, baseline = mailboxDraft(saved);
  for (const key of Object.keys(baseline) as (keyof MailDraft)[]) {
    if (current[key] === submitted[key]) Object.assign(next, {[key]: baseline[key]});
  }
  if (next.clearPassword) Object.assign(next, {password: "", enabled: false, polling: false});
  return next;
}
export function mailboxChanges(draft: MailDraft, saved: Mailbox): Partial<MailDraft> {
  const baseline = mailboxDraft(saved), changes: Partial<MailDraft> = {};
  for (const key of Object.keys(baseline) as (keyof MailDraft)[]) {
    if (draft[key] !== baseline[key]) Object.assign(changes, {[key]: draft[key]});
  }
  return changes;
}
export function mailboxDirty(draft: MailDraft, saved: Mailbox) {
  const baseline = mailboxDraft(saved);
  return (Object.keys(baseline) as (keyof MailDraft)[]).some(key => draft[key] !== baseline[key]);
}
export function canCheckMailbox(mailbox: Mailbox, now: number) {
  return mailbox.configured && mailbox.enabled && !mailbox.busy && (!mailbox.nextCheckAt || new Date(mailbox.nextCheckAt).getTime() <= now);
}
export function mailOutcome(outcome: string) {
  const labels: Record<string, string> = {running: "Checking mail…", completed: "Mail check completed.", completed_with_skips: "Mail check completed; unsupported messages were left in the mailbox.", unavailable: "The mailbox was unavailable.", changed_or_forbidden: "The configuration or permission changed during the check.", authentication: "Mailbox authentication failed.", configuration: "The saved mailbox configuration could not be used.", busy: "The mailbox connection is busy.", invalid_reply: "The mailbox returned an unsupported response.", limits: "The mailbox check reached its supported message or connection limit.", timeout: "The mailbox connection timed out.", invalid_message: "An unsupported message was left in the mailbox."};
  return labels[outcome] || (outcome ? "The mail check could not be completed." : "No mail check recorded.");
}
