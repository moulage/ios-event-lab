const $ = (id) => document.getElementById(id);
const state = {sessions: [], current: 0, selected: 0, order: 'desc', visible: []};
const marker = 'sensor statitic -- event:';
const fieldPattern = /,\s+([A-Za-z_$][\w$.-]*):\s*/g;
const sensitiveName = /token|secret|password|passwd|authorization|userid|user_id|idfa|idfv|smdeviceid|device_id|cid|uuid/i;
const sensitiveText = /((?:["']?\b(?:token|access_token|secret|password|passwd|authorization|userid|curuserid|user_id|idfa|idfv|smdeviceid|device_id|cid|uuid)\b["']?)\s*[:=]\s*["']?)[^\s,;&"'}]+/gi;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const redact = (value) => String(value ?? '').replace(sensitiveText, '$1[REDACTED]');
const terms = (value) => [...new Set(String(value).split('/').map((term) => term.trim()).filter(Boolean))].slice(0, 50);
const current = () => state.sessions.find((session) => session.id === state.current);

function notice(text, error = false) {
  const box = $('notice');
  box.textContent = text;
  box.classList.toggle('error', error);
  box.hidden = !text;
}

function parseEvent(line) {
  const at = line.indexOf(marker);
  if (at < 0) return null;
  const payload = line.slice(at + marker.length).trim();
  const matches = [...payload.matchAll(fieldPattern)];
  const event = payload.slice(0, matches[0]?.index ?? payload.length).trim().replace(/,$/, '');
  const properties = {};
  let warning = event ? '' : '事件名为空';
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const name = match[1];
    if (Object.hasOwn(properties, name)) warning = '存在重复属性名；请核对原文';
    properties[name] = payload.slice(match.index + match[0].length, matches[index + 1]?.index ?? payload.length).trim();
  }
  if (/[{}]/.test(payload)) warning = '属性包含嵌套内容；请核对原文';
  return {event, properties, warning};
}

function normalizeRows(text, filename) {
  const stamp = new Date().toISOString();
  if (filename.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : data.events || data.logs || data.rows;
    if (!Array.isArray(rows)) throw new Error('JSON 文件没有 events、logs 或 rows 数组');
    return {name: data.session?.name || filename, rows: rows.slice(0, 100000).map((row, index) => ({
      id: index + 1, event: String(row.event || ''), properties: row.properties && typeof row.properties === 'object' ? row.properties : {},
      line: String(row.line || ''), warning: String(row.warning || ''), occurred_at: row.occurred_at || stamp,
    }))};
  }
  const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 100000).map((line, index) => {
    const parsed = parseEvent(line);
    const match = line.match(/(?:^|\s)(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?)/);
    return {id: index + 1, event: parsed?.event || '', properties: parsed?.properties || {}, warning: parsed?.warning || '',
      line, occurred_at: match ? match[1].replace(' ', 'T') : stamp};
  });
  return {name: filename, rows};
}

function renderSessions() {
  $('sessionCount').textContent = state.sessions.length;
  $('clearLogs').disabled = !state.sessions.length;
  const list = $('sessionList');
  list.innerHTML = state.sessions.length ? state.sessions.map((session) =>
    `<button class="session-item ${session.id === state.current ? 'active' : ''}" data-id="${session.id}" type="button"><strong>${escapeHtml(session.name)}</strong><small>导入 · ${session.rows.filter((row) => row.event).length} 事件</small></button>`
  ).join('') : '<div class="session-empty">暂无会话</div>';
  list.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    state.current = Number(button.dataset.id);
    state.selected = 0;
    render();
  }));
}

function matchingProperties(properties) {
  const names = terms($('fieldInput').value).map((name) => name.toLocaleLowerCase());
  const value = $('valueInput').value.trim().toLocaleLowerCase();
  const entries = Object.entries(properties);
  const ordered = names.length ? names.flatMap((name) => entries.filter(([key]) => key.toLocaleLowerCase().includes(name))) : entries;
  const seen = new Set();
  return ordered.filter(([key, content]) => {
    if (seen.has(key) || value && !String(content).toLocaleLowerCase().includes(value)) return false;
    seen.add(key);
    return true;
  });
}

