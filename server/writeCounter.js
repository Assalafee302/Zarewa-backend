/**
 * Monotonic counter bumped on every write this process sends to the database.
 *
 * Used to answer "could anything the caller cached have changed?" in O(1), with
 * no queries at all. It deliberately over-invalidates — any write anywhere bumps
 * it for everyone — because the safe direction is to rebuild when unsure. It can
 * never under-invalidate for writes that go through this process.
 *
 * Caveat: writes made to MySQL out of band (a CLI script or a DBA session while
 * the server is running) do not bump it. Set ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER=0
 * to fall back to rebuilding on every request if that matters in your deployment.
 *
 * @module server/writeCounter
 */

let writeSeq = 0;

/** Bump after a statement that may have changed data. */
export function noteWrite() {
  writeSeq += 1;
}

/** Current write sequence — changes iff a write went through this process. */
export function writeSequence() {
  return writeSeq;
}

/**
 * May a caller trust the counter to gate conditional responses?
 * Defaults to on; disable when out-of-band writes are expected against a live server.
 */
export function writeCounterTrusted() {
  return !/^(0|false|no|off)$/i.test(String(process.env.ZAREWA_BOOTSTRAP_TRUST_WRITE_COUNTER ?? '1').trim());
}
