const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('fuzzy property filters affect details without changing event rows', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  const setup = source.slice(0, source.indexOf("document.querySelectorAll('.tab')"));
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', textContent: '', innerHTML: '', hidden: false, className: '', scrollTop: 80,
        querySelectorAll: () => [],
      });
    }
    return elements.get(id);
  };
  getElementById('fieldInput').value = 'beat_guide';
  const context = vm.createContext({
    document: {getElementById},
    localStorage: {getItem: () => null},
    URLSearchParams,
  });
  vm.runInContext(setup, context);
  const rows = [
    {id: 1, event: 'enter_page_sing', properties: {beat_guide_status: '1', song_name: '青花瓷', op: '1'},
      occurred_at: '2026-10-29T11:51:46', line: 'event: enter_page_sing', warning: ''},
    {id: 2, event: 'finish_sing', properties: {work_level: 'D'},
      occurred_at: '2026-10-29T15:49:49', line: 'event: finish_sing', warning: ''},
  ];
  context.rows = rows;
  vm.runInContext('renderRows(rows, 2)', context);
  const detail = getElementById('detailBody');
  assert.equal(vm.runInContext('state.selectedId', context), 1);
  assert.equal(detail.scrollTop, 0);
  assert.match(detail.innerHTML, /匹配属性 · 1/);
  assert.match(detail.innerHTML, /<details class="other-properties" open>/);
  assert.ok(detail.innerHTML.indexOf('beat_guide_status') < detail.innerHTML.indexOf('其他属性'));
  assert.equal(getElementById('resultCount').textContent, '2 条');
  const eventList = getElementById('eventRows').innerHTML;
  getElementById('fieldInput').value = 'beat_guide/song';
  vm.runInContext('renderDetail(rows[0], true)', context);
  assert.match(detail.innerHTML, /匹配属性 · 2/);
  assert.ok(detail.innerHTML.indexOf('beat_guide_status') < detail.innerHTML.indexOf('song_name'));
  getElementById('fieldInput').value = '';
  getElementById('valueInput').value = '青花';
  vm.runInContext('renderDetail(rows[0], true)', context);
  assert.match(detail.innerHTML, /匹配属性 · 1/);
  assert.ok(detail.innerHTML.indexOf('song_name') < detail.innerHTML.indexOf('其他属性'));
  assert.equal(getElementById('eventRows').innerHTML, eventList);
  assert.equal(getElementById('resultCount').textContent, '2 条');
  const requests = [];
  context.fetch = async (url) => {
    requests.push(url);
    return {ok: true, json: async () => ({rows, total: 2})};
  };
  vm.runInContext('state.sessionId = 6', context);
  await vm.runInContext('refreshLogs()', context);
  assert.ok(!requests[0].includes('field='));
  assert.ok(!requests[0].includes('value='));
  assert.ok(requests[0].includes('order=desc'));
  assert.ok(!requests[0].includes('from='));
  vm.runInContext("state.order = 'asc'", context);
  await vm.runInContext('refreshLogs()', context);
  assert.ok(requests[1].includes('order=asc'));
  vm.runInContext('selectRow(2)', context);
  assert.match(detail.innerHTML, /当前事件没有匹配的属性/);
});