function propertyList(entries) {
  return `<dl class="properties">${entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(sensitiveName.test(key) ? '[REDACTED]' : redact(value))}</dd>`).join('')}</dl>`;
}

function renderDetail() {
  const row = state.visible.find((item) => item.id === state.selected);
  $('detailTime').textContent = row ? String(row.occurred_at).slice(11, 19) : '';
  const target = $('detailBody');
  if (!row) { target.className = 'detail-body empty'; target.textContent = '选择一条记录查看属性与原文。'; return; }
  target.className = 'detail-body';
  const entries = Object.entries(row.properties);
  const filtered = Boolean($('fieldInput').value.trim() || $('valueInput').value.trim());
  const matches = filtered ? matchingProperties(row.properties) : [];
  const matched = new Set(matches.map(([key]) => key));
  const other = filtered ? entries.filter(([key]) => !matched.has(key)) : entries;
  const selectedSection = filtered && row.event ? `<section class="selected-properties"><h3>匹配属性 · ${matches.length}</h3>${matches.length ? propertyList(matches) : '<p class="no-property-match">当前事件没有匹配的属性</p>'}</section>` : '';
  const otherSection = filtered && row.event
    ? other.length ? `<details class="other-properties" open><summary>其他属性 · ${other.length}</summary>${propertyList(other)}</details>` : ''
    : other.length ? `<h3 class="remaining-title">全部属性</h3>${propertyList(other)}` : '';
  target.innerHTML = `<h3>${escapeHtml(row.event || '运行日志')}</h3>${row.warning ? `<div class="notice error">${escapeHtml(row.warning)}</div>` : ''}${selectedSection}${otherSection}<h3 class="remaining-title">原始日志（已遮罩）</h3><pre class="raw-block">${escapeHtml(redact(row.line))}</pre>`;
}

function filteredRows() {
  const session = current();
  if (!session) return [];
  const events = terms($('eventInput').value);
  const keyword = $('searchInput').value.trim().toLocaleLowerCase();
  const kind = $('kindSelect').value;
  return session.rows.filter((row) => {
    if (events.length && !events.includes(row.event)) return false;
    if (kind === 'events' && !row.event || kind === 'raw' && row.event) return false;
    return !keyword || row.line.toLocaleLowerCase().includes(keyword);
  }).sort((left, right) => (String(left.occurred_at).localeCompare(String(right.occurred_at)) || left.id - right.id) * (state.order === 'asc' ? 1 : -1));
}

function renderRows() {
  const rows = filteredRows();
  state.visible = rows.slice(0, 500);
  $('resultCount').textContent = `${rows.length} 条${rows.length > 500 ? ` · ${state.order === 'asc' ? '最早' : '最新'} 500 条` : ''}`;
  if (!state.visible.some((row) => row.id === state.selected)) state.selected = state.visible[0]?.id || 0;
  $('eventEmpty').hidden = state.visible.length > 0;
  $('eventRows').innerHTML = state.visible.map((row) => {
    const preview = row.event ? Object.entries(row.properties).slice(0, 3).map(([key, value]) => `${key}: ${sensitiveName.test(key) ? '[REDACTED]' : redact(value)}`).join(' · ') : redact(row.line);
    return `<tr tabindex="0" data-id="${row.id}" class="${row.id === state.selected ? 'selected' : ''}"><td class="cell-time">${escapeHtml(String(row.occurred_at).slice(11, 19))}</td><td><span class="event-name">${escapeHtml(row.event || '运行日志')}</span><span class="event-preview">${escapeHtml(preview)}</span></td><td><span class="tag ${row.warning ? 'warn' : row.event ? '' : 'raw'}">${row.warning ? '需核对' : row.event ? '埋点' : '日志'}</span></td></tr>`;
  }).join('');
  $('eventRows').querySelectorAll('tr').forEach((element) => {
    const select = () => {
      state.selected = Number(element.dataset.id);
      $('eventRows').querySelectorAll('tr').forEach((item) => item.classList.toggle('selected', item === element));
      renderDetail();
    };
    element.addEventListener('click', select);
    element.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  });
  renderDetail();
}

function renderBars(id, entries) {
  const target = $(id);
  if (!entries.length) { target.className = 'bar-list empty'; target.textContent = '暂无数据'; return; }
  target.className = 'bar-list';
  const max = Math.max(...entries.map(([, count]) => count));
  target.innerHTML = entries.slice(0, 30).map(([label, count]) => `<div class="bar-row"><span class="label" title="${escapeHtml(label)}">${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${count / max * 100}%"></div></div><b>${count}</b></div>`).join('');
}

