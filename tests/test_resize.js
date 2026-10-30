const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('pane handle drags, supports keyboard, and restores saved width', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  const resizeCode = source.slice(source.indexOf('function initResize('), source.indexOf("initResize('sidebarResize'"));
  const handlers = new Map();
  const windowHandlers = new Map();
  const values = new Map([['iosEventSidebarWidth', '300px']]);
  const style = {
    setProperty: (name, value) => values.set(name, value),
    getPropertyValue: (name) => values.get(name) || '',
    removeProperty: (name) => values.delete(name),
  };
  const handle = {
    addEventListener: (name, callback) => handlers.set(name, callback),
    setAttribute: () => {},
    getBoundingClientRect: () => ({left: 300, right: 306}),
    classList: {add: () => {}, remove: () => {}},
  };
  const container = {clientWidth: 1200, style, getBoundingClientRect: () => ({left: 0, right: 1200})};
  const context = vm.createContext({
    $: () => handle,
    localStorage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    document: {body: {classList: {add: () => {}, remove: () => {}}}},
    window: {
      addEventListener: (name, callback) => windowHandlers.set(name, callback),
      removeEventListener: (name) => windowHandlers.delete(name),
    },
  });
  vm.runInContext(resizeCode, context);
  context.initResize = vm.runInContext('initResize', context);
  context.initResize('sidebarResize', container, '--sidebar-width', 'iosEventSidebarWidth', 1, 160, (width) => width - 580);
  assert.equal(style.getPropertyValue('--sidebar-width'), '300px');
  handlers.get('pointerdown')({button: 0, clientX: 300, preventDefault: () => {}});
  windowHandlers.get('pointermove')({clientX: 360});
  windowHandlers.get('pointerup')({clientX: 360});
  assert.equal(values.get('iosEventSidebarWidth'), '360');
  handlers.get('keydown')({key: 'ArrowLeft', preventDefault: () => {}});
  assert.equal(style.getPropertyValue('--sidebar-width'), '340px');
  handlers.get('dblclick')();
  assert.equal(values.has('iosEventSidebarWidth'), false);
});
