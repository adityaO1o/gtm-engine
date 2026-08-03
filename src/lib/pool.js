// Concurrency-capped async runner. Every item starts its OWN independent chain (DNS -> redirect ->
// blacklist) as soon as a slot frees up — there is no "wait for the whole batch" barrier, so fast
// items (dead domains, rejected in ms) don't sit behind slow ones. `onResult` fires the instant each
// item settles, which is what lets the caller stream partial results instead of waiting for the pool
// to fully drain.
export async function runPool(items, worker, { concurrency = 100, onResult } = {}) {
  const results = new Array(items.length);
  let next = 0;

  async function lane() {
    while (next < items.length) {
      const i = next++;
      let value, error = null;
      try { value = await worker(items[i], i); }
      catch (e) { error = e; }
      results[i] = error ? { error } : { value };
      if (onResult) { try { onResult(items[i], value, error); } catch { /* caller's problem, don't kill the pool */ } }
    }
  }

  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, lane);
  await Promise.all(lanes);
  return results;
}

// A second, INDEPENDENT concurrency cap for a step nested inside a runPool worker — e.g. the outer
// pool runs DNS pre-checks at high concurrency (cheap, most candidates reject here), while only the
// smaller subset that passes DNS needs the expensive HTTP redirect-follow step gated to a lower cap.
// Without this, a burst of DNS-passing candidates could all hit the network step at once, briefly
// spiking concurrency to the outer pool's (much higher) limit.
export function createLimiter(limit) {
  let active = 0;
  const queue = [];
  function pump() {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
