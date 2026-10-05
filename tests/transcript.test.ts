import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toView } from '../src/records.ts';
import { openStore } from '../src/store.ts';
import { createTranscript } from '../src/voice/transcript.ts';

function setup() {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TRANSCRIPT', null);
  const transcript = createTranscript(store, () => id);
  const turns = () => [...store.getRecord(id)!.session.transcript].sort((a, b) => a.order - b.order);
  return { store, id, transcript, turns };
}

const added = (id: string, role: 'user' | 'assistant') => ({ type: 'conversation.item.added', item: { id, type: 'message', role } });
const callerText = (id: string, transcript: string) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: id,
  transcript,
});
const agentText = (id: string, transcript: string) => ({ type: 'response.output_audio_transcript.done', item_id: id, transcript });

test('turns keep conversation order even when transcriptions finish out of order', () => {
  const { transcript, turns } = setup();
  transcript.handle(added('item_agent_1', 'assistant'));
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle(added('item_agent_2', 'assistant'));
  // The agent's reply text arrives before the caller's slower transcription.
  transcript.handle(agentText('item_agent_2', 'Is the system completely out?'));
  transcript.handle(agentText('item_agent_1', 'Hi, how can I help?'));
  transcript.handle(callerText('item_caller_1', 'My heat is out.'));

  assert.deepEqual(
    turns().map((t) => [t.speaker, t.text]),
    [
      ['AGENT', 'Hi, how can I help?'],
      ['CALLER', 'My heat is out.'],
      ['AGENT', 'Is the system completely out?'],
    ],
  );
});

test('repeated events update a turn instead of duplicating it, and non-message items are ignored', () => {
  const { transcript, turns } = setup();
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle(callerText('item_caller_1', 'Hello'));
  transcript.handle(callerText('item_caller_1', 'Hello'));
  transcript.handle({ type: 'conversation.item.added', item: { id: 'item_fn', type: 'function_call' } });
  assert.equal(turns().length, 1);
});

test('interrupted agent turns are flagged, whether truncated or cancelled', () => {
  const { transcript, turns } = setup();
  transcript.handle(added('item_agent_1', 'assistant'));
  transcript.handle(agentText('item_agent_1', 'Let me read that back: your name is'));
  transcript.handle({ type: 'conversation.item.truncated', item_id: 'item_agent_1' });
  transcript.handle(added('item_agent_2', 'assistant'));
  transcript.handle({
    type: 'response.done',
    response: { status: 'cancelled', output: [{ id: 'item_agent_2', type: 'message' }] },
  });
  assert.deepEqual(
    turns().map((t) => t.interrupted),
    [true, true],
  );
});

test('sensitive numbers are redacted before the transcript is stored', () => {
  const { transcript, turns } = setup();
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle(callerText('item_caller_1', 'My card is 4111 1111 1111 1111 and my password is hunter2'));
  assert.equal(turns()[0]!.text, 'My card is [redacted number] and my password [redacted]');
});

test('the transcript is partial when text is still missing at the end, complete otherwise', () => {
  const partial = setup();
  partial.transcript.handle(added('item_caller_1', 'user'));
  partial.transcript.finish();
  assert.equal(partial.store.getRecord(partial.id)!.session.transcriptState, 'PARTIAL');

  const complete = setup();
  complete.transcript.handle(added('item_caller_1', 'user'));
  complete.transcript.handle(callerText('item_caller_1', 'Hello'));
  complete.transcript.finish();
  assert.equal(complete.store.getRecord(complete.id)!.session.transcriptState, 'COMPLETE_AI_LEG');
});

