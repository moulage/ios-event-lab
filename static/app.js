const state = { sessionId: Number(localStorage.getItem('iosEventSession') || 0), tab: 'events', rows: [], selectedId: 0, busy: false, order: 'desc' };
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function message(text, isError = false) {
  const box = $('notice');
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.hidden = !text;
}
function when(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(11, 23) : date.toLocaleTimeString('zh-CN', { hour12: false });
}
const filterNames = (value) => [...new Set(value.split('/').map((part) => part.trim()).filter(Boolean))];
function matchingProperties(properties, fieldQuery, valueQuery) {
  const terms = filterNames(fieldQuery).map((term) => term.toLocaleLowerCase());
  const value = valueQuery.trim().toLocaleLowerCase();
  const entries = Object.entries(properties);
  const ordered = terms.length
    ? terms.flatMap((term) => entries.filter(([name]) => name.toLocaleLowerCase().includes(term)))
    : entries;
  const seen = new Set();
  return ordered.filter(([name, content]) => {
    if (seen.has(name) || (value && !String(content).toLocaleLowerCase().includes(value))) return false;
    seen.add(name);
    return true;
  });
}
function restoreEventFilter() {
  const previous = $('searchInput').value.trim();
  if (!$('eventInput').value && previous.includes('/') &&
      filterNames(previous).every((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name))) {
    $('eventInput').value = previous;
    $('searchInput').value = '';
  }
}

async function refreshDevices() {
  const select = $('deviceSelect');
  try {
    const data = await api('/api/devices');
    const previous = select.value || localStorage.getItem('iosEventDevice') || '';
    select.replaceChildren();
    if (!data.devices.length) select.add(new Option('未发现 USB 真机', ''));
    for (const device of data.devices) select.add(new Option(`${device.name} · ${device.id.slice(-8)}`, device.id));
    if (data.devices.some((device) => device.id === previous)) select.value = previous;
    if (data.error) message(data.error, true);
    const badge = $('connectionBadge');
    badge.textContent = data.devices.length ? `${data.devices.length} 台设备` : '未连接';
    badge.className = `badge ${data.devices.length ? 'live' : 'neutral'}`;
  } catch (error) { message(error.message, true); }
}

function renderSessions(sessions) {
  $('sessionCount').textContent = sessions.length;
  const container = $('sessionList');
  if (!sessions.length) { container.innerHTML = '<div class="session-empty">暂无会话</div>'; return; }
  container.innerHTML = sessions.map((session) => `<button class="session-item ${session.id === state.sessionId ? 'active' : ''}" data-id="${session.id}" type="button"><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.created_at.slice(0,16).replace('T',' '))} · ${session.source === 'usb' ? 'USB' : '导入'} · ${session.event_count} 事件</small></button>`).join('');
  container.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => selectSession(Number(button.dataset.id))));
}

async function refreshSessions() {
  const data = await api('/api/sessions');
  if (!state.sessionId && data.sessions.length) state.sessionId = data.sessions[0].id;
  if (state.sessionId && !data.sessions.some((item) => item.id === state.sessionId)) state.sessionId = data.sessions[0]?.id || 0;
  renderSessions(data.sessions);
  const current = data.sessions.find((item) => item.id === state.sessionId);
  $('currentSession').textContent = current?.name || '尚未选择';
  $('logCount').textContent = (current?.line_count || 0).toLocaleString('zh-CN');
  $('eventCount').textContent = (current?.event_count || 0).toLocaleString('zh-CN');
  if (current?.error) message(current.error, true);
  else if (current && !['running', 'cleared'].includes(current.status) && current.event_count === 0)
    message('此会话未识别到埋点标记，请确认 debug 包日志输出及采集设备。', true);
  const capture = await api('/api/capture');
  $('startBtn').hidden = capture.running || capture.passive;
  $('stopBtn').hidden = !capture.running || capture.passive;
  $('deviceSelect').disabled = capture.running || capture.passive;
  $('startBtn').disabled = !capture.running && !$('deviceSelect').value;
  $('clearLogs').disabled = capture.running || capture.passive || !data.sessions.length;
  $('bridgePanel').hidden = capture.passive;
  if (capture.running) {
    $('connectionBadge').textContent = capture.passive ? '其他端口采集中' : '正在采集';
    $('connectionBadge').className = 'badge live';
  }
  if (capture.passive && capture.running) message('此页面实时查看原工作台的采集会话；开始和停止采集请使用原页面。');
  return current;
}

