<?php

/**
 * checklist.php — live shared checklist state for the UTMB 2026 crew app.
 *
 * One tiny optimistic-concurrency store. No framework, no Composer, no
 * database: the whole shared state is a single JSON envelope on disk next to
 * this file, guarded by an exclusive flock and replaced by an atomic rename.
 *
 * WIRE CONTRACT (js/sync.js implements exactly this)
 * --------------------------------------------------
 *   GET  checklist.php
 *        200 {"version":N,"data":<object|null>,"updatedAt":<iso|null>}
 *        version 0 + data null when nothing has been stored yet.
 *
 *   POST checklist.php   {"token":"...","baseVersion":N,"data":{...}}
 *        403 {"error":"bad token"}    token missing or wrong
 *        400 {"error":"bad request"}  malformed JSON, missing/!object data,
 *                                     non-numeric baseVersion, body > 256 KiB
 *        409 {"version":cur,"data":<current>,"updatedAt":...}
 *                                     baseVersion is not the current version;
 *                                     the authoritative state comes back so the
 *                                     client can merge and retry
 *        200 {"version":N+1,"data":<stored>,"updatedAt":...}   stored
 *
 * FILES (all denied to the web by the .htaccess in this directory)
 *   checklist-live.json       the envelope: {version, data, updatedAt}
 *   checklist-live.lock       lock target only; never renamed, never read
 *   checklist-live.json.tmp   staging file for the atomic rename
 *
 * The lock lives in its OWN file on purpose. The data file is replaced by
 * rename(), which swaps the inode underneath any descriptor open on it, so a
 * lock held on the data file would not actually serialise two writers. The
 * lock file is never renamed, so every writer contends on the same inode.
 *
 * A single fixed .tmp name is used rather than a unique one: the whole
 * read-modify-write runs under LOCK_EX, so only one writer can ever be staging
 * at a time, and a failed rename can therefore leave at most one stray file
 * (which the next write overwrites) instead of an unbounded pile.
 *
 * Turkish checklist text round-trips byte for byte: JSON_UNESCAPED_UNICODE on
 * the way out, and the payload is decoded into stdClass (not assoc arrays) so
 * an empty object survives as {} instead of degrading into [].
 */

declare(strict_types=1);

const SYNC_TOKEN     = 'crewsync-17fa94ab349f';
const MAX_BODY_BYTES = 262144;
const DATA_FILE      = 'checklist-live.json';
const LOCK_FILE      = 'checklist-live.lock';
const TMP_FILE       = 'checklist-live.json.tmp';
const JSON_FLAGS     = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');

/**
 * Emit one JSON response and stop. Every exit path in this file goes here.
 */
function send(int $status, array $payload): void
{
    $body = json_encode($payload, JSON_FLAGS);
    if ($body === false) {
        http_response_code(500);
        echo '{"error":"encode failed"}';
        exit;
    }
    http_response_code($status);
    echo $body;
    exit;
}

/**
 * Read the stored envelope.
 *
 * Anything unreadable, empty, truncated or not shaped like an envelope is
 * reported as the empty state (version 0 / data null) rather than as an error:
 * the client then re-seeds from its own copy and the store heals itself. The
 * suspect file is left on disk untouched — nothing here ever deletes.
 *
 * @return array{version:int,data:object|null,updatedAt:string|null}
 */
function read_state(string $path): array
{
    $empty = ['version' => 0, 'data' => null, 'updatedAt' => null];

    if (!is_file($path)) {
        return $empty;
    }

    $raw = @file_get_contents($path);
    if ($raw === false || $raw === '') {
        return $empty;
    }

    $decoded = json_decode($raw, false, 64);
    if (json_last_error() !== JSON_ERROR_NONE || !is_object($decoded)) {
        return $empty;
    }

    $version = 0;
    if (isset($decoded->version) && is_numeric($decoded->version)) {
        $version = (int) $decoded->version;
        if ($version < 0) {
            $version = 0;
        }
    }

    $data = (isset($decoded->data) && is_object($decoded->data)) ? $decoded->data : null;

    $updatedAt = (isset($decoded->updatedAt) && is_string($decoded->updatedAt))
        ? $decoded->updatedAt
        : null;

    return ['version' => $version, 'data' => $data, 'updatedAt' => $updatedAt];
}

/**
 * Release a lock handle acquired with acquire_lock().
 *
 * @param resource $handle
 */