test('scripted lines are recorded as SYSTEM and the view says they are not proof of hearing', () => {
  const { store, id, transcript } = setup();
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle(callerText('item_caller_1', '<script>alert(1)</script>'));
  transcript.system("It sounds like you may have stepped away, so I'll end the call here. Goodbye.");
  const view = toView(store.getRecord(id)!);
  assert.equal(view.transcript[1]!.speaker, 'System');
  assert.match(view.transcript[1]!.note ?? '', /not proof it was heard/);
  assert.equal(view.transcript[0]!.text, '<script>alert(1)</script>', 'escaped later, by the HTML view');
});

test('restart recovery marks an interrupted transcript partial', () => {
  const { store, id, transcript } = setup();
  transcript.handle(added('item_caller_1', 'user'));
  store.recoverStaleCalls();
  assert.equal(store.getRecord(id)!.session.transcriptState, 'PARTIAL');
});

test('a failed transcription leaves the transcript partial', () => {
  const { store, id, transcript } = setup();
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_caller_1' });
  transcript.finish();
  assert.equal(store.getRecord(id)!.session.transcriptState, 'PARTIAL');
});

test('hanging up while the caller is mid-sentence leaves the transcript partial, even with no turns', () => {
  const { store, id, transcript } = setup();
  transcript.handle({ type: 'input_audio_buffer.speech_started' });
  transcript.finish();
  const session = store.getRecord(id)!.session;
  assert.equal(session.transcript.length, 0);
  assert.equal(session.transcriptState, 'PARTIAL');
});

test('a failed transcript save leaves the transcript partial', () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TRANSCRIPT', null);
  let failNext = false;
  const flaky = {
    ...store,
    upsertTranscriptTurn: (...args: Parameters<typeof store.upsertTranscriptTurn>) => {
      if (failNext) throw new Error('disk full');
      store.upsertTranscriptTurn(...args);
    },
  };
  const transcript = createTranscript(flaky, () => id);
  transcript.handle(added('item_caller_1', 'user'));
  failNext = true;
  transcript.handle(callerText('item_caller_1', 'Hello'));
  failNext = false;
  transcript.finish();
  assert.equal(store.getRecord(id)!.session.transcriptState, 'PARTIAL');
});

test('a repeated item event after its text arrived does not make the transcript partial', () => {
  const { store, id, transcript } = setup();
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle(callerText('item_caller_1', 'Hello'));
  transcript.handle(added('item_caller_1', 'user'));
  transcript.finish();
  assert.equal(store.getRecord(id)!.session.transcriptState, 'COMPLETE_AI_LEG');
});

test('text streamed before a hangup is kept, and the cut-off agent reply is flagged', () => {
  const { store, id, transcript, turns } = setup();
  transcript.handle(added('item_agent_1', 'assistant'));
  transcript.handle({ type: 'response.output_audio_transcript.delta', item_id: 'item_agent_1', delta: 'Your visit is booked for ' });
  transcript.handle(added('item_caller_1', 'user'));
  transcript.handle({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_caller_1', delta: 'Wait, my card is 4111111111111111' });
  transcript.finish();

  const [agent, caller] = turns();
  assert.equal(agent!.text, 'Your visit is booked for ');
  assert.equal(agent!.interrupted, true);
  assert.equal(caller!.text, 'Wait, my card is [redacted number]', 'partial text is redacted too');
  assert.equal(caller!.interrupted, false);
  assert.equal(store.getRecord(id)!.session.transcriptState, 'PARTIAL');
});

test('an agent reply generated during a hand-off is kept but marked as not heard', () => {
  const store = openStore(':memory:');
  const id = store.createCall('CA_TRANSCRIPT', null);
  let muted = false;
  const transcript = createTranscript(store, () => id, () => muted);
  transcript.handle(added('item_agent_1', 'assistant'));
  muted = true;
  transcript.handle(added('item_agent_2', 'assistant'));
  transcript.handle(agentText('item_agent_2', 'Please hold while I connect you.'));
  const turns = [...store.getRecord(id)!.session.transcript].sort((a, b) => a.order - b.order);
  assert.deepEqual(turns.map((t) => t.interrupted), [false, true]);
});
