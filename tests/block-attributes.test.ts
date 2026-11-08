import test from './isolated-test.js';
import assert from 'node:assert/strict';
import { persistentBlockAttributes } from '../src/editor/blockAttributes.js';

test('block persistence omits source local selection but preserves durable default index and rich content', () => {
  const nested = { colors: ['red'] };
  const source = { activeTabIndex: 1, editorActiveTabIndex: 2, label: { toJSON: () => '<strong>Details</strong>' }, nested };
  const result = persistentBlockAttributes(source, { activeTabIndex: { role: undefined }, editorActiveTabIndex: { role: 'local' }, label: { role: 'content' } });
  assert.deepEqual(result, { activeTabIndex: 1, label: '<strong>Details</strong>', nested: { colors: ['red'] } });
  assert.notEqual(result.nested, nested, 'durable attributes detach mutable editor values');
  assert.equal(source.editorActiveTabIndex, 2, 'live editor selection remains available');
  assert.deepEqual(persistentBlockAttributes({ unknown: 'preserved' }), { unknown: 'preserved' });
});