function release_lock($handle): void
{
    @flock($handle, LOCK_UN);
    @fclose($handle);
}

/**
 * Open + lock the dedicated lock file. Returns null when the lock cannot be
 * taken (read-only mount, exhausted descriptors, ...).
 *
 * @return resource|null
 */
function acquire_lock(string $path, int $mode)
{
    $handle = @fopen($path, 'c');
    if ($handle === false) {
        return null;
    }
    if (!@flock($handle, $mode)) {
        @fclose($handle);
        return null;
    }
    return $handle;
}

$dir      = __DIR__;
$dataPath = $dir . DIRECTORY_SEPARATOR . DATA_FILE;
$lockPath = $dir . DIRECTORY_SEPARATOR . LOCK_FILE;
$tmpPath  = $dir . DIRECTORY_SEPARATOR . TMP_FILE;

$method = isset($_SERVER['REQUEST_METHOD']) && is_string($_SERVER['REQUEST_METHOD'])
    ? strtoupper($_SERVER['REQUEST_METHOD'])
    : 'GET';

/* Same-origin only in practice, so no preflight is ever expected; answer one
 * anyway rather than 405-ing a browser that decides to send it. */
if ($method === 'OPTIONS') {
    header('Allow: GET, POST, OPTIONS');
    http_response_code(204);
    exit;
}

/* ------------------------------------------------------------------ *
 * GET — hand back the current state
 * ------------------------------------------------------------------ */

if ($method === 'GET' || $method === 'HEAD') {
    /* A shared lock keeps a reader off a half-written file on platforms where
     * rename() is not atomic. Reading without the lock is still correct on
     * POSIX, so a failed lock is not an error — just read. */
    $handle = acquire_lock($lockPath, LOCK_SH);
    $state  = read_state($dataPath);
    if ($handle !== null) {
        release_lock($handle);
    }
    send(200, $state);
}

if ($method !== 'POST') {
    header('Allow: GET, POST, OPTIONS');
    send(405, ['error' => 'method not allowed']);
}

/* ------------------------------------------------------------------ *
 * POST — compare-and-set
 * ------------------------------------------------------------------ */

$raw = file_get_contents('php://input');
if ($raw === false) {
    $raw = '';
}

if (strlen($raw) > MAX_BODY_BYTES) {
    send(400, ['error' => 'bad request']);
}

$body = json_decode($raw, false, 64);
if (json_last_error() !== JSON_ERROR_NONE || !is_object($body)) {
    send(400, ['error' => 'bad request']);
}

/* Token before shape, so a wrong token never learns anything about the schema.
 * hash_equals keeps the comparison constant time. */
$token = (isset($body->token) && is_string($body->token)) ? $body->token : '';
if (!hash_equals(SYNC_TOKEN, $token)) {
    send(403, ['error' => 'bad token']);
}

if (!isset($body->baseVersion) || !is_numeric($body->baseVersion)) {
    send(400, ['error' => 'bad request']);
}
$baseVersion = (int) $body->baseVersion;
if ($baseVersion < 0) {
    send(400, ['error' => 'bad request']);
}

/* isset() is false for null, so a null data field lands here too. */
if (!isset($body->data) || !is_object($body->data)) {
    send(400, ['error' => 'bad request']);
}

$handle = acquire_lock($lockPath, LOCK_EX);
if ($handle === null) {
    send(503, ['error' => 'busy']);
}

$state = read_state($dataPath);

if ($baseVersion !== $state['version']) {
    /* Stale writer. Hand back the authoritative state; the client merges it
     * with its own copy and posts again against the version it just learned. */
    release_lock($handle);
    send(409, $state);
}

$envelope = [
    'version'   => $state['version'] + 1,
    'data'      => $body->data,
    'updatedAt' => gmdate('Y-m-d\TH:i:s\Z'),
];

$json = json_encode($envelope, JSON_FLAGS);
if ($json === false) {
    release_lock($handle);
    send(400, ['error' => 'bad request']);
}

$written = @file_put_contents($tmpPath, $json);
if ($written === false || $written !== strlen($json)) {
    release_lock($handle);
    send(500, ['error' => 'write failed']);
}

@chmod($tmpPath, 0644);

/* Atomic on any sane filesystem: readers see either the whole old file or the
 * whole new one, never a partial write. */
if (!@rename($tmpPath, $dataPath)) {
    release_lock($handle);
    send(500, ['error' => 'write failed']);
}

release_lock($handle);
send(200, $envelope);
