import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// DATA is mandatory for this application. Keeping runtime files in the project
// is intentional while the DATA mount does not allow creating a sibling folder.
const root = '/media/yaroslav/DATA/local-ai-desktop';
const dataRoot = join(root, 'runtime');

export const paths = {
  root,
  dataRoot,
  userData: join(dataRoot, 'app-data'),
  cache: join(dataRoot, 'cache'),
  logs: join(dataRoot, 'logs'),
  attachments: join(dataRoot, 'attachments'),
  database: join(dataRoot, 'sqlite', 'local-ai-desktop.db'),
  models: '/media/yaroslav/DATA/AI/models',
};

export function ensureAppDirectories(): void {
  [paths.dataRoot, paths.userData, paths.cache, paths.logs, paths.attachments, join(paths.dataRoot, 'sqlite')]
    .forEach((directory) => mkdirSync(directory, { recursive: true }));
}
