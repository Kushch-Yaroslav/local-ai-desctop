// A deliberately small starting implementation for the live Agent comparison.
class Queue {
  constructor(worker) {
    this.worker = worker;
    this.jobs = [];
    this.running = false;
    this.nextId = 1;
  }

  enqueue(value) {
    const id = this.nextId++;
    this.jobs.push({ id, value });
    return id;
  }

  async drain() {
    if (this.running) throw new Error('already draining');
    this.running = true;
    const results = [];
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift();
        results.push({ id: job.id, value: await this.worker(job.value) });
      }
      return results;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Queue };
