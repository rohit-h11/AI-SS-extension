const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..', 'shottoai');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');

async function exerciseAdapter(route, hostname = 'chatgpt.com') {
  let handler, time = 0, added = false, copied = false;
  const events = [];
  const preview = {tagName: 'IMG', textContent: '', getClientRects: () => [1], getAttribute: n => n === 'src' ? 'blob:attachment' : null};
  const scope = {querySelectorAll: () => added ? [preview] : []};
  const dispatch = e => { events.push(e.type); if (e.type === route) added = true; return true; };
  const composer = {getClientRects: () => [1], focus() {}, closest: () => scope, contains: () => false, dispatchEvent: dispatch};
  class Input { set files(value) { this.value = value; } get files() { return this.value; } }
  const input = new Input();
  input.accept = 'image/*'; input.dispatchEvent = dispatch;
  const document = {
    querySelectorAll: s => s.includes('input[type="file"]') ? [input] : route === 'missing' ? [] : [composer],
    getElementById: () => null,
    createElement: () => ({style: {}, setAttribute() {}, attachShadow: () => ({append() {}}), remove() {}}),
    documentElement: {append() {}}
  };
  class SyntheticEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  class Transfer { constructor() { this.files = []; this.items = {add: f => this.files.push(f)}; } }
  const context = vm.createContext({
    document, location: {hostname}, getComputedStyle: () => ({visibility: 'visible'}),
    chrome: {runtime: {id: 'test', onMessage: {addListener: f => handler = f}}},
    navigator: {clipboard: {write: async () => { copied = true; }}},
    Blob, File, fetch, ClipboardItem: class {constructor(value) {this.value = value;}},
    ClipboardEvent: SyntheticEvent, DragEvent: SyntheticEvent, Event: SyntheticEvent,
    HTMLInputElement: Input, DataTransfer: Transfer, console,
    Date: class extends Date {static now() {return time;}},
    setTimeout: (f, ms) => {time += ms; queueMicrotask(f);}
  });
  vm.runInContext(source('content.js'), context);
  const payload = {type: 'SHOT_ATTACH', dataUrl: 'data:image/png;base64,AA==', filename: 'unit.png'};
  const send = () => new Promise(resolve => handler(payload, {id: 'test'}, resolve));
  const result = await send();
  const eventCount = events.length;
  await send();
  assert.equal(events.length, eventCount, 're-delivery must not dispatch events again');
  return {result, events, copied};
}
for (const [route, method, expected] of [
  ['paste', 'paste', ['paste']],
  ['change', 'file input', ['paste', 'change', 'input']],
  ['drop', 'drop', ['paste', 'change', 'input', 'dragenter', 'dragover', 'drop']]
]) test('adapter route ' + method + ' requires visible evidence and follows fallback order', async () => {
  const r = await exerciseAdapter(route);
  assert.equal(r.result.attached, true);
  assert.equal(r.result.method, method);
  assert.deepEqual(r.events, expected);
  assert.equal(r.copied, false);
});
test('dispatching events alone is not success: clipboard is used after all routes fail', async () => {
  const r = await exerciseAdapter('none');
  assert.equal(r.result.attached, false);
  assert.equal(r.copied, true);
  assert.deepEqual(r.events, ['paste', 'change', 'input', 'dragenter', 'dragover', 'drop']);
});
test('missing composer falls back to clipboard without event injection', async () => {
  const r = await exerciseAdapter('missing');
  assert.equal(r.result.attached, false);
  assert.equal(r.copied, true);
  assert.deepEqual(r.events, []);
});
for (const host of ['claude.ai', 'gemini.google.com']) test(host + ' adapter handles an observed paste attachment', async () => {
  assert.equal((await exerciseAdapter('paste', host)).result.method, 'paste');
});
