import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient } from '../server/model.js';
import { defaults } from '../server/config.js';

test('minimal probe disables provider default thinking within its 64-token budget', async () => {
  let calls = 0;
  const model = new ModelClient(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 64);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { total_tokens: 20 } };
  }, { MODEL_API_KEY: 'fixture-key' });
  let tokens: number | null = null;
  await model.probe({ ...defaults, model: 'deepseek-flash' }, new AbortController().signal, value => { tokens = value; });
  assert.equal(calls, 1);
  assert.equal(tokens, 20);
});
