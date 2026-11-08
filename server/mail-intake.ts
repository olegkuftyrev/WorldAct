import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { pool, userFields, type User } from "./db.js";
import { assertActiveAccountAuthentication, requireRole, type AuthRequest } from "./auth.js";
import { createMailPost } from "./core.js";
import { HttpError, needUser } from "./utils.js";
import { parseMailMessage, MailMessageError } from "./mail-message.js";
import { normalizePOP3Configuration, openPOP3, POP3Error, MAX_POP3_MESSAGE_BYTES, type POP3Configuration } from "./pop3.js";
import { pingEnvironment as environmentType } from "./outgoing-ping-settings.js";

type Configuration = POP3Configuration & {
  generation: string; enabled: boolean; polling: boolean; category_id: number | null;
  configured_by: number | null; last_checked: Date | null; lease_token: string | null;
  lease_until: Date | null; outcome: string; summary: Record<string, number>;
  cursor_uid_hash: string;
};
type Run = { configuration: Configuration; token: string; operator: number };
type Summary = { examined: number; imported: number; duplicates: number; skipped: number; deletionRequested: number; deletionCommitted: number };
type Open = (configuration: POP3Configuration) => ReturnType<typeof openPOP3>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const mailboxHash = (config: Configuration) => hash(JSON.stringify([config.host, config.port, config.secure, config.username]));
const configSchema = z.object({
  version: z.uuid().optional(), host: z.string().trim().max(253).optional(),
  username: z.string().max(1024).optional(), password: z.string().max(1024).optional(),
  clearPassword: z.boolean().optional(), secure: z.boolean().optional(),
  port: z.union([z.literal(110), z.literal(995)]).optional(),
  enabled: z.boolean().optional(), polling: z.boolean().optional(),
  categoryId: z.number().int().positive().max(2147483647).nullable().optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== "version"), "Provide a mailbox setting.");
