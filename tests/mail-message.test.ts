import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { parseMailMessage, decodeMailSubject, MailMessageError } from "../server/mail-message.js";
import { MAX_POP3_MESSAGE_BYTES } from "../server/pop3.js";
const message = (headers: string, body: string) => Buffer.from(headers + "\r\n\r\n" + body);
const is = (outcome: MailMessageError["outcome"]) => (error: unknown) => error instanceof MailMessageError && error.outcome === outcome;
const multipart = (parts: string[], boundary = "mail-boundary") => "Preamble\r\n--" + boundary + "\r\n" + parts.join("\r\n--" + boundary + "\r\n") + "\r\n--" + boundary + "--\r\nEpilogue";

test("mail parser retains plain content and ordered sender candidates without granting identity", () => {
  const parsed = parseMailMessage(message("From: First <ONE@example.test>\r\nReply-To: two@example.test\r\nSubject: A title :: ignored suffix\r\nDate: Tue, 2 Jan 2024 03:04:05 +0200 (zone)", "A plain body\r\nSecond line\r\n"));
  assert.equal(parsed.subject, "A title"); assert.equal(parsed.body, "A plain body\r\nSecond line"); assert.equal(parsed.isHTML, false);
  assert.deepEqual(parsed.senderCandidates, ["one@example.test", "two@example.test"]);
  assert.equal(parsed.date, "2024-01-02T01:04:05.000Z");
  assert.deepEqual(Object.keys(parsed).sort(), ["body", "date", "isHTML", "senderCandidates", "subject"]);
  const ambiguous = parseMailMessage(message("From: victim@example.test, attacker@example.test\r\nSubject: Unknown", "Body"));
  assert.deepEqual(ambiguous.senderCandidates, []); assert.equal(ambiguous.date, null);
});

test("real MIME base64/quoted-printable and declared charsets decode body and folded encoded headers", () => {
  const parsed = parseMailMessage(message("Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n =?UTF-8?Q?_world?=\r\nContent-Type: text/html; charset=\"utf-8\"\r\nContent-Transfer-Encoding: base64", Buffer.from("<p>Hello <strong>Привет</strong> &amp; literal</p>").toString("base64")));
  assert.equal(parsed.subject, "Привет world"); assert.equal(parsed.body, "<p>Hello <strong>Привет</strong> &amp; literal</p>"); assert.equal(parsed.isHTML, true);
  const latin = parseMailMessage(message("Subject: =?ISO-8859-1?Q?Caf=E9?=\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable", "caf=E9=\r\n next"));
  assert.equal(latin.subject, "Café"); assert.equal(latin.body, "café next");
  const utf8 = parseMailMessage(message("Subject: Привет\r\nContent-Type: text/plain; charset=utf-8", "Текст"));
  assert.equal(utf8.subject, "Привет"); assert.equal(utf8.body, "Текст");
});

test("bounded multipart alternative selects actual HTML and retains plain fallback, ignoring inert preamble/epilogue", () => {
  const plain = "Content-Type: text/plain; charset=utf-8\r\n\r\nPlain version", html = "Content-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>Actual =3Cb=3Erich=3C/b=3E body</p>";
  const parsed = parseMailMessage(message("Subject: Alternative\r\nContent-Type: multipart/alternative; boundary=mail-boundary", multipart([plain, html])));
  assert.equal(parsed.body, "<p>Actual <b>rich</b> body</p>"); assert.equal(parsed.isHTML, true); assert.ok(!parsed.body.includes("Preamble"));
  assert.equal(parseMailMessage(message("Content-Type: multipart/alternative; boundary=mail-boundary", multipart([plain]))).body, "Plain version");
});

test("unsupported attachment/MIME/charset/encoding stays an explicit safe failure rather than silently dropping data", () => {
  for (const headers of ["Content-Type: multipart/mixed; boundary=bound", "Content-Type: application/pdf", "Content-Type: text/plain; name=attached.txt", "Content-Disposition: attachment; filename=file.txt", "Content-Disposition: inline; filename=file.txt", "Content-Transfer-Encoding: x-garbage", "Content-Type: text/plain; charset=made-up-charset"])
    assert.throws(() => parseMailMessage(message(headers, "Secret body must not appear in error")), (error: unknown) => {
      assert.ok(error instanceof MailMessageError); assert.ok(!String(error).includes("Secret body")); return true;
    });
});

test("ambiguous headers, invalid transfer bytes, malformed MIME boundaries and NUL content are rejected", () => {
  for (const raw of [
    message("Subject: First\r\nsUbJeCt: Second", "Body"), message("From: first@example.test\r\nFrom: second@example.test", "Body"),
    message(" orphan fold", "Body"), message("Bad field", "Body"), message("X-Test: \u0000", "Body"),
    message("Content-Transfer-Encoding: base64", "YWJj$"), message("Content-Transfer-Encoding: base64", "YR=="), message("Content-Transfer-Encoding: quoted-printable", "truncated="),
    message("Content-Type: multipart/alternative", "--missing"), message("Content-Type: multipart/alternative; boundary=bound", "--bound\r\nContent-Type: text/plain\r\n\r\nNo closing boundary"),
    message("Content-Type: text/plain; charset=utf-8; charset=ascii", "Body"), message("Subject: Good", "NUL\u0000body"), Buffer.from("Missing header separator"),
  ]) assert.throws(() => parseMailMessage(raw), error => error instanceof MailMessageError);
});

test("raw bytes, header bytes/count, MIME depth/parts and encoded-word work have independent bounds", () => {
  assert.throws(() => parseMailMessage(Buffer.alloc(MAX_POP3_MESSAGE_BYTES + 1)), is("limits"));
  assert.throws(() => parseMailMessage(message("X-Large: " + "a".repeat(33000), "Body")), is("limits"));
  assert.throws(() => parseMailMessage(message(Array.from({ length: 101 }, (_, i) => "X-" + i + ": a").join("\r\n"), "Body")), is("invalid_message"));
  assert.throws(() => decodeMailSubject("=?UTF-8?Q?a?=".repeat(33)), is("limits"));
  const part = "Content-Type: text/plain\r\n\r\nBody";
  assert.throws(() => parseMailMessage(message("Content-Type: multipart/alternative; boundary=mail-boundary", multipart(Array(9).fill(part)))), is("limits"));
  let nested = part;
  for (let level = 0; level < 6; level++) nested = "Content-Type: multipart/alternative; boundary=b" + level + "\r\n\r\n" + multipart([nested], "b" + level);
  assert.throws(() => parseMailMessage(Buffer.from(nested)), is("limits"));
});
