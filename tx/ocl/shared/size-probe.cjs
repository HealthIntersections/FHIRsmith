/**
 * Limits how many "how big is this source?" requests (GET <concepts>?limit=1, read from the
 * num_found header) go to OCL at once. The proactive warm-up queues every source together, and
 * without a limit the burst makes some of them fail: those sources are then queued last, as if
 * they were the largest. The settings are on `sizeProbe` so tests can change them.
 */
const sizeProbe = {
  maxConcurrent: 4,
  retryDelaysMs: [1000, 3000],
  active: 0,
  waiting: []
};

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

async function withSizeProbeSlot(fn) {
  if (sizeProbe.active >= sizeProbe.maxConcurrent) {
    await new Promise(resolve => sizeProbe.waiting.push(resolve));
  }
  sizeProbe.active += 1;
  try {
    return await fn();
  } finally {
    sizeProbe.active -= 1;
    const next = sizeProbe.waiting.shift();
    if (next) {
      next();
    }
  }
}

module.exports = { sizeProbe, sleep, withSizeProbeSlot };