async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function lockOperator(client: PoolClient, req: AuthRequest | undefined, operator: number) {
  const person = (await client.query("SELECT role FROM users WHERE id=$1 FOR SHARE", [operator])).rows[0];
  if (!person || person.role !== "administrator") throw new HttpError(403, "Only administrators can check or configure post by email.");
  if (req) await assertActiveAccountAuthentication(req, client);
}
function projection(config: Configuration) {
  let configured = false;
  try { normalizePOP3Configuration(config); configured = true; } catch { /* No request on a status read. */ }
  return {
    version: config.generation, host: config.host, username: config.username,
    port: config.port, secure: config.secure, enabled: config.enabled, polling: config.polling,
    categoryId: config.category_id, passwordConfigured: Boolean(config.password), configured,
    lastChecked: config.last_checked, outcome: config.outcome, summary: config.summary,
    busy: Boolean(config.lease_until && new Date(config.lease_until).getTime() > Date.now()),
    nextCheckAt: config.last_checked ? new Date(new Date(config.last_checked).getTime() + 300_000) : null,
    environment: environmentType(), automaticChecksActive: config.enabled && config.polling && environmentType() === "production",
  };
}
export async function readMailIntakeConfiguration() {
  return projection((await pool.query<Configuration>("SELECT * FROM mail_intake_configuration WHERE id=1")).rows[0]);
}
export async function updateMailIntakeConfiguration(req: AuthRequest, value: unknown) {
  const input = configSchema.parse(value), operator = needUser(req).id;
  return transaction(async client => {
    await lockOperator(client, req, operator);
    const previous = (await client.query<Configuration>("SELECT * FROM mail_intake_configuration WHERE id=1 FOR UPDATE")).rows[0];
    if (input.version !== undefined && input.version !== previous.generation) throw new HttpError(409, "Mailbox settings changed. Reload before saving.");
    if (input.clearPassword && input.password) throw new HttpError(400, "Choose a new password or clear the saved password.");
    const next = {
      ...previous, host: input.host ?? previous.host, username: input.username ?? previous.username,
      password: input.clearPassword ? "" : input.password || previous.password,
      secure: input.secure ?? previous.secure, enabled: input.enabled ?? previous.enabled,
      polling: input.polling ?? previous.polling,
      category_id: input.categoryId === undefined ? previous.category_id : input.categoryId,
    };
    next.port = input.port ?? (input.secure === undefined ? previous.port : next.secure ? 995 : 110);
    if (next.port !== (next.secure ? 995 : 110)) throw new HttpError(400, "Use port 110 for POP3 or 995 for implicit TLS.");
    if (next.host || next.username || next.password || next.enabled || next.polling) {
      // Validate a partial disabled configuration without requiring an existing password.
      let normalized: POP3Configuration;
      try { normalized = normalizePOP3Configuration({ ...next, host: next.host || "mail.example.com", username: next.username || "pending", password: next.password || "pending" }); }
      catch { throw new HttpError(400, "Use a public mailbox host, ASCII login/password, and the supported POP3 port."); }
      if (next.host) next.host = normalized.host;
    }
    if ((next.enabled || next.polling) && (!next.host || !next.username || !next.password)) throw new HttpError(400, "Configure the mailbox before enabling post by email.");
    if (next.category_id !== null && !(await client.query("SELECT 1 FROM terms WHERE id=$1 AND taxonomy='category'", [next.category_id])).rowCount)
      throw new HttpError(400, "Choose an existing email category.");
    const updated = (await client.query<Configuration>(
      `UPDATE mail_intake_configuration SET generation=$1,host=$2,username=$3,password=$4,port=$5,secure=$6,enabled=$7,polling=$8,category_id=$9,configured_by=$10,outcome='',summary='{}'::jsonb,cursor_uid_hash='' WHERE id=1 RETURNING *`,
      [randomUUID(), next.host, next.username, next.password, next.port, next.secure, next.enabled, next.polling, next.category_id, operator],
    )).rows[0];
    return projection(updated);
  });
}
async function claim(req: AuthRequest | undefined, automatic: boolean): Promise<Run> {
  // Resolve the automatic operator without retaining any connection over POP.
  const operator = req ? needUser(req).id : (await pool.query("SELECT configured_by FROM mail_intake_configuration WHERE id=1")).rows[0]?.configured_by;
  if (!operator) throw new HttpError(409, "Configure post by email first.");
  return transaction(async client => {
    await lockOperator(client, req, operator);
    const config = (await client.query<Configuration>("SELECT * FROM mail_intake_configuration WHERE id=1 FOR UPDATE")).rows[0];
    if (!config.enabled || (automatic && (!config.polling || environmentType() !== "production" || config.configured_by !== operator)))
      throw new HttpError(409, "Post by email is not enabled for this check.");
    normalizePOP3Configuration(config);
    const token = randomUUID();
    const claimed = await client.query<Configuration>(
      `UPDATE mail_intake_configuration SET last_checked=clock_timestamp(),lease_token=$1,lease_until=clock_timestamp()+interval '90 seconds',outcome='running',summary='{}'::jsonb
       WHERE id=1 AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (last_checked IS NULL OR last_checked<=clock_timestamp()-interval '5 minutes') RETURNING *`, [token],
    );
    if (!claimed.rowCount) throw new HttpError(429, "Email checks are limited to once every five minutes and one active check.");
    return { configuration: claimed.rows[0], token, operator };
  });
}
async function assertRun(client: PoolClient, run: Run) {
  const config = (await client.query<Configuration>("SELECT * FROM mail_intake_configuration WHERE id=1 FOR UPDATE")).rows[0];
  const valid = (await client.query("SELECT 1 FROM mail_intake_configuration WHERE id=1 AND generation=$1 AND lease_token=$2 AND enabled AND lease_until>clock_timestamp()", [run.configuration.generation, run.token])).rowCount;
  if (!valid || config.configured_by !== run.configuration.configured_by) throw new HttpError(409, "Mailbox settings or the active check changed. Check mail again.");
  return config;
}
function messageContent(message: ReturnType<typeof parseMailMessage>) {
  const segments = message.body.split("::", 3);
  const body = (segments[1] ? segments[1] : segments[0]).trim();
  if (!body) throw new MailMessageError("invalid_message");
  const title = /<title>(.+?)<\/title>/is.exec(body)?.[1]?.trim() || message.subject;
  // Plain text must remain literal text when passed to the ordinary HTML cleaner.
  const escaped = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return { title, content: message.isHTML ? body : escaped };
}
async function importMessage(run: Run, req: AuthRequest | undefined, uidHash: string, message: ReturnType<typeof parseMailMessage>) {
  return transaction(async client => {
    // Account deletion/reassignment locks users before posts. Lock every possible
    // author/fallback and operator together in stable order, never mailbox first.
    const people = (await client.query<User>(`SELECT ${userFields} FROM users WHERE id=$1 OR lower(email)=ANY($2::text[]) OR role='administrator' ORDER BY id FOR SHARE`, [run.operator, message.senderCandidates])).rows;
    const actor = people.find(person => person.id === run.operator);
    if (!actor || actor.role !== "administrator") throw new HttpError(403, "The email operator is no longer an administrator.");
    if (req) await assertActiveAccountAuthentication(req, client);
    const author = message.senderCandidates.map(email => people.find(person => person.email.toLowerCase() === email)).find(Boolean);
    const owner = author || people.find(person => person.role === "administrator");
    if (!owner) throw new HttpError(409, "No site administrator is available for this email.");
    const config = await assertRun(client, run), mailbox = mailboxHash(run.configuration);
    if ((await client.query("SELECT 1 FROM mail_intake_receipts WHERE mailbox_hash=$1 AND uid_hash=$2", [mailbox, uidHash])).rowCount) return false;
    if (Number((await client.query("SELECT count(*) FROM mail_intake_receipts")).rows[0].count) >= 100_000) throw new HttpError(409, "The email receipt limit has been reached.");
    const category = config.category_id !== null && (await client.query("SELECT 1 FROM terms WHERE id=$1 AND taxonomy='category'", [config.category_id])).rowCount ? config.category_id : null;
    const post = await createMailPost(client, owner, { ...messageContent(message), categoryId: category, date: message.date }, Boolean(author));
    await client.query("INSERT INTO mail_intake_receipts(mailbox_hash,uid_hash,post_id) VALUES($1,$2,$3)", [mailbox, uidHash, post.id]);
    // Locks or slow ordinary post validation may outlive the lease. Use wall time,
    // not the transaction's now(), so this transaction rolls back if that happens.
    await assertRun(client, run);
    if (req) await assertActiveAccountAuthentication(req, client);
    return true;
  });
}
async function beforeDeletion(run: Run, req: AuthRequest | undefined) {
  await transaction(async client => { await lockOperator(client, req, run.operator); await assertRun(client, run); });
}
let active = false;
/** Fixed bounded mailbox intake. Test peers are injectable, never an API bypass. */
export async function checkMailIntake(req?: AuthRequest, open: Open = openPOP3, automatic = false) {
  if (active) throw new HttpError(429, "A mailbox check is already running.");
  active = true;
  let run: Run | undefined, session: Awaited<ReturnType<Open>> | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined, renewing: Promise<unknown> | undefined;
  let outcome = "unavailable";
  let cursor = "";
  const summary: Summary = { examined: 0, imported: 0, duplicates: 0, skipped: 0, deletionRequested: 0, deletionCommitted: 0 };
  try {
    run = await claim(req, automatic);
    const owned = run;
    renewal = setInterval(() => {
      if (renewing) return;
      renewing = pool.query("UPDATE mail_intake_configuration SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=1 AND lease_token=$1 AND lease_until>clock_timestamp()", [owned.token])
        .then(result => { if (!result.rowCount) void session?.abort(); })
        .catch(() => { void session?.abort(); }).finally(() => { renewing = undefined; });
    }, 10_000); renewal.unref();
    session = await open(normalizePOP3Configuration(run.configuration));
    const messages = await session.list(); let bytes = 0;
    const previous = messages.findIndex(message => hash(message.uid) === run!.configuration.cursor_uid_hash);
    const ordered = previous < 0 ? messages : [...messages.slice(previous + 1), ...messages.slice(0, previous + 1)];
    for (const message of ordered.slice(0, 20)) {
      summary.examined++;
      cursor = hash(message.uid);
      await beforeDeletion(run, req);
      const uid = hash(message.uid), mailbox = mailboxHash(run.configuration);
      const exists = (await pool.query("SELECT 1 FROM mail_intake_receipts WHERE mailbox_hash=$1 AND uid_hash=$2", [mailbox, uid])).rowCount;
      if (exists) summary.duplicates++;
      else {
        if (message.size > MAX_POP3_MESSAGE_BYTES || bytes + message.size > 6 * MAX_POP3_MESSAGE_BYTES) { summary.skipped++; continue; }
        const raw = await session.retrieve(message.number); bytes += raw.length;
        let parsed: ReturnType<typeof parseMailMessage>;
        try { parsed = parseMailMessage(raw); }
        catch (error) { if (!(error instanceof MailMessageError)) throw error; summary.skipped++; continue; }
        try { if (await importMessage(run, req, uid, parsed)) summary.imported++; else summary.duplicates++; }
        catch (error) { if (!(error instanceof MailMessageError) && !(error instanceof z.ZodError)) throw error; summary.skipped++; continue; }
      }
      // Receipt/post is committed before even asking POP to mark the message.
      await beforeDeletion(run, req);
      await session.remove(message.number); summary.deletionRequested++;
    }
    await beforeDeletion(run, req);
    await session.quit(); summary.deletionCommitted = summary.deletionRequested;
    outcome = summary.skipped ? "completed_with_skips" : "completed";
    return { outcome, ...summary };
  } catch (error) {
    outcome = error instanceof POP3Error || error instanceof MailMessageError ? error.outcome : error instanceof HttpError ? "changed_or_forbidden" : "unavailable";
    if (error instanceof POP3Error || error instanceof MailMessageError) throw new HttpError(502, error.message);
    throw error;
  } finally {
    // Renewal and admission remain owned through actual physical socket closure.
    if (session) await session.abort();
    if (renewal) clearInterval(renewal);
    if (renewing) await renewing;
    if (run) await pool.query("UPDATE mail_intake_configuration SET lease_token=NULL,lease_until=NULL,outcome=CASE WHEN generation=$4 THEN $2 ELSE outcome END,summary=CASE WHEN generation=$4 THEN $3::jsonb ELSE summary END,cursor_uid_hash=CASE WHEN generation=$4 AND $5<>'' THEN $5 ELSE cursor_uid_hash END WHERE id=1 AND lease_token=$1", [run.token, outcome, JSON.stringify(summary), run.configuration.generation, cursor]).catch(() => {});
    active = false;
  }
}
export function startMailIntakeWorker() {
  const interval = setInterval(() => {
    if (active || environmentType() !== "production") return;
    void pool.query("SELECT 1 FROM mail_intake_configuration WHERE id=1 AND enabled AND polling AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (last_checked IS NULL OR last_checked<=clock_timestamp()-interval '5 minutes')")
      .then(result => { if (result.rowCount) return checkMailIntake(undefined, openPOP3, true); })
      .catch(() => {});
  }, 60_000); interval.unref(); return () => clearInterval(interval);
}
const router = Router(), admin = requireRole("administrator");
router.get("/tools/mail-intake", admin, async (_req, res) => res.json({ mailbox: await readMailIntakeConfiguration() }));
router.put("/tools/mail-intake", admin, async (req, res) => res.json({ mailbox: await updateMailIntakeConfiguration(req, req.body) }));
router.post("/tools/mail-intake/check", admin, async (req, res) => {
  z.object({}).strict().parse(req.body || {}); res.json(await checkMailIntake(req));
});
export default router;
