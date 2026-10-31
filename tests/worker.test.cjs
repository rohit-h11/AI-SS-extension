const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'shottoai');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
function worker(tabs, initial = {}) {
  tabs.forEach(t => { t.status ??= 'complete'; });
  const state = {...initial}, events = {}, calls = [];
  let next = 100;
  const chrome = {
    action: {onClicked: {addListener: f => events.click = f}, setBadgeText: async x => calls.push(['badge', x]), setTitle: async () => {}},
    commands: {onCommand: {addListener: f => events.command = f}},
    windows: {update: async (...args) => calls.push(['window', ...args])},
    desktopCapture: {
      chooseDesktopMedia: (sources, tab, callback) => {
        calls.push(['picker', tab.id, [...sources]]);
        events.pick = callback;
        queueMicrotask(() => callback('stream-token'));
        return 42;
      },
      cancelChooseDesktopMedia: id => calls.push(['cancel', id])
    },
    tabs: {
      query: async q => tabs.filter(t => !q.active || t.active),
      get: async id => { const t = tabs.find(t => t.id === id); if (!t) throw Error('No tab'); return t; },
      create: async args => { const t = {id: next++, windowId: 1, status: 'complete', ...args}; tabs.push(t); calls.push(['create', args]); return t; },
      update: async (id, args) => { calls.push(['update', id, args]); const t = tabs.find(t => t.id === id); Object.assign(t, args); return t; },
      onRemoved: {addListener: f => events.remove = f},
      onUpdated: {addListener: f => events.update = f},
      sendMessage: async (id, m) => { calls.push(['message', id, m]); return m.type === 'SHOT_PING' ? {version: 2} : {ok: true, attached: true}; }
    },
    storage: {
      session: {get: async () => ({...state}), set: async data => Object.assign(state, data), remove: async key => delete state[key]},
      local: {get: async defaults => ({...defaults})}
    },
    scripting: {executeScript: async args => calls.push(['inject', args])},
    runtime: {id: 'unit-extension', onMessage: {addListener: f => events.message = f}},
    permissions: {contains: async () => true},
    downloads: {download: async args => calls.push(['download', args])}
  };
  const context = vm.createContext({chrome, crypto: require('node:crypto').webcrypto, URL, console, setTimeout});
  vm.runInContext(source('shared.js').replaceAll('export ', '') + '\n' + source('background.js').replace(/^import .*;\r?\n/, ''), context);
  return {context, events, state, calls, chrome, tabs,
    start: tab => { context.origin = tab; return vm.runInContext('start(origin)', context); }};
}
const chat = () => ({id: 1, url: 'https://chatgpt.com/c/test', windowId: 1, lastAccessed: 1});
test('capture on current AI chat creates no tab, navigates nowhere, and binds picker to that chat', async () => {
  const active = chat();
  const w = worker([active, {id: 2, url: 'https://claude.ai/new', lastAccessed: 100}]);
  await w.start(active);
  assert.equal(w.calls.filter(c => c[0] === 'create' || c[0] === 'update').length, 0);
  assert.deepEqual(w.calls.find(c => c[0] === 'picker'), ['picker', 1, ['tab', 'window', 'screen']]);
  const sent = w.calls.find(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE');
  assert.equal(sent[1], 1); assert.equal(sent[2].streamId, 'stream-token');
  assert.equal(w.state.job, undefined);
});
test('unsupported active tab uses most recent existing AI tab without creating a capture tab', async () => {
  const w = worker([chat(), {id: 2, url: 'https://gemini.google.com/app', lastAccessed: 3}]);
  await w.start({id: 3, url: 'https://example.com'});
  assert.equal(w.calls.find(c => c[0] === 'picker')[1], 2);
  assert.equal(w.calls.filter(c => c[0] === 'create').length, 0);
});
test('only the default AI site opens when there is no supported destination', async () => {
  const w = worker([]); await w.start({});
  const created = w.calls.filter(c => c[0] === 'create');
  assert.equal(created.length, 1);
  assert.equal(created[0][1].url, 'https://chatgpt.com/');
});
test('lookalike domains and insecure URLs are not supported', () => {
  const w = worker([]);
  for (const url of ['https://chatgpt.com.evil.test', 'http://chatgpt.com', 'https://evil.test/chatgpt.com', 'invalid']) {
    w.context.url = url; assert.equal(vm.runInContext('supported(url)', w.context), false);
  }
});
test('cancelling picker releases job without starting capture, and another capture works', async () => {
  const tab = chat(), w = worker([tab]);
  const choose = w.chrome.desktopCapture.chooseDesktopMedia;
  w.chrome.desktopCapture.chooseDesktopMedia = (s, t, cb) => { queueMicrotask(() => cb('')); return 1; };
  await w.start(tab);
  assert.equal(w.calls.filter(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE').length, 0);
  assert.equal(w.state.job, undefined);
  w.chrome.desktopCapture.chooseDesktopMedia = choose;
  await w.start(tab);
  assert.ok(w.calls.some(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE'));
});
test('concurrent trigger does not open another picker', async () => {
  const tab = chat(), w = worker([tab]);
  await Promise.all([w.start(tab), w.start(tab)]);
  assert.equal(w.calls.filter(c => c[0] === 'picker').length, 1);
});
test('worker restart respects crop job still running in content script', async () => {
  const tab = chat(), w = worker([tab], {job: {id: 'pending', targetId: 1}});
  w.chrome.tabs.sendMessage = async (id, m) => m.type === 'SHOT_PING' ? {version: 2, jobId: 'pending'} : {ok: true};
  await w.start(tab);
  assert.equal(w.calls.filter(c => c[0] === 'picker' || c[0] === 'create').length, 0);
  assert.equal(w.state.job.id, 'pending');
});
for (const change of ['navigate', 'close']) test(change + ' during picker prevents screenshot delivery', async () => {
  const tab = chat(), w = worker([tab]);
  w.chrome.desktopCapture.chooseDesktopMedia = (s, t, cb) => {
    queueMicrotask(() => { if (change === 'navigate') tab.url = 'https://chatgpt.com/c/other'; else w.tabs.splice(0, 1); cb('token'); });
    return 1;
  };
  await w.start(tab);
  assert.equal(w.calls.filter(c => c[0] === 'message' && c[2].type === 'SHOT_CAPTURE').length, 0);
});
test('missing content scripts inject both capture and site adapters', async () => {
  const w = worker([]);
  w.chrome.tabs.sendMessage = async (id, m) => { if (m.type === 'SHOT_PING') throw Error('No receiver'); return {ok: true}; };
  await vm.runInContext('pageMessage(1, {type: "SHOT_PREPARE"})', w.context);
  assert.equal(w.calls.filter(c => c[0] === 'inject').length, 1);
  assert.deepEqual([...w.calls.find(c => c[0] === 'inject')[1].files], ['page-capture.js', 'content.js']);
});
test('another tab cannot save the capture even with its job ID', async () => {
  const w = worker([], {job: {id: 'secret', targetId: 1, targetUrl: 'https://chatgpt.com/', settings: {save: true}}});
  const result = await new Promise(resolve => w.events.message({type: 'SHOT_SAVE', jobId: 'secret'},
    {id: 'unit-extension', frameId: 0, url: 'https://chatgpt.com/', tab: {id: 2}}, resolve));
  assert.match(result.error, /expired/);
  assert.equal(w.calls.filter(c => c[0] === 'download').length, 0);
});
test('manifest loads page capture and has no popup or capture page', () => {
  const m = JSON.parse(source('manifest.json'));
  assert.deepEqual(m.content_scripts[0].js, ['page-capture.js', 'content.js']);
  assert.equal(m.host_permissions.length, 3);
  assert.deepEqual(m.optional_permissions, ['downloads']);
  assert.ok(!m.action.default_popup);
  assert.ok(!fs.existsSync(path.join(root, 'capture.html')));
});
