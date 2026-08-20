// utils/cache.js - In-process result cache.
//
// Two keys point at the same result:
//   image key  - sha256 of the uploaded bytes. Hit on this and the request
//                skips OCR entirely, which is the expensive half.
//   text key   - md5 of the extracted ingredient text. Hit on this and the
//                request skips only the model call, but it hits for two
//                different photos of the same product.
import NodeCache from "node-cache";
import crypto from "crypto";
import { CACHE_CONFIG } from "../configuration/constants.js";

export class CacheManager {
  constructor() {
    this.cache = new NodeCache(CACHE_CONFIG);
  }

  /** Key for extracted ingredient text; case-insensitive by design. */
  generateKey(data) {
    return crypto.createHash("md5").update(String(data).toLowerCase()).digest("hex");
  }

  /** Key for the raw uploaded image bytes. */
  generateImageKey(buffer) {
    return `img:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
  }

  get(key) {
    return this.cache.get(key);
  }

  /**
   * Store a result, evicting the oldest entry when the cache is full.
   *
   * node-cache enforces `maxKeys` by throwing ECACHEFULL rather than evicting,
   * so without this a full cache would turn every subsequent analysis into a
   * 500 - the bound would trade a memory leak for an outage. node-cache keeps
   * its keys in insertion order, so dropping the first is FIFO eviction: not
   * LRU, but bounded and predictable, and the TTL already means entries are
   * disposable.
   */
  set(key, value) {
    try {
      this.cache.set(key, value);
    } catch (error) {
      if (error?.errorcode !== "ECACHEFULL") throw error;
      const [oldest] = this.cache.keys();
      if (oldest !== undefined) this.cache.del(oldest);
      this.cache.set(key, value);
    }
  }

  has(key) {
    return this.cache.has(key);
  }

  del(key) {
    this.cache.del(key);
  }

  flush() {
    this.cache.flushAll();
  }

  close() {
    this.cache.close();
  }

  getStats() {
    return this.cache.getStats();
  }
}

export default new CacheManager();
