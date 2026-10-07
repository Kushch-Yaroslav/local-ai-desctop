const assert = require('node:assert/strict');
const path = require('node:path');
const { Queue } = require(path.join(process.argv[2], 'queue.cjs'));

async function main() {
  const queue = new Queue(async value => value * 2);
  assert.equal(queue.enqueue(2), 100);
  assert.equal(queue.enqueue(3), 101);
  assert.deepEqual(await queue.drain(), [{ id: 100, value: 4 }, { id: 101, value: 6 }]);
  console.log('independent small-edit oracle passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
