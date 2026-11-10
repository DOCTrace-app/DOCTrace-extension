// Asynchronous FIFO queue with a fixed number of workers.
//
// - Frames start in arrival order. With concurrency 1 they are handled strictly
//   one at a time; with N (one per OCR worker, see ocr/ocrPool.js) up to N run
//   together, and each Tesseract worker is still only ever given one image.
// - The queue is bounded (backpressure). When it is full, push() refuses the
//   frame with code QUEUE_FULL instead of using unlimited memory; the recorder
//   retries after `retryAfterMs`. Nothing is dropped silently.
// - drain() resolves when every queued job has finished (used at session end).

export class FrameQueue {
  constructor(worker, { maxQueued = 15, onError = () => {}, concurrency = 1 } = {}) {
    this.worker = worker;
    this.maxQueued = maxQueued;
    this.onError = onError;
    this.concurrency = Math.max(1, concurrency | 0);
    this.items = [];
    this.active = new Set();
    this.idleWaiters = [];
  }

  get size() { return this.items.length + this.active.size; }

  /** True while at least one job runs (kept for callers of the old single-worker queue). */
  get running() { return this.active.size > 0; }

  push(job) {
    if (this.items.length >= this.maxQueued) return { accepted: false, code: 'QUEUE_FULL', queued: this.size };
    this.items.push(job);
    queueMicrotask(() => this.#pump());
    return { accepted: true, queued: this.size };
  }

  /** Wait until all jobs that match `filter` (default: all) are done. */
  drain(filter = () => true) {
    const pending = () => [...this.active].some(filter) || this.items.some(filter);
    if (!pending()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push({ pending, resolve }));
  }

  #pump() {
    while (this.active.size < this.concurrency && this.items.length) {
      const job = this.items.shift();
      this.active.add(job);
      Promise.resolve()
        .then(() => this.worker(job))
        .catch((err) => this.onError(err, job)) // one bad frame never stops the queue
        .finally(() => {
          this.active.delete(job);
          this.#notify();
          this.#pump();
        });
    }
  }

  #notify() {
    this.idleWaiters = this.idleWaiters.filter((w) => {
      if (w.pending()) return true;
      w.resolve();
      return false;
    });
  }
}
