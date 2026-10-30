const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('offline analyzer parses logs, filters events, and redacts sensitive values', () => {
  const source = fs.readFileSync(path.join(__dirname, '../site/app.js'), 'utf8');
  const setup = source.slice(0, source.indexOf("$('importBtn').addEventListener"));
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
  context.rows = normalized.rows;
  vm.runInContext("state.sessions = [{id: 1, name: 'sample', rows}]; state.current = 1", context);
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