function renderRows(rows, total) {
  state.rows = rows;
  $('resultCount').textContent = `${total} 条${total > rows.length ? ` · ${state.order === 'asc' ? '最早' : '最新'} 500 条` : ''}`;
  const body = $('eventRows');
  $('eventEmpty').hidden = rows.length > 0;
  const resetDetailScroll = !rows.some((row) => row.id === state.selectedId);
  if (resetDetailScroll) state.selectedId = rows[0]?.id || 0;
  body.innerHTML = rows.map((row) => {
    const preview = row.event ? Object.entries(row.properties).slice(0, 3).map(([key, value]) => `${key}: ${value}`).join(' · ') : row.line;
    return `<tr data-id="${row.id}" class="${row.id === state.selectedId ? 'selected' : ''}"><td class="cell-time">${escapeHtml(when(row.occurred_at))}</td><td><span class="event-name">${escapeHtml(row.event || '运行日志')}</span><span class="event-preview">${escapeHtml(preview)}</span></td><td><span class="tag ${row.warning ? 'warn' : row.event ? '' : 'raw'}">${row.warning ? '需核对' : row.event ? '埋点' : '日志'}</span></td></tr>`;
  }).join('');
  body.querySelectorAll('tr').forEach((row) => row.addEventListener('click', () => selectRow(Number(row.dataset.id))));
  renderDetail(rows.find((row) => row.id === state.selectedId), resetDetailScroll);
}

