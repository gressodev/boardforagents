// Storage: each document is one JSON blob in Vercel Blob, written with optimistic concurrency.
// createStore(path, empty) gives a { read, update } pair for one document:
// - board/v1.json         the notices (this module's own read/update, used everywhere as before);
// - board/agents-v1.json  verified agents: claims, domains and key hashes (see lib/agents.js).
const USE_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

function createStore(path, empty) {
  let memory = empty(); // used only when no Blob store is configured (local dev and tests)

  async function download() {
    const { get } = require('@vercel/blob');
    const found = await get(path, { access: 'private', useCache: false });
    if (!found || !found.stream) return { data: empty(), etag: null };
    return { data: await new Response(found.stream).json(), etag: found.blob.etag };
  }

  async function read() {
    return USE_BLOB ? (await download()).data : structuredClone(memory);
  }

  // The ETag for a conditional write comes from the Blob API (head), not from the download response:
  // the download's ETag can differ from the stored one (for example once the body is compressed),
  // and then ifMatch never matches.
  async function storedEtag() {
    const { head, BlobNotFoundError } = require('@vercel/blob');
    try {
      return (await head(path)).etag;
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
  }

  // Applies change(data) and saves. If someone else saved in the meantime the write is refused,
  // so we reload and apply the change again: concurrent writers never overwrite each other.
  async function update(change) {
    if (!USE_BLOB) {
      const data = structuredClone(memory);
      const result = change(data);
      memory = data;
      return result;
    }
    const { put, BlobPreconditionFailedError } = require('@vercel/blob');
    for (let attempt = 1; ; attempt++) {
      // The ETag is taken before the download, so a write that lands in between makes the put fail rather than get lost.
      const etag = await storedEtag();
      const { data, etag: downloadEtag } = etag ? await download() : { data: empty(), etag: null };
      const result = change(data);
      try {
        await put(path, JSON.stringify(data), {
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
        });
        return result;
      } catch (err) {
        const conflict = err instanceof BlobPreconditionFailedError || !etag;
        if (!conflict || attempt >= 8) throw err;
        console.warn('blob write conflict, retrying', { path, attempt, etag, downloadEtag });
        await new Promise((resolve) => setTimeout(resolve, 30 * attempt + Math.random() * 150));
      }
    }
  }

  // Tests only: start the in-memory document over. Never touches Blob.
  function resetMemory() {
    memory = empty();
  }

  return { read, update, resetMemory };
}

// The board document. require('./store').read / .update keep working as before.
const board = createStore('board/v1.json', () => ({ posts: [] }));

module.exports = { createStore, read: board.read, update: board.update, resetMemory: board.resetMemory };
