// package.json, server.json and the code must agree, or the npm publish or the
// MCP Registry listing fails at release time.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from '../dist/config.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));

test('versions and names line up', () => {
  const pkg = read('package.json');
  const server = read('server.json');
  const npm = server.packages.find((p) => p.registryType === 'npm');
  assert.equal(VERSION, pkg.version, 'src/config.ts VERSION');
  assert.equal(server.version, pkg.version, 'server.json version');
  assert.equal(npm.version, pkg.version, 'server.json package version');
  assert.equal(npm.identifier, pkg.name, 'server.json identifier');
  assert.equal(server.name, pkg.mcpName, 'server.json name vs package.json mcpName');
  assert.ok(server.description.length <= 100, `server.json description is ${server.description.length} characters (registry limit 100)`);
});
