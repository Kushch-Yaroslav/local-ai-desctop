// Independent acceptance oracle: the agent never receives this source.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const project = path.resolve(process.argv[2] ?? process.cwd());
const { Queue } = require(path.join(project, 'queue.cjs'));

async function main() {
  const calls = [];
  const q = new Queue(async value => { calls.push(value); return value; });
  const low = q.enqueue('low', { priority: -1 });
  const first = q.enqueue('first', { priority: 2 });
  const second = q.enqueue('second', { priority: 2 });
  const cancelled = q.enqueue('cancel', { priority: 9 });
  assert.equal(q.cancel(cancelled), true);
  assert.equal(q.cancel(cancelled), false);
  assert.equal(q.cancel(99999), false);
  assert.deepEqual(await q.drain(), [{ id: first, value: 'first' }, { id: second, value: 'second' }, { id: low, value: 'low' }]);
  assert.deepEqual(calls, ['first', 'second', 'low']);
  for (const options of [{ priority: NaN }, { priority: Infinity }, { retries: -1 }, { retries: 0.5 }]) {
    assert.throws(() => q.enqueue('bad', options));
  }
  let attempts = 0;
  const retry = new Queue(async value => {
    if (value === 'retry' && ++attempts < 3) throw new Error('transient');
    if (value === 'fail') throw new Error('permanent');
    return value;
  });
  const a = retry.enqueue('retry', { retries: 2 });
  const b = retry.enqueue('fail', { retries: 1 });
  const c = retry.enqueue('ok');
  // Completion order of interleaved retry attempts is not specified by TASK.
  assert.deepEqual((await retry.drain()).sort((x, y) => x.id - y.id), [{ id: a, value: 'retry' }, { id: b, error: 'permanent' }, { id: c, value: 'ok' }]);
  assert.equal(attempts, 3);
  const dynamicOrder = [];
  const dynamic = new Queue(async value => {
    dynamicOrder.push(value);
    if (value === 'current') dynamic.enqueue('new-high', { priority: 10 });
    return value;
  });
  dynamic.enqueue('current', { priority: 5 });
  dynamic.enqueue('old-low', { priority: 0 });
  await dynamic.drain();
  assert.deepEqual(dynamicOrder, ['current', 'new-high', 'old-low'], 'newly queued higher-priority jobs must precede queued lower-priority jobs');
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  let running;
  const concurrent = new Queue(async value => {
    assert.equal(concurrent.cancel(running), false);
    concurrent.enqueue('added');
    if (value === 'running') await gate;
    return value;
  });
  // Avoid recursively enqueueing in the worker for later jobs.
  const original = concurrent.worker;
  concurrent.worker = value => value === 'running' ? original(value) : Promise.resolve(value);
  running = concurrent.enqueue('running');
  const pending = concurrent.drain();
  await assert.rejects(() => concurrent.drain());
  resolve();
  const results = await pending;
  assert.equal(results.length, 2);
  assert.deepEqual(await concurrent.drain(), []);
  const documentation = fs.readFileSync(path.join(project, 'README.md'), 'utf8');
  for (const concept of ['priority', 'retries', 'cancel']) assert(documentation.includes(concept), `API documentation lacks ${concept}`);
  const demo = fs.readFileSync(path.join(project, 'demo.cjs'), 'utf8');
  assert(demo.includes('priority') && demo.includes('cancel'), 'CLI must demonstrate priority and cancellation');
  execFileSync(process.execPath, [path.join(project, 'demo.cjs'), 'hello', 'world']);
  console.log('independent acceptance oracle passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
