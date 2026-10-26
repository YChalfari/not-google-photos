/**
 * Prints the OpenAPI document: `pnpm openapi > openapi.json`, or `pnpm openapi --out file.json`.
 * The running server serves the same document at `/api/openapi.json`.
 */
import { writeFile } from 'node:fs/promises';
import { buildOpenApiDocument } from '@ngp/shared/openapi';
import { handlers } from '../routes';
import { VERSION } from '../version';

const document = buildOpenApiDocument({ version: VERSION, implemented: new Set(Object.keys(handlers)) });
const json = `${JSON.stringify(document, null, 2)}\n`;
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (out) {
  await writeFile(out, json);
  console.error(`Wrote ${out}`);
} else {
  process.stdout.write(json);
}
