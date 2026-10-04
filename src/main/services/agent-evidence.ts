import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The Rust runtime keeps one durable evidence lineage per conversation. */
export const agentEvidenceDir = (userData: string, conversationId: string): string =>
  join(userData, 'agent-evidence', createHash('sha256').update(conversationId).digest('hex'));

/** Drops the model-side state of a conversation (transcript journal and
 * observations). The next run rebuilds its context from the saved messages. */
export async function discardAgentEvidence(userData: string, conversationId: string): Promise<void> {
  await rm(agentEvidenceDir(userData, conversationId), { recursive: true, force: true });
}