function render() {
  renderSessions();
  const session = current();
  $('currentSession').textContent = session?.name || '尚未选择';
  $('logCount').textContent = (session?.rows.length || 0).toLocaleString('zh-CN');
  const events = session?.rows.filter((row) => row.event) || [];
  $('eventCount').textContent = events.length.toLocaleString('zh-CN');
  const byName = new Map();
  const byMinute = new Map();
  events.forEach((row) => {
    byName.set(row.event, (byName.get(row.event) || 0) + 1);
    const minute = String(row.occurred_at).slice(0, 16);
    byMinute.set(minute, (byMinute.get(minute) || 0) + 1);
  });
  $('typeCount').textContent = byName.size;
  $('eventOptions').replaceChildren(...[...byName.keys()].map((name) => new Option(name, name)));
  renderBars('distribution', [...byName].sort((a, b) => b[1] - a[1]));
  renderBars('trend', [...byMinute].sort((a, b) => a[0].localeCompare(b[0])));
  renderRows();
}

function initResize(handleId, container, variable, key, direction, minimum, maxWidth) {
  const handle = $(handleId);
  const apply = (width, save = false) => {
    const value = Math.max(minimum, Math.min(maxWidth(container.clientWidth), width));
    container.style.setProperty(variable, `${value}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(value)));
    if (save) localStorage.setItem(key, String(Math.round(value)));
  };
  const saved = Number.parseFloat(localStorage.getItem(key));
  if (saved > 0) apply(saved);
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX;
    const bounds = container.getBoundingClientRect();
    const edge = handle.getBoundingClientRect();
    const initial = direction === 1 ? edge.left - bounds.left : bounds.right - edge.right;
    document.body.classList.add('resizing');
    handle.classList.add('dragging');
    const move = (next) => apply(initial + (next.clientX - start) * direction);
    const stop = (next) => {
      move(next);
      localStorage.setItem(key, String(Math.round(Number.parseFloat(container.style.getPropertyValue(variable)))));
      document.body.classList.remove('resizing');
      handle.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const bounds = container.getBoundingClientRect();
    const edge = handle.getBoundingClientRect();
    const currentWidth = Number.parseFloat(container.style.getPropertyValue(variable)) || (direction === 1 ? edge.left - bounds.left : bounds.right - edge.right);
    apply(currentWidth + (event.key === 'ArrowRight' ? 20 : -20) * direction, true);
  });
}

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (event) => {
  for (const file of event.target.files) {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB`);
      const parsed = normalizeRows(await file.text(), file.name);
      const session = {id: Date.now() + Math.random(), name: $('sessionName').value.trim() || parsed.name, rows: parsed.rows};
      state.sessions.unshift(session);
      state.current = session.id;
      state.selected = 0;
      notice(`已导入 ${file.name}，${session.rows.length} 行。`);
    } catch (error) { notice(error.message, true); }
  }
  event.target.value = '';
  render();
});
$('clearLogs').addEventListener('click', () => {
  if (!window.confirm('清空当前浏览器中的全部已导入日志？')) return;
  state.sessions = [];
  state.current = 0;
  state.selected = 0;
  render();
  notice('已清空当前浏览器中的日志。');
});
for (const id of ['eventInput', 'searchInput']) $(id).addEventListener('input', renderRows);
$('kindSelect').addEventListener('change', renderRows);
for (const id of ['fieldInput', 'valueInput']) $(id).addEventListener('input', renderDetail);
$('resetFilters').addEventListener('click', () => {
  for (const id of ['eventInput', 'searchInput', 'fieldInput', 'valueInput']) $(id).value = '';
  $('kindSelect').value = 'events';
  renderRows();
});
for (const [id, order] of [['sortNewest', 'desc'], ['sortOldest', 'asc']]) $(id).addEventListener('click', () => {
  state.order = order;
  state.selected = 0;
  for (const [buttonId, direction] of [['sortNewest', 'desc'], ['sortOldest', 'asc']]) {
    $(buttonId).classList.toggle('active', direction === order);
    $(buttonId).setAttribute('aria-pressed', String(direction === order));
  }
  $('eventRows').closest('.event-table-wrap').scrollTop = 0;
  renderRows();
});
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
  $('eventsView').hidden = button.dataset.tab !== 'events';
  $('analysisView').hidden = button.dataset.tab !== 'analysis';
}));
initResize('sidebarResize', document.querySelector('.workspace'), '--sidebar-width', 'iosEventSiteSidebar', 1, 160, (width) => Math.min(420, width - 580));
initResize('detailResize', document.querySelector('.event-layout'), '--detail-width', 'iosEventSiteDetail', -1, 265, (width) => Math.min(720, width - 320));
render();
