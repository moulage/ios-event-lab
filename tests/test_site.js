const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('offline analyzer parses logs, filters events, and redacts sensitive values', () => {
  const source = fs.readFileSync(path.join(__dirname, '../site/app.js'), 'utf8');
  const setup = source.slice(0, source.indexOf("$('modeLive').addEventListener"));
  const elements = new Map();
  const context = vm.createContext({
    document: {getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, {value: 'events'});
      return elements.get(id);
    }},
    Date, Map, Set,
  });
  vm.runInContext(setup, context);
  const parsed = vm.runInContext("parseEvent('sensor statitic -- event: enter_page_sing, beat_guide_status: 1, song_name: 青花瓷')", context);
  assert.equal(parsed.event, 'enter_page_sing');
  assert.equal(parsed.properties.beat_guide_status, '1');
  assert.equal(parsed.properties.song_name, '青花瓷');
  const normalized = vm.runInContext("normalizeRows('2026-10-29 11:51:46 sensor statitic -- event: enter_page_sing, beat_guide_status: 1\\nother log', 'sample.log')", context);
  assert.equal(normalized.rows.length, 2);
  assert.equal(normalized.rows[0].occurred_at, '2026-10-29T11:51:46');
  assert.equal(normalized.rows[1].event, '');
  const jsonl = vm.runInContext("normalizeRows('{\"event\":\"click\",\"properties\":{\"op\":\"1\"},\"line\":\"event: click\"}', 'sample.jsonl')", context);
  assert.equal(jsonl.rows[0].event, 'click');
  assert.equal(jsonl.rows[0].properties.op, '1');
  context.rows = normalized.rows;
  vm.runInContext("state.mode = 'offline'; state.sessions = [{id: 1, name: 'sample', rows}]; state.current = 1", context);
  elements.get('eventInput')?.value || elements.set('eventInput', {value: ''});
  elements.set('searchInput', {value: ''});
  elements.set('kindSelect', {value: 'events'});
  assert.equal(vm.runInContext('filteredRows().length', context), 1);
  elements.set('eventInput', {value: 'enter_page_sing/finish_sing'});
  assert.equal(vm.runInContext('filteredRows().length', context), 1);
  elements.set('eventInput', {value: 'finish_sing'});
  assert.equal(vm.runInContext('filteredRows().length', context), 0);
  assert.equal(vm.runInContext("redact('token: abc userid: 123')", context), 'token: [REDACTED] userid: [REDACTED]');
});

test('online bridge sends the code in a header and queries server-side event filters', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../site/app.js'), 'utf8');
  const setup = source.slice(0, source.indexOf("$('modeLive').addEventListener"));
  const values = new Map([
    ['eventInput', 'open/close'], ['searchInput', 'keyword'], ['kindSelect', 'events'],
  ]);
  const requests = [];
  const context = vm.createContext({
    document: {getElementById: (id) => ({value: values.get(id) || ''})},
    URLSearchParams, Date, Map, Set,
    fetch: async (url, options) => {
      requests.push({url, options});
      return {ok: true, json: async () => url.includes('/analysis?')
        ? {summary: {by_event: [['open', 1]], trend: []}}
        : {rows: [{id: 3, event: 'open', properties: {}, line: '[REDACTED]', occurred_at: '2026-10-30T10:00:00'}], total: 1}};
    },
  });
  vm.runInContext(setup, context);
  vm.runInContext("state.token = 'secret-code'; state.sessions = [{id: 2, rows: [], event_count: 1}]; state.current = 2; render = () => {}", context);
  await vm.runInContext('refreshLiveLogs()', context);
  assert.match(requests[0].url, /event=open%2Fclose/);
  assert.match(requests[0].url, /search=keyword/);
  assert.ok(!requests[0].url.includes('secret-code'));
  assert.equal(requests[0].options.headers['X-Bridge-Token'], 'secret-code');
  assert.equal(requests[0].options.targetAddressSpace, 'loopback');
  assert.equal(vm.runInContext('state.sessions[0].rows[0].event', context), 'open');
  assert.equal(vm.runInContext('filteredRows().length', context), 1);
});
