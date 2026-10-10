import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEvidenceDir, archiveAgentEvidence, discardAgentEvidence } from './agent-evidence';
async function run() {
  const root = await mkdtemp(join(tmpdir(), 'attempt-evidence-'));
  try {
    const active = agentEvidenceDir(root, 'chat');
    await mkdir(active, { recursive: true });
    await writeFile(join(active, 'events.jsonl'), 'old journal');
    await writeFile(join(active, 'observation.json'), 'old observation');
    await archiveAgentEvidence(root, 'chat');
    await assert.rejects(readFile(join(active, 'events.jsonl')), /ENOENT/);
    const archiveRoot = join(root, 'agent-evidence-archive');
    const chatArchive = join(archiveRoot, (await readdir(archiveRoot))[0]);
    const attempt = join(chatArchive, (await readdir(chatArchive))[0]);
    assert.equal(await readFile(join(attempt, 'events.jsonl'), 'utf8'), 'old journal');
    assert.equal(await readFile(join(attempt, 'observation.json'), 'utf8'), 'old observation');
    await archiveAgentEvidence(root, 'chat'); // No active evidence is a valid fresh/Chat regeneration.
    assert.equal((await readdir(chatArchive)).length, 1);
    await mkdir(active, { recursive: true }); await writeFile(join(active, 'events.jsonl'), 'new journal');
    assert.equal(await readFile(join(attempt, 'events.jsonl'), 'utf8'), 'old journal');
    await discardAgentEvidence(root, 'chat');
    assert.equal(await readFile(join(attempt, 'events.jsonl'), 'utf8'), 'old journal', 'editing/resetting the active lineage preserves archived attempts');
    await discardAgentEvidence(root, 'chat', true);
    await assert.rejects(readdir(chatArchive), /ENOENT/, 'explicit deletion cleans archived private data too');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
