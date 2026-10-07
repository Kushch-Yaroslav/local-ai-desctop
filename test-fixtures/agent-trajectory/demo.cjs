const { Queue } = require('./queue.cjs');

async function main() {
  const queue = new Queue(async value => value.toUpperCase());
  for (const value of process.argv.slice(2)) queue.enqueue(value);
  console.log(JSON.stringify(await queue.drain()));
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { main };