function selectRow(id) {
  state.selectedId = id;
  $('eventRows').querySelectorAll('tr').forEach((row) => row.classList.toggle('selected', Number(row.dataset.id) === id));
  renderDetail(state.rows.find((row) => row.id === id), true);
}
function renderDetail(row, resetScroll = false) {
  $('detailTime').textContent = row ? when(row.occurred_at) : '';
  const target = $('detailBody');
  if (resetScroll) target.scrollTop = 0;
  if (!row) { target.className = 'detail-body empty'; target.textContent = '选择一条记录查看属性与原文。'; return; }
  target.className = 'detail-body';
  const entries = Object.entries(row.properties);
  const fieldQuery = $('fieldInput').value;
  const valueQuery = $('valueInput').value;
  const hasFilter = Boolean(fieldQuery.trim() || valueQuery.trim());
  const matches = hasFilter ? matchingProperties(row.properties, fieldQuery, valueQuery) : [];
  const matchedNames = new Set(matches.map(([name]) => name));
  const remaining = hasFilter ? entries.filter(([name]) => !matchedNames.has(name)) : entries;
  const matchedSection = hasFilter && row.event
    ? `<section class="selected-properties"><h3>匹配属性 · ${matches.length}</h3>${matches.length
      ? `<dl class="properties">${matches.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`
      : '<p class="no-property-match">当前事件没有匹配的属性</p>'}</section>` : '';
  const otherSection = hasFilter && row.event
    ? (remaining.length ? `<details class="other-properties" open><summary>其他属性 · ${remaining.length}</summary><dl class="properties">${remaining.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl></details>` : '')
    : (remaining.length ? `<h3 class="remaining-title">全部属性</h3><dl class="properties">${remaining.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>` : '');
  target.innerHTML = `<h3>${escapeHtml(row.event || '运行日志')}</h3>${row.warning ? `<div class="notice error">${escapeHtml(row.warning)}</div>` : ''}${matchedSection}${otherSection}<h3 class="remaining-title">原始日志（已遮罩）</h3><pre class="raw-block">${escapeHtml(row.line)}</pre>`;
}
async function refreshLogs() {
  if (!state.sessionId) { renderRows([], 0); return; }
  const params = new URLSearchParams({session: state.sessionId, kind: $('kindSelect').value,
    search: $('searchInput').value, event: $('eventInput').value, order: state.order});
  const data = await api(`/api/logs?${params}`);
  renderRows(data.rows, data.total);
}

function renderBars(targetId, data) {
  const target = $(targetId);
  if (!data.length) { target.className = 'bar-list empty'; target.textContent = '暂无数据'; return; }
  target.className = 'bar-list';
  const max = Math.max(...data.map((item) => item[1]), 1);
  target.innerHTML = data.slice(0, 20).map(([label, value]) => `<div class="bar-row"><span class="label" title="${escapeHtml(label)}">${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, value / max * 100)}%"></div></div><b>${value}</b></div>`).join('');
}
function renderRules(rules) {
  const pass = rules.filter((rule) => rule.status === 'pass').length;
  $('ruleCount').textContent = `${pass} / ${rules.length}`;
  $('rulesSummary').textContent = `${pass} 通过 · ${rules.filter((rule) => rule.status === 'fail').length} 失败 · ${rules.filter((rule) => rule.status === 'pending').length} 待定 · ${rules.filter((rule) => rule.status === 'unknown').length} 无法判定`;
  const label = {pass:'通过',fail:'失败',pending:'待定',invalid:'规则错误',unknown:'无法判定'};
  $('ruleList').innerHTML = rules.length ? rules.map((rule) => `<div class="rule-item"><span class="rule-status ${rule.status}">${label[rule.status] || rule.status}</span><div><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.detail)}</small></div><button type="button" data-id="${rule.id}" aria-label="删除规则 ${escapeHtml(rule.name)}">删除</button></div>`).join('') : '<div class="empty">还没有规则。添加规则后会对当前会话自动校验。</div>';
  $('ruleList').querySelectorAll('button').forEach((button) => button.addEventListener('click', async () => {
    try { await api(`/api/rules/${button.dataset.id}`, {method:'DELETE'}); await refreshAnalysis(); }
    catch (error) { message(error.message, true); }
  }));
}
async function refreshAnalysis() {
  if (!state.sessionId) {
    renderBars('distribution', []); renderBars('trend', []);
    const data = await api('/api/rules');
    renderRules(data.rules.map((rule) => ({...rule, status:'pending', detail:'选择会话后运行校验'})));
    return;
  }
  const data = await api(`/api/analysis?session=${state.sessionId}`);
  renderBars('distribution', data.summary.by_event);
  renderBars('trend', data.summary.trend.map(([time, count]) => [time.slice(5).replace('T',' '), count]));
  renderRules(data.rules);
  const options = $('eventOptions');
  options.replaceChildren(...data.summary.by_event.map(([name]) => new Option(name, name)));
}
async function selectSession(id) {
  state.sessionId = id;
  state.selectedId = 0;
  localStorage.setItem('iosEventSession', String(id));
  await refreshAll();
}
async function refreshAll() {
  if (state.busy) return;
  state.busy = true;
  try { await refreshSessions(); await refreshAnalysis(); await refreshLogs(); }
  catch (error) { message(error.message, true); }
  finally { state.busy = false; }
}

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  state.tab = button.dataset.tab;
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
  for (const name of ['events', 'rules', 'analysis']) $(`${name}View`).hidden = name !== state.tab;
}));
$('refreshDevices').addEventListener('click', refreshDevices);
api('/api/bridge/code').then((data) => { $('bridgeCode').value = data.code; }).catch((error) => message(error.message, true));
$('copyBridgeCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('bridgeCode').value); message('连接码已复制，请粘贴到网页版。'); }
  catch (error) { message('复制失败，请手动选择连接码。', true); }
});
$('startBtn').addEventListener('click', async () => {
  try {
    message('');
    localStorage.setItem('iosEventDevice', $('deviceSelect').value);
    const data = await api('/api/capture/start', {method:'POST', body:JSON.stringify({udid:$('deviceSelect').value,name:$('sessionName').value})});
    await selectSession(data.session_id);
    message('采集已启动。请在测试真机中操作 debug 包。');
  } catch (error) { message(error.message, true); }
});
$('stopBtn').addEventListener('click', async () => {
  try { await api('/api/capture/stop', {method:'POST', body:'{}'}); await refreshAll(); message('采集已停止。'); }
  catch (error) { message(error.message, true); }
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('文件不能超过 10 MB');
    const data = await api('/api/sessions/import', {method:'POST',body:JSON.stringify({name:$('sessionName').value || file.name,text:await file.text()})});
    await selectSession(data.session_id);
    message(`已导入 ${file.name}`);
  } catch (error) { message(error.message, true); }
  event.target.value = '';
});
let searchTimer;
$('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refreshLogs().catch((e) => message(e.message, true)), 200); });
$('kindSelect').addEventListener('change', () => refreshLogs().catch((e) => message(e.message, true)));
$('eventInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refreshLogs().catch((e) => message(e.message, true)), 200); });
for (const id of ['fieldInput', 'valueInput']) $(id).addEventListener('input', () => renderDetail(state.rows.find((row) => row.id === state.selectedId), true));
$('resetFilters').addEventListener('click', () => {
  for (const id of ['searchInput', 'eventInput', 'fieldInput', 'valueInput']) $(id).value = '';
  $('kindSelect').value = 'events';
  renderDetail(state.rows.find((row) => row.id === state.selectedId), true);
  refreshLogs().catch((e) => message(e.message, true));
});
for (const [id, order] of [['sortNewest', 'desc'], ['sortOldest', 'asc']]) $(id).addEventListener('click', () => {
  state.order = order;
  state.selectedId = 0;
  document.querySelector('.event-table-wrap').scrollTop = 0;
  for (const [buttonId, direction] of [['sortNewest', 'desc'], ['sortOldest', 'asc']]) {
    $(buttonId).classList.toggle('active', direction === order);
    $(buttonId).setAttribute('aria-pressed', String(direction === order));
  }
  refreshLogs().catch((error) => message(error.message, true));
});
$('clearLogs').addEventListener('click', async () => {
  if (!window.confirm('清除 local-test 中所有会话的事件与运行日志？会话和规则保留，此操作不可撤销。')) return;
  try {
    const data = await api('/api/sessions/clear', {method: 'POST', body: JSON.stringify({environment: 'local-test', confirm: 'CLEAR_LOCAL_TEST_LOGS'})});
    state.sessionId = 0;
    state.selectedId = 0;
    localStorage.removeItem('iosEventSession');
    await refreshSessions();
    await refreshAnalysis();
    await refreshLogs();
    message(`已清除 ${data.cleared_logs} 条日志。`);
  } catch (error) { message(error.message, true); }
});

function initResize(handleId, container, variable, storageKey, direction, min, maxWidth) {
  const handle = $(handleId);
  const limit = (width) => Math.max(min, Math.min(maxWidth(container.clientWidth), width));
  const apply = (width, save = false) => {
    const value = limit(width);
    container.style.setProperty(variable, `${value}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(value)));
    if (save) localStorage.setItem(storageKey, String(Math.round(value)));
  };
  const saved = Number.parseFloat(localStorage.getItem(storageKey));
  if (saved > 0) apply(saved);
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX;
    const initial = direction === 1
      ? handle.getBoundingClientRect().left - container.getBoundingClientRect().left
      : container.getBoundingClientRect().right - handle.getBoundingClientRect().right;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (next) => apply(initial + (next.clientX - start) * direction);
    const stop = (next) => {
      move(next);
      localStorage.setItem(storageKey, String(Math.round(Number.parseFloat(container.style.getPropertyValue(variable)))));
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
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
    const current = Number.parseFloat(container.style.getPropertyValue(variable)) ||
      (direction === 1 ? handle.getBoundingClientRect().left - container.getBoundingClientRect().left
        : container.getBoundingClientRect().right - handle.getBoundingClientRect().right);
    apply(current + (event.key === 'ArrowRight' ? 20 : -20) * direction, true);
  });
  handle.addEventListener('dblclick', () => {
    container.style.removeProperty(variable);
    localStorage.removeItem(storageKey);
  });
  window.addEventListener('resize', () => {
    const current = Number.parseFloat(container.style.getPropertyValue(variable));
    if (current) apply(current);
  });
}
initResize('sidebarResize', document.querySelector('.workspace'), '--sidebar-width', 'iosEventSidebarWidth', 1, 160, (width) => Math.min(420, width - 580));
initResize('detailResize', document.querySelector('.event-layout'), '--detail-width', 'iosEventDetailWidth', -1, 265, (width) => Math.min(720, width - 320));
$('ruleKind').addEventListener('change', () => {
  const kind = $('ruleKind').value;
  $('countFields').hidden = kind !== 'count';
  $('attributeFields').hidden = kind !== 'attribute';
  $('sequenceFields').hidden = kind !== 'sequence';
});
$('ruleForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const rule = Object.fromEntries(new FormData(event.target).entries());
  try { await api('/api/rules', {method:'POST',body:JSON.stringify(rule)}); event.target.reset(); $('ruleKind').dispatchEvent(new Event('change')); await refreshAnalysis(); message('规则已添加。'); }
  catch (error) { message(error.message, true); }
});
for (const [id, format] of [['exportCsv','csv'],['exportJson','json']]) $(id).addEventListener('click', () => {
  if (!state.sessionId) { message('请先选择一个会话。', true); return; }
  window.location.href = `/api/export?session=${state.sessionId}&format=${format}`;
});
$('exportRules').addEventListener('click', async () => {
  try {
    const data = await api('/api/rules/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url; link.download = 'ios-event-rules.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { message(error.message, true); }
});
$('importRules').addEventListener('click', () => $('rulesFile').click());
$('rulesFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('规则文件不能超过 1 MB');
    const data = JSON.parse(await file.text());
    const result = await api('/api/rules/import', {method:'POST', body:JSON.stringify(data)});
    await refreshAnalysis(); message(`已导入 ${result.imported} 条规则。`);
  } catch (error) { message(error.message, true); }
  event.target.value = '';
});

restoreEventFilter();
window.iosEventAppLoaded = true;
refreshDevices().then(refreshAll);
setInterval(refreshAll, 2000);
setInterval(refreshDevices, 15000);
