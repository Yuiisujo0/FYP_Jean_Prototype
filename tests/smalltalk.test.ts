import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smallTalk } from '../src/lib/smalltalk.ts';

test('greetings, thanks and help get a friendly reply', () => {
  for (const t of ['hi', 'Hi!', 'hello', 'Hey there'.replace(' there', ''), 'good morning', 'how are you', 'hi, how are you?', 'thanks', 'thank you!', 'bye', 'what can you do', 'help', 'who are you?']) {
    assert.ok(smallTalk(t), t);
  }
});

test('greetings and "how are you" suggest tasks; thanks does not', () => {
  assert.ok(smallTalk('hi')!.suggestions.length > 0);
  assert.equal(smallTalk('thanks')!.suggestions.length, 0);
});

test('real tasks are never treated as small talk', () => {
  for (const t of [
    'Read a CSV of student marks and flag everyone below 50',
    'hi, please filter the rows where score is below 50',
    'show employees in Sales earning over 6000',
    'count rows by course',
    'help me total the amount per customer',
  ]) {
    assert.equal(smallTalk(t), null, t);
  }
});

test('empty and very long text is not small talk', () => {
  assert.equal(smallTalk('   '), null);
  assert.equal(smallTalk('hello ' + 'x'.repeat(80)), null);
});
