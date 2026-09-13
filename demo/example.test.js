import assert from 'node:assert/strict';
import test from 'node:test';
import { greet } from './example.js';

test('greets the supplied name', () => {
  assert.equal(greet('OMP'), 'Hello, OMP!');
});
