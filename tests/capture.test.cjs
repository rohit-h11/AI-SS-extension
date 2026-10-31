const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({playError = false} = {}) {
  const nodes = [], events = [], intervals = new Set();
  let stopped = 0, attached = 0;
  const location = {href: 'https://chatgpt.com/c/test'};
  const create = tag => {
    const node = {tag, style: {}, children: [], width: 0, height: 0,
      setAttribute() {}, append(...items) {this.children.push(...items);},
      attachShadow() {return create('shadow');}, insertBefore(n) {this.children.push(n);},
      focus() {}, remove() {this.removed = true;}, setPointerCapture() {},
      getBoundingClientRect() {return {left: 0, top: 0, width: this.width, height: this.height};},
      getContext() {return {drawImage() {}, fillRect() {}, strokeRect() {}};},
      toBlob(cb) {events.push(['encode', this.width, this.height]); cb(new Blob(['png'], {type: 'image/png'}));}
    };
    if (tag === 'video') Object.assign(node, {videoWidth: 3840, videoHeight: 2160,
      play: async () => {if (playError) throw Error('frame failed');}, requestVideoFrameCallback: f => queueMicrotask(f)});
    nodes.push(node); return node;
  };
  const context = vm.createContext({
    location, Blob, console, Date, Math,
    window: {addEventListener() {}, removeEventListener() {}},
    document: {getElementById: id => nodes.find(n => n.id === id && !n.removed), createElement: create, documentElement: create('root')},
    navigator: {mediaDevices: {getUserMedia: async args => {
      events.push(['media', args]);
      return {getTracks: () => [{stop() {stopped++; events.push(['stop']);}}]};
    }}, clipboard: {write: async () => events.push(['copy'])}},
    ClipboardItem: class {},
    FileReader: class {readAsDataURL() {this.result = 'data:image/png;base64,cG5n'; queueMicrotask(() => this.onload());}},
    chrome: {runtime: {sendMessage: async m => {events.push(['message', m.type]); return {ok: true};}}},
    setTimeout, clearTimeout,
    setInterval: f => {intervals.add(f); return f;}, clearInterval: f => intervals.delete(f)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shottoai/page-capture.js'), 'utf8'), context);
  const run = (settings = {}) => context.__shotCapture({streamId: 'token', jobId: 'job-12345678', targetUrl: 'https://chatgpt.com/c/test',
    settings: {crop: false, copy: false, save: false, maxWidth: 1920, ...settings}}, async () => {
    assert.equal(stopped, 1, 'capture tracks must already be stopped at attachment'); attached++;
    return {attached: true};
  }, text => events.push(['toast', text]));
  const button = label => nodes.find(n => n.tag === 'button' && n.textContent === label);
  const waitButton = async label => {
    for (let i = 0; i < 20; i++) { if (button(label)) return button(label); await new Promise(setImmediate); }
    throw Error('Missing button: ' + label);
  };
  return {run, nodes, events, intervals, location, button, waitButton, stopped: () => stopped, attached: () => attached};
}
test('page capture stops media before encoding, downscales and attaches without any new page', async () => {
  const h = harness();
  assert.equal((await h.run()).attached, true);
  assert.deepEqual(h.events.find(e => e[0] === 'encode'), ['encode', 1920, 1080]);
  assert.ok(h.events.findIndex(e => e[0] === 'stop') < h.events.findIndex(e => e[0] === 'encode'));
  assert.equal(h.events.find(e => e[0] === 'media')[1].video.mandatory.chromeMediaSourceId, 'token');
  assert.equal(h.nodes.some(n => n.id === 'shottoai-panel'), false);
  assert.equal(h.intervals.size, 0);
});
test('crop is an in-page overlay shown after tracks stop; Cancel does not attach', async () => {
  const h = harness(), pending = h.run({crop: true});
  const cancel = await h.waitButton('Cancel');
  assert.equal(h.stopped(), 1);
  assert.ok(h.nodes.some(n => n.id === 'shottoai-panel'));
  cancel.onclick();
  assert.equal((await pending).cancelled, true);
  assert.equal(h.attached(), 0);
  assert.equal(h.intervals.size, 0);
});
test('dragging crop overlay attaches selected rectangle and removes overlay', async () => {
  const h = harness(), pending = h.run({crop: true});
  const send = await h.waitButton('Attach screenshot');
  const canvas = h.nodes.filter(n => n.tag === 'canvas')[1];
  canvas.onpointerdown({clientX: 500, clientY: 300, pointerId: 1});
  canvas.onpointermove({clientX: 100, clientY: 100});
  canvas.onpointerup(); send.onclick(); await pending;
  assert.deepEqual(h.events.find(e => e[0] === 'encode'), ['encode', 400, 200]);
  assert.equal(h.attached(), 1);
  assert.ok(h.nodes.find(n => n.id === 'shottoai-panel').removed);
});
test('navigation during crop refuses attachment and offers copy on the same page', async () => {
  const h = harness(), pending = h.run({crop: true});
  const send = await h.waitButton('Attach screenshot');
  h.location.href = 'https://chatgpt.com/c/other'; send.onclick();
  await assert.rejects(pending, /chat changed/);
  assert.equal(h.attached(), 0);
  assert.ok(h.button('Copy image'));
  assert.equal(h.intervals.size, 0);
});
test('video failure still stops tracks and clears heartbeat', async () => {
  const h = harness({playError: true});
  await assert.rejects(h.run(), /frame failed/);
  assert.equal(h.stopped(), 1);
  assert.equal(h.attached(), 0);
  assert.equal(h.intervals.size, 0);
});
test('clipboard and download options work in the page capture path', async () => {
  const h = harness(); await h.run({copy: true, save: true});
  assert.ok(h.events.some(e => e[0] === 'copy'));
  assert.ok(h.events.some(e => e[0] === 'message' && e[1] === 'SHOT_SAVE'));
  assert.equal(h.attached(), 1);
});
