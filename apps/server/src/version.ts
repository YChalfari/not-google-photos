import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_ROOT } from './env';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = process.env.NGP_VERSION ?? readVersion();
