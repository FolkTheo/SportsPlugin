// Builds dist/courtside-<version>.zip for uploading to the Chrome Web Store.
// Usage: npm run package   (needs the `zip` command)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}manifest.json`, 'utf8'));
const out = `dist/courtside-${version}.zip`;
mkdirSync(`${root}dist`, { recursive: true });
rmSync(`${root}${out}`, { force: true });
execFileSync('zip', ['-rq', out, 'manifest.json', 'src', 'icons'], { cwd: root, stdio: 'inherit' });
console.log(`wrote ${out}`);
