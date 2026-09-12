import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths';

export function log(event: string, details?: unknown): void {
  const payload = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  appendFileSync(join(paths.logs, 'application.log'), `${new Date().toISOString()} ${event}${payload}\n`);
}
