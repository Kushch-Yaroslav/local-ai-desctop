#!/usr/bin/env python3
"""Measure an already running, isolated production llama-server. Never launches a model."""
import argparse
import hashlib
import json
import statistics
import subprocess
import threading
import time
import urllib.request
from pathlib import Path


def memory(pid):
    gpu = subprocess.check_output([
        'nvidia-smi', '--query-gpu=memory.used,memory.free,utilization.gpu',
        '--format=csv,noheader,nounits'], text=True).strip().splitlines()[0].split(',')
    apps = subprocess.check_output([
        'nvidia-smi', '--query-compute-apps=pid,used_gpu_memory',
        '--format=csv,noheader,nounits'], text=True).strip().splitlines()
    own = next((int(line.split(',')[1]) for line in apps if line.split(',')[0].strip() == str(pid)), 0)
    rss = next(int(line.split()[1]) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if line.startswith('VmRSS:'))
    return dict(totalUsedMiB=int(gpu[0]), freeMiB=int(gpu[1]), utilization=int(gpu[2]), serverMiB=own, serverRssKiB=rss)


def request(url, model, prompt, count):
    body = dict(model=model, messages=[dict(role='user', content=prompt)], temperature=0,
                seed=42, max_tokens=count, stream=False, cache_prompt=False,
                chat_template_kwargs=dict(enable_thinking=False))
    request = urllib.request.Request(url + '/v1/chat/completions', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    start = time.monotonic()
    with urllib.request.urlopen(request, timeout=600) as response:
        result = json.load(response)
    return result, time.monotonic() - start


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--runtime-root', type=Path, required=True)
    parser.add_argument('--prompts', type=Path, required=True, help='JSON array of {name,prompt}')
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--tokens', type=int, default=512)
    args = parser.parse_args()
    state = json.loads((args.runtime_root / 'llama-cpp-runtime-state.json').read_text())
    if state['status'] != 'ready':
        raise RuntimeError('The production launcher must confirm ready before benchmarking.')
    pid, model = state['serverPid'], state['modelId']
    results = dict(state=state, promptsSha256=hashlib.sha256(args.prompts.read_bytes()).hexdigest(),
                   generatedTokenLimit=args.tokens, temperature=0, seed=42, cachePrompt=False,
                   thinking=False, baselineMemory=memory(pid), samples=[], requests=[])
    done = threading.Event()

    def sample():
        while not done.is_set():
            try:
                results['samples'].append(dict(time=time.time(), **memory(pid)))
            except (OSError, subprocess.SubprocessError):
                pass
            done.wait(0.25)

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    try:
        prompts = json.loads(args.prompts.read_text())
        for prompt in prompts:
            response, duration = request(args.url, model, prompt['prompt'], 128)
            results.setdefault('warmups', []).append(dict(name=prompt['name'], wallSeconds=duration, response=response))
        for repetition in range(args.repetitions):
            for prompt in prompts:
                response, duration = request(args.url, model, prompt['prompt'], args.tokens)
                row = dict(name=prompt['name'], repetition=repetition, wallSeconds=duration,
                           memoryAfter=memory(pid), response=response)
                results['requests'].append(row)
                print(json.dumps(dict(name=prompt['name'], repetition=repetition,
                                      usage=response.get('usage'), timings=response.get('timings'), wallSeconds=duration)), flush=True)
                (args.runtime_root / 'benchmark.json').write_text(json.dumps(results, indent=2))
        rates = [r['response']['timings']['predicted_per_second'] for r in results['requests']]
        results['summary'] = dict(medianDecodeTokensPerSecond=statistics.median(rates),
                                 meanDecodeTokensPerSecond=statistics.mean(rates),
                                 peakServerMiB=max(s['serverMiB'] for s in results['samples']),
                                 peakTotalUsedMiB=max(s['totalUsedMiB'] for s in results['samples']),
                                 peakServerRssKiB=max(s['serverRssKiB'] for s in results['samples']))
        print(json.dumps(results['summary']), flush=True)
    finally:
        done.set()
        sampler.join(timeout=5)
        (args.runtime_root / 'benchmark.json').write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
