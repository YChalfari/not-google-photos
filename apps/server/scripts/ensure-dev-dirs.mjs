// Creates the default development library folder. The server never creates the library folder
// itself, so a missing external drive can't silently turn into a folder on the internal disk.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.LIBRARY_DIR) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  mkdirSync(path.join(repoRoot, 'data', 'library'), { recursive: true });
}
