'use strict';

const assert = require('assert');
const { parseCodexDocuments, parseUploads } = require('./importer-core');

function account(email, suffix) {
  return {
    email,
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    account_id: `account-${suffix}`,
  };
}

(async () => {
  const jsonl = [account('one@example.com', '1'), account('two@example.com', '2')]
    .map(JSON.stringify).join('\n');
  const jsonArray = JSON.stringify([account('three@example.com', '3'), account('four@example.com', '4')]);
  const wrapper = JSON.stringify({ accounts: [
    { platform: 'codex', credentials: account('five@example.com', '5') },
    { platform: 'openai', credentials: account('six@example.com', '6') },
  ] });

  assert.strictEqual(parseCodexDocuments(jsonl).length, 2, 'JSONL must return every account');
  assert.strictEqual(parseCodexDocuments(jsonArray).length, 2, 'JSON array must return every account');
  assert.strictEqual(parseCodexDocuments(wrapper).length, 2, 'accounts[] must return every account');

  const rows = await parseUploads([{ name: 'bulk.json', text: jsonl }]);
  assert.deepStrictEqual(rows.map((row) => row.source.email), ['one@example.com', 'two@example.com']);
  console.log('OK: multi-account JSON/JSONL import tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
