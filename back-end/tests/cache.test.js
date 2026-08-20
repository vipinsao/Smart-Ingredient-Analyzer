import test from "node:test";
import assert from "node:assert/strict";
import { CacheManager } from "../utils/cache.js";
import { CACHE_CONFIG } from "../configuration/constants.js";

test("the text key is stable and case-insensitive", () => {
  const cache = new CacheManager();
  try {
    assert.equal(cache.generateKey("Water, Sugar"), cache.generateKey("water, sugar"));
    assert.notEqual(cache.generateKey("water"), cache.generateKey("sugar"));
  } finally {
    cache.close();
  }
});

test("the image key is content-addressed, so identical bytes reuse the OCR result", () => {
  const cache = new CacheManager();
  try {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
    const samePhoto = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
    const otherPhoto = Buffer.from([0xff, 0xd8, 0xff, 0x09]);

    assert.equal(cache.generateImageKey(photo), cache.generateImageKey(samePhoto));
    assert.notEqual(cache.generateImageKey(photo), cache.generateImageKey(otherPhoto));
    assert.match(cache.generateImageKey(photo), /^img:[0-9a-f]{64}$/);
  } finally {
    cache.close();
  }
});

test("a stored result round-trips", () => {
  const cache = new CacheManager();
  try {
    const key = cache.generateKey("water, sugar");
    cache.set(key, { healthScore: { score: 72 } });

    assert.equal(cache.has(key), true);
    assert.equal(cache.get(key).healthScore.score, 72);
  } finally {
    cache.close();
  }
});


// ---------------------------------------------------------------------------
// The cache key is a content hash and the caller supplies the content: one byte
// appended after a JPEG's EOI marker changes the hash without changing a pixel,
// which is a trick scripts/profile-analyze.js documents and relies on. Without
// maxKeys every distinct byte string bought a 48-hour entry.
// ---------------------------------------------------------------------------

test("the cache is bounded and evicts rather than failing when full", () => {
  assert.equal(typeof CACHE_CONFIG.maxKeys, "number");

  const manager = new CacheManager();
  const total = CACHE_CONFIG.maxKeys + 50;
  for (let i = 0; i < total; i += 1) manager.set(`key-${i}`, { i });

  assert.equal(manager.getStats().keys, CACHE_CONFIG.maxKeys, "cache must not grow past its bound");
  // The newest write survived - a full cache must not start refusing work.
  assert.deepEqual(manager.get(`key-${total - 1}`), { i: total - 1 });
  // The oldest was evicted, which is the half that keeps memory flat.
  assert.equal(manager.get("key-0"), undefined);
  manager.close();
});
