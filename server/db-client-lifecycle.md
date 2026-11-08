# Shared PostgreSQL client error lifecycle

An asynchronous query rejection and a Client EventEmitter `error` are separate
paths. The pool handles errors on idle clients, but removes its idle listener
while a client is checked out. A real transport loss can reject COMMIT and emit
an otherwise unhandled Client error before a transaction catch finishes. This
can terminate the process even when the transaction/file cleanup is correct.

The shared pool registers one static error observer per physical connection in
its `connect` event. It lasts for that connection, including checkout, release
and removal; it is not added for every borrow. It logs a fixed diagnostic with
no credentials, SQL, request data or server-provided error detail. It does not
intercept a query, retry a transaction, release a client or suppress other event
listeners. Existing query promises/callbacks still receive their real errors and
SQLSTATEs. The existing pool-level idle error listener still receives errors and
removes idle failures.

Installed pg marks a disconnected client nonqueryable before emitting its error;
pg-pool's normal release path removes nonqueryable/ending clients rather than
making them idle. The observer lets callers reach their existing catch/finally
and this eviction path. It adds no private driver-field access or release
monkeypatch. Site-icon rollback still preserves its original error, releases its
client before checking live references, and keeps committed/unverifiable files.
There is no retry after an uncertain commit.

`tests/db-client-lifecycle.test.ts` uses actual PostgreSQL in the guarded database:
twenty repeated checkouts keep exactly one lifetime observer, normal Promise and
callback SQL errors retain 22012, a real transaction can roll back and reuse its
connection, terminating an active checked-out backend produces the original
57P01 rejection without an unhandled event, that client is removed before a
different backend is borrowed, an interrupted ordinary pooled read also rejects
and recovers, and idle errors still propagate through the pool and eviction.
No test-only Client error listener substitutes for the production observer.

The separate disposable loopback protocol-proxy gate exercises the actual
compiled HTTP server: PostgreSQL completes the icon COMMIT, the proxy withholds
its acknowledgement and closes that transport, the request returns a generic
500 while the process remains alive, and all six committed PNG references/files,
source/unrelated media, later API reads, retry and deletion remain functional.
This is an intentional local wire fault after an observed real COMMIT, not a
naturally observed outage or a source-handler promise simulation. The proxy and
its runner helpers are temporary review artifacts, not production hooks.
