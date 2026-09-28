// Run: node --test tests/tree_refresh.test.mjs
// Exercise the actual UI handler with deferred IPC and real filesystem snapshots.
// No MFT privilege or browser dependency is needed to control reply ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('main.tsx', fs.readFileSync(new URL('../ui/src/main.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleToggleExpand') handler = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(handler, 'production tree expansion handler must exist');
const javascript = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-insight-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = { record_index: 42, is_directory: true, path: dir, name: path.basename(dir) };
  const requests = [];
  const state = {
    TREE_FOCUS_DEBUG: false, TREE_EXPAND_LIMIT: 300,
    sourceKind: 'live', isLoading: false, performance, perfLog() {},
    pendingTreeFocusRef: { current: null }, scanGenerationRef: { current: 1 },
    expandedIds: new Set(), loadingIds: new Set(), childrenByParent: {},
    childrenErrors: {}, treeExpandedTotalCount: {}, treeError: null,
    getChildrenLimited(id) {
      assert.equal(id, folder.record_index);
      const nodes = fs.readdirSync(dir).map((name, i) => ({
        name, path: path.join(dir, name), record_index: 100 + i,
        parent_record_index: id, is_directory: false,
        subtree_size: fs.statSync(path.join(dir, name)).size,
      }));
      return new Promise((resolve, reject) => requests.push({
        reply: () => resolve({ nodes, total_count: nodes.length }), reject,
      }));
    },
  };
  for (const key of ['focusedRecordIndex', 'expandedIds', 'loadingIds', 'childrenByParent', 'childrenErrors', 'treeExpandedTotalCount', 'treeError']) {
    state[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => {
      state[key] = typeof value === 'function' ? value(state[key]) : value;
    };
  }
  vm.createContext(state);
  vm.runInContext(javascript, state);
  function refresh() {
    // Same invalidation performed at the start of runScanWithCache.
    state.scanGenerationRef.current++;
    state.childrenByParent = {};
    state.childrenErrors = {};
    state.treeExpandedTotalCount = {};
    state.expandedIds = new Set();
    state.loadingIds = new Set();
  }
  return { dir, folder, state, requests, refresh, expand: () => state.handleToggleExpand(folder) };
}

test('refresh: a late pre-refresh reply cannot resurrect deleted or renamed files', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, '削除 file.bin'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(f.dir, 'before.bin'), Buffer.alloc(8192));
  f.expand(); // First scan: 2 files, 12288 bytes; expansion reply is still in flight.
  fs.unlinkSync(path.join(f.dir, '削除 file.bin'));
  fs.renameSync(path.join(f.dir, 'before.bin'), path.join(f.dir, '移動 renamed.bin'));
  fs.writeFileSync(path.join(f.dir, 'new.bin'), Buffer.alloc(16384));
  f.refresh();
  f.expand(); // Fresh scan: 2 files, 24576 bytes.
  f.requests[1].reply();
  await settle();
  f.requests[0].reply(); // Old IPC finishes after the fresh scan/expansion.
  await settle();
  const rows = f.state.childrenByParent[f.folder.record_index];
  assert.equal(rows.reduce((sum, row) => sum + row.subtree_size, 0), 24576, 'fresh tree total must not revert to 12288 bytes');
  assert.deepEqual(rows.map(row => row.name).sort(), ['new.bin', '移動 renamed.bin']);
  assert.equal(rows.length, 2);
});

test('refresh: an old completion cannot clear a new expansion loading guard', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'empty.bin'), '');
  f.expand();
  f.refresh();
  f.expand();
  f.requests[0].reply();
  await settle();
  assert.ok(f.state.loadingIds.has(f.folder.record_index));
  assert.equal(f.state.childrenByParent[f.folder.record_index], undefined);
  f.expand();
  assert.equal(f.requests.length, 2, 'duplicate expansion stays suppressed');
  f.requests[1].reply();
  await settle();
  assert.equal(f.state.childrenByParent[f.folder.record_index][0].subtree_size, 0);
  assert.equal(f.state.loadingIds.size, 0);
});

test('refresh: a stale error cannot replace the fresh folder state', async t => {
  const f = fixture(t);
  f.expand();
  f.refresh();
  f.expand();
  f.requests[1].reply();
  await settle();
  f.requests[0].reject(new Error('old scan unavailable'));
  await settle();
  assert.equal(f.state.childrenErrors[f.folder.record_index], undefined);
  assert.equal(f.state.childrenByParent[f.folder.record_index].length, 0);
});

test('normal expansion preserves current errors, retry and cached children', async t => {
  const f = fixture(t);
  f.expand();
  f.requests[0].reject(new Error('access denied'));
  await settle();
  assert.match(f.state.childrenErrors[f.folder.record_index], /access denied/);
  assert.equal(f.state.loadingIds.size, 0);
  fs.writeFileSync(path.join(f.dir, '日本語 spaces.bin'), Buffer.alloc(65536));
  f.expand();
  f.requests[1].reply();
  await settle();
  assert.equal(f.state.childrenErrors[f.folder.record_index], undefined);
  assert.equal(f.state.childrenByParent[f.folder.record_index][0].subtree_size, 65536);
  f.expand(); // Collapse.
  f.expand(); // Expand from current cache without IPC.
  assert.equal(f.requests.length, 2);
  assert.ok(f.state.expandedIds.has(f.folder.record_index));
});

test('refresh: the old visible tree cannot start an expansion during a scan', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'old.bin'), Buffer.alloc(4096));
  f.refresh();
  f.state.isLoading = true;
  f.expand();
  assert.equal(f.requests.length, 0, 'new generation must not fetch the previous backend snapshot');
  fs.unlinkSync(path.join(f.dir, 'old.bin'));
  fs.writeFileSync(path.join(f.dir, 'fresh.bin'), Buffer.alloc(8192));
  f.state.isLoading = false;
  f.expand();
  f.requests[0].reply();
  await settle();
  assert.equal(f.state.childrenByParent[f.folder.record_index][0].name, 'fresh.bin');
  assert.equal(f.state.childrenByParent[f.folder.record_index][0].subtree_size, 8192);
});
