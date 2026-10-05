import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONVERSATION_GUIDE } from '../src/voice/conversation-guide.ts';
import { INSTRUCTIONS } from '../src/voice/instructions.ts';
import { NextAction } from '../src/contracts.ts';

// Catch accidental removal of prompt rules; these checks don't test actual model behavior.
test('the hard instructions keep the safety and honesty rules', () => {
  for (const rule of [
    /call escalate_call immediately and\s+say nothing first/,
    /NOT_ESCALATABLE but the caller described danger/,
    /ESCALATION_FAILED, say its message exactly/,
    /Never call 911/,
    /Never say it is recorded or used for\s+training/,
    /A visit is booked only when its status is\s+CONFIRMED/,
    /the backend refuses a booking that skips this/,
  ]) {
    assert.match(INSTRUCTIONS, rule);
  }
});

test('the conversation guide covers every next action the backend can return', () => {
  for (const action of NextAction.options) assert.ok(CONVERSATION_GUIDE.includes(action), action);
});
