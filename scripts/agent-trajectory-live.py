#!/usr/bin/env python3
"""Run the same isolated coding task with a chosen Agent runtime executable.

Usage: agent-trajectory-live.py EXECUTABLE OUTPUT_DIR [MODEL] [ENDPOINT]
OUTPUT_DIR must not exist. The caller owns the inference server/settings.
No application database, model configuration or real project is modified.
"""
import collections
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

TASK = """Extend this queue project, without dependencies:
1. enqueue(value, {priority=0, retries=0}={}) keeps stable numeric IDs; drain processes higher priority first and equal priority FIFO. Validate priority as a finite number and retries as a nonnegative integer.
2. cancel(id) removes only a queued job, returns true once and false for missing/running/completed IDs. A running worker must be allowed to enqueue/cancel queued jobs.
3. A rejected worker retries that job up to retries additional attempts. Exhaustion produces {id,error:message} in drain results and other jobs continue. Success remains {id,value}. A second concurrent drain still rejects; the running flag resets after completion.
4. Extend the CLI to demonstrate priorities and cancellation; document the API and add deterministic tests covering the acceptance criteria and existing behavior. Verify through actual executable tests. Do not add optional features.
Implement and verify all four deliverables using npm test for acceptance. Work directly in this isolated project."""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('model', nargs='?', default='qwen3.6:35b-a3b-ud-q4_k_m')
    parser.add_argument('endpoint', nargs='?', default='http://127.0.0.1:8081/v1/chat/completions')
    parser.add_argument('--task-file', type=Path)
    parser.add_argument('--resume-from', type=Path)
    parser.add_argument('--context-limit', type=int, default=110592)
    parser.add_argument('--oracle', type=Path, help='Independent check for a custom task; defaults to the full queue acceptance oracle')
    args = parser.parse_args()
    executable, output = args.executable.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    fixture = Path(__file__).resolve().parent.parent / 'test-fixtures/agent-trajectory'
    if not args.resume_from:
        shutil.copytree(fixture, output / 'project')
    request = dict(type='run', run_id='trajectory-comparison',
                   endpoint=args.endpoint, model=args.model,
                   system='You are a coding agent. Complete the requested changes and report observed results.',
                   user=args.task_file.read_text() if args.task_file else TASK,
                   project_root=str(output / 'project'),
                   context_limit=args.context_limit, reasoning_mode='fast', supports_reasoning=True,
                   reasoning_options={'fast': {'enable_thinking': True}},
                   web_mode='off', policy='auto', history=[], evidence_dir=str(output / 'evidence'))
    if args.resume_from:
        previous = json.loads((args.resume_from / 'request.json').read_text())
        request['project_root'] = previous['project_root']
        request['evidence_dir'] = previous['evidence_dir']
        for line in (args.resume_from / 'events.jsonl').read_text().splitlines():
            event = json.loads(line)
            if event.get('type') == 'task_memory_update':
                request['task_memory'] = event['memory']
    (output / 'request.json').write_text(json.dumps(request, indent=2))
    env = dict(os.environ, LOCAL_AI_AGENT_TRACE_PATH=str(output / 'trace.jsonl'))
    start = time.monotonic()
    counts = collections.Counter()
    usage = collections.Counter()
    progress = 0
    turns = 0
    errors = collections.Counter()
    with (output / 'events.jsonl').open('w') as log, (output / 'stderr.log').open('w') as err:
        process = subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=err, text=True, env=env)
        process.stdin.write(json.dumps(request) + '\n')
        process.stdin.close()
        for line in process.stdout:
            log.write(line)
            log.flush()
            event = json.loads(line)
            kind = event.get('type')
            if kind == 'turn_started':
                turns += 1
            elif kind == 'agent_status':
                progress += 1
            elif kind == 'tool_call_started':
                counts[event['name']] += 1
            elif kind == 'tool_error' or (kind == 'tool_result' and event.get('is_error')):
                errors[event['name']] += 1
            elif kind == 'turn_usage':
                for key in ['prompt_tokens', 'completion_tokens', 'cached_tokens']:
                    usage[key] += event.get(key) or 0
        status = process.wait()
    wall = time.monotonic() - start
    # Independent oracle is outside the agent's acceptance evidence.
    oracle = args.oracle.resolve() if args.oracle else Path(__file__).resolve().parent.parent / 'test-fixtures/agent-trajectory-oracle.cjs'
    check = subprocess.run(['node', str(oracle), request['project_root']], capture_output=True, text=True)
    (output / 'oracle.txt').write_text(check.stdout + check.stderr)
    result = dict(wall_seconds=round(wall, 2), turns=turns, actions=sum(counts.values()),
                  progress=progress, tools=dict(counts), errors=dict(errors), usage=dict(usage),
                  runtime_exit=status, independent_oracle_exit=check.returncode)
    result['independent_oracle'] = str(oracle)
    (output / 'metrics.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    main()
