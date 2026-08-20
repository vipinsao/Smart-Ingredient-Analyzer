import test from "node:test";
import assert from "node:assert/strict";
import { CacheManager } from "../utils/cache.js";

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
