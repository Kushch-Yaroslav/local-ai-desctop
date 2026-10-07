const assert = require('node:assert/strict');
const { Queue } = require('./queue.cjs');

async function main() {
  const queue = new Queue(async value => value * 2);
  assert.equal(queue.enqueue(2), 1);
  assert.equal(queue.enqueue(3), 2);
  assert.deepEqual(await queue.drain(), [{ id: 1, value: 4 }, { id: 2, value: 6 }]);
  assert.deepEqual(await queue.drain(), []);
  console.log('baseline tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
