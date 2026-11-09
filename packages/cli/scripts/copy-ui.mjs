// Copy the built browser UI into the CLI's dist folder so it ships in the npm package.
import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'ui', 'dist');
const dest = join(here, '..', 'dist', 'ui');

try {
  await stat(src);
} catch {
  console.warn('UI not built (packages/ui/dist missing). Run `npm run build` from the repo root.');
  process.exit(0);
}
await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });
console.log('Copied UI into dist/ui');
