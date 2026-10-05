#!/usr/bin/env python3
"""One-shot, audited baseline migration and removal of this setup's Ollama install."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

APP = Path('/media/yaroslav/DATA/local-ai-desktop')
MODELS = Path('/media/yaroslav/DATA/llama-models')
DATA = Path('/media/yaroslav/DATA/ollama')
FILES = [
    ('qwen3.8-27b-q4_K_M.gguf', 16810714464, 'f5f1dd8920d417aac2718b0bda3403da274301efdd6760b4f0f4b864ff2ad57d'),
    ('qwen3.8-27b-mmproj.gguf', 931146016, 'ac3714bfdddeca31351f2752bf1a63f266f4df87c0b68c895e44945ca704448e'),
]
RECORD = APP / 'runtime/validation/max-context-regression/ollama-migration.json'


def checksum(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        while chunk := handle.read(16 * 1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def exact_directory(path):
    assert path.is_dir() and not path.is_symlink() and path.resolve() == path, path


def open_references(root):
    found = []
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        for entry in list((process / 'fd').glob('*')) + [process / 'exe', process / 'cwd']:
            try:
                target = os.readlink(entry).removesuffix(' (deleted)')
                if target == str(root) or target.startswith(str(root) + '/'):
                    found.append((str(entry), target))
            except (FileNotFoundError, PermissionError, OSError):
                continue
        try:
            for line in (process / 'maps').read_text().splitlines():
                if str(root) + '/' in line:
                    found.append((str(process / 'maps'), line))
        except (FileNotFoundError, PermissionError):
            continue
    return found


assert os.geteuid() == 0, 'Run with sudo or pkexec; system-owned blobs require administrator access.'
assert sys.argv[1:] == ['--migrate-and-remove'], 'Use --migrate-and-remove only after the dependency audit.'
exact_directory(MODELS)
exact_directory(DATA)
assert not open_references(DATA), 'Stop any model using an Ollama blob before migration.'
records = []
for name, size, expected in FILES:
    destination = MODELS / name
    source = DATA / 'blobs' / ('sha256-' + expected)
    assert destination.is_symlink() and destination.resolve() == source
    assert source.is_file() and not source.is_symlink() and source.resolve() == source
    assert source.stat().st_size == size and checksum(source) == expected
    records.append(dict(old_path=str(source), new_path=str(destination), size=size, sha256=expected,
                        mtime_ns=source.stat().st_mtime_ns))
# Hard-link staging plus atomic replacement is a same-filesystem move: the source
# remains available until the standalone file has been verified. No extra 17 GB copy.
for record in records:
    source, destination = Path(record['old_path']), Path(record['new_path'])
    staging = MODELS / (destination.name + '.migration')
    assert not staging.exists() and not staging.is_symlink()
    assert source.stat().st_dev == MODELS.stat().st_dev
    os.link(source, staging)
    assert staging.stat().st_size == record['size'] and checksum(staging) == record['sha256']
    os.replace(staging, destination)
    assert not destination.is_symlink() and destination.resolve() == destination
    assert destination.stat().st_mtime_ns == record['mtime_ns']
    assert checksum(destination) == record['sha256']
    print('VERIFIED STANDALONE', destination, record['size'], record['sha256'], flush=True)
# Require every local registered model/projector to exist, without an Ollama link.
import re
policy = (APP / 'src/main/models/llama-runtime-policy.ts').read_text()
for name in re.findall(r"(?:modelPath|mmprojPath): '([^']+)'", policy):
    path = Path(name)
    assert path.is_file() and not path.resolve().is_relative_to(DATA), path
    with path.open('rb') as handle:
        assert handle.read(4) == b'GGUF', path
for path in MODELS.iterdir():
    assert not (path.is_symlink() and path.resolve().is_relative_to(DATA)), path
# The project audits must show no active source/runtime Ollama dependency.
for root in [APP / 'src', APP / 'run-local-ai-desktop.sh', APP / 'run-local-ai-desktop-llama-cpp-mtp.sh',
             Path('/media/yaroslav/DATA/Мой переводчик/core'), Path('/media/yaroslav/DATA/Мой переводчик/main.py'),
             Path('/media/yaroslav/DATA/Мой переводчик/app_config.json')]:
    files = [root] if root.is_file() else root.rglob('*')
    for path in files:
        if path.is_file() and path.suffix in ['.ts', '.tsx', '.py', '.json', '.sh']:
            assert not re.search(r'ollama|(?:localhost|127\.0\.0\.1):11434', path.read_text(), re.I), path
subprocess.run(['systemctl', 'disable', '--now', 'ollama.service'], check=True)
assert not open_references(DATA), 'Ollama data still in use after stopping the service.'
removed = []
for path in [DATA, Path('/usr/local/lib/ollama'), Path('/usr/local/bin/ollama'),
             Path('/etc/systemd/system/ollama.service.d'), Path('/etc/systemd/system/ollama.service')]:
    if not path.exists():
        continue
    assert not path.is_symlink() and path.resolve() == path, path
    removed.append(dict(path=str(path), bytes=int(subprocess.check_output(['du', '-sb', str(path)]).split()[0])))
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'reset-failed', 'ollama.service'], check=False, stderr=subprocess.DEVNULL)
for record in records:
    destination = Path(record['new_path'])
    assert destination.exists() and not destination.is_symlink() and checksum(destination) == record['sha256']
    # Retain stable size/mtime identity and give the migrated local model to its owner.
    owner = MODELS.stat()
    os.chown(destination, owner.st_uid, owner.st_gid)
RECORD.parent.mkdir(parents=True, exist_ok=True)
RECORD.write_text(json.dumps(dict(files=records, removed=removed, all_verified=True), indent=2) + '\n')
owner = APP.stat()
os.chown(RECORD, owner.st_uid, owner.st_gid)
print('MIGRATION AND CLEANUP VERIFIED', RECORD, flush=True)
print('User CLI identity/history and unrelated /usr/share/ollama user files were preserved.', flush=True)
