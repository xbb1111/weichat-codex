import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './harness.ts';

test('package exposes background scheduled task scripts', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.equal(pkg.name, 'weichat-codex');
  assert.equal(pkg.scripts['start:background-install'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-scheduled-task.ps1');
  assert.equal(pkg.scripts['start:background-remove'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall-scheduled-task.ps1');
  assert.equal(pkg.scripts.status, 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/status.ps1');
});

test('scheduled task scripts target the weichat-codex task name', () => {
  const install = readFileSync('scripts/install-scheduled-task.ps1', 'utf8');
  const uninstall = readFileSync('scripts/uninstall-scheduled-task.ps1', 'utf8');
  const status = readFileSync('scripts/status.ps1', 'utf8');

  assert.match(install, /weichat-codex/);
  assert.match(install, /Register-ScheduledTask/);
  assert.match(uninstall, /Unregister-ScheduledTask/);
  assert.match(status, /Get-ScheduledTask/);
});
