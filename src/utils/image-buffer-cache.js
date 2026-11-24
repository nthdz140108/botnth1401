import { loadImageBuffer } from "./util.js";
import { getResourceProfile } from "./resource-profile.js";

const TIME_CLEANUP = 1 * 60 * 1000;

export class ImageBufferCache {
  constructor({ maxBytes, ttlMs } = {}) {
    const profile = getResourceProfile();
    this.cache = new Map();
    this.downloading = new Map();
    this.maxBytes = maxBytes !== undefined ? maxBytes : profile.imageBufferMaxBytes;
    this.ttlMs = ttlMs !== undefined ? ttlMs : profile.imageBufferTtlMs;
    this.totalBytes = 0;
    this.cleanupInterval = setInterval(() => this.cleanup(), TIME_CLEANUP);
    this.cleanupInterval.unref?.();
  }

  applyProfile(botKey = null) {
    const profile = getResourceProfile(botKey);
    this.maxBytes = profile.imageBufferMaxBytes;
    this.ttlMs = profile.imageBufferTtlMs;
    this.cleanup();
  }

  async getBuffer(url, options = {}) {
    const cacheKey = this.getCacheKey(url, options);

    // Kiểm tra cache
    if (this.cache.has(cacheKey)) {
      const entry = this.cache.get(cacheKey);
      entry.timestamp = Date.now();
      return entry.buffer;
    }

    // Nếu đang download, đợi kết quả
    if (this.downloading.has(cacheKey)) {
      return await this.downloading.get(cacheKey);
    }

    // Tạo promise download mới
    const downloadPromise = this.downloadBuffer(url, options);
    this.downloading.set(cacheKey, downloadPromise);

    try {
      const result = await downloadPromise;
      this.setBuffer(cacheKey, result);
      this.downloading.delete(cacheKey);
      return result;
    } catch (error) {
      this.downloading.delete(cacheKey);
      throw error;
    }
  }

  setBuffer(cacheKey, buffer) {
    if (!Buffer.isBuffer(buffer)) return;
    const byteSize = buffer.byteLength || buffer.length || 0;

    // Buffer lớn hơn trần được xử lý nhưng không cache
    if (byteSize > this.maxBytes) return;

    // Evict oldest if adding would exceed maxBytes
    while (this.totalBytes + byteSize > this.maxBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldestEntry = this.cache.get(oldestKey);
      this.totalBytes -= oldestEntry?.byteSize || 0;
      this.cache.delete(oldestKey);
    }

    if (this.cache.has(cacheKey)) {
      const existing = this.cache.get(cacheKey);
      this.totalBytes -= existing?.byteSize || 0;
    }

    this.cache.set(cacheKey, {
      buffer,
      byteSize,
      timestamp: Date.now(),
    });
    this.totalBytes += byteSize;
  }

  getCacheKey(url, options) {
    return `${url}:${JSON.stringify(options)}`;
  }

  async downloadBuffer(url, options) {
    try {
      return await loadImageBuffer(url);
    } catch (error) {
      console.error(`Error downloading image from ${url}:`, error);
      throw error;
    }
  }

  cleanup(now = Date.now()) {
    for (const [key, data] of this.cache.entries()) {
      if (now - data.timestamp > this.ttlMs) {
        this.totalBytes -= data.byteSize || 0;
        this.cache.delete(key);
      }
    }
    if (this.totalBytes < 0) this.totalBytes = 0;
  }

  clear() {
    this.cache.clear();
    this.downloading.clear();
    this.totalBytes = 0;
  }

  stats() {
    return {
      entries: this.cache.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
      downloading: this.downloading.size,
    };
  }
}

export const imageBufferCache = new ImageBufferCache();