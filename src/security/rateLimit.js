// Rate limiter a finestra scorrevole in memoria.
export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  // Restituisce true se l'azione è consentita (e la registra).
  hit(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10000) this.prune(now);
    return true;
  }

  remaining(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    return Math.max(0, this.max - arr.length);
  }

  reset(key) { this.hits.delete(key); }

  prune(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      if (!arr.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
  }
}
