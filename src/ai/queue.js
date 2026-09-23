/**
 * Global serial inference queue.
 *
 * The target machine has 2 cores and roughly 5GB of RAM left after the model
 * is resident. Two concurrent vision requests do not finish faster -- they
 * thrash and can push the box into OOM, taking the whole bot down. Everything
 * that touches the model goes through here, one at a time.
 */

let tail = Promise.resolve();
let queued = 0;
let running = false;

/**
 * @param {() => Promise<T>} task
 * @param {(position: number) => void} [onQueued] called with how many jobs are ahead
 * @returns {Promise<T>}
 * @template T
 */
export function runExclusive(task, onQueued) {
  const position = queued + (running ? 1 : 0);
  if (onQueued && position > 0) onQueued(position);

  queued++;
  const result = tail.then(async () => {
    queued--;
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  });

  // Keep the chain alive even when a task rejects.
  tail = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

export function queueDepth() {
  return queued + (running ? 1 : 0);
}
