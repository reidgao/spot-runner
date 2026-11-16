/**
 * Tests for common.mjs. Run them with `node --test` (Node 20 or later).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isImageOf, stamp } from './common.mjs';

// Bakes name an image <prefix><stamp>, the default prefix being
// ci-runner-<repository>-. This one is unisong-website's, from the Jakarta account.
const website = 'ci-runner-unisong-website-20261116-130934';

test('a repository leaves alone the images of one whose name it begins', () => {
  assert.equal(isImageOf('ci-runner-unisong-', website), false);
  assert.equal(isImageOf('ci-runner-tways-', 'ci-runner-tways-website-20261116-130934'), false);
});

test('a repository still finds its own images', () => {
  assert.equal(isImageOf('ci-runner-unisong-website-', website), true);
  assert.equal(isImageOf('ci-runner-unisong-', 'ci-runner-unisong-20261117-010203'), true);
});

test('an image-prefix override is matched the same way', () => {
  const dashboard = 'ci-runner-unisong-dashboard-20261117-010203';
  assert.equal(isImageOf('ci-runner-unisong-dashboard-', dashboard), true);
  assert.equal(isImageOf('ci-runner-unisong-', dashboard), false);
});

test('the name a bake gives its new image matches', () => {
  const prefix = 'ci-runner-unisong-';
  assert.equal(isImageOf(prefix, `${prefix}${stamp()}`), true);
});

test('only a whole timestamp right after the prefix counts', () => {
  for (const name of [
    'ci-runner-unisong-20261117-010203-copy',
    'ci-runner-unisong-20261117',
    'ci-runner-unisong-2026111-0102030',
    'ci-runner-unisong-',
    'old-ci-runner-unisong-20261117-010203',
  ]) {
    assert.equal(isImageOf('ci-runner-unisong-', name), false, name);
  }
});
