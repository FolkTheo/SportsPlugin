import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('manifest fits Chrome Web Store limits', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name.length <= 75, 'name ≤ 75 chars');
  assert.ok(manifest.short_name.length <= 12, 'short_name ≤ 12 chars');
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} chars (max 132)`);
});
