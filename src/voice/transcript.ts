import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';

type RealtimeEvent = {
  type: string;
  item?: { id?: string; type?: string; role?: string };
  item_id?: string;
  transcript?: string;
  delta?: string;
  response?: { status?: string; output?: Array<{ id?: string; type?: string }> };
};

type Speaker = 'CALLER' | 'AGENT';

// Save each AI-call turn as it arrives. Generated text doesn't prove the caller heard it.
export function createTranscript(
  store: Store,
  callSessionId: () => string | null,
  /** True while agent audio is being withheld from the caller (during a hand-off). */
  agentMuted: () => boolean = () => false,
) {
  const speakers = new Map<string, Speaker>();
  /** Items still waiting for their final text. */
  const pending = new Set<string>();
  /** Items whose final text arrived, so a repeated "added" event cannot reopen them. */
  const completed = new Set<string>();
  /** Text streamed so far for unfinished items, saved if the call ends before the final text. */
  const partialText = new Map<string, string>();
  let callerSpeaking = false;
  let gaps = false;

  const save = (turn: Parameters<Store['upsertTranscriptTurn']>[1]) => {
    const id = callSessionId();
    if (!id) return;
    try {
      store.upsertTranscriptTurn(id, turn);
    } catch (error) {
      gaps = true;
      console.error(`Transcript update failed (${(error as Error).name}).`);
    }
  };

  const complete = (itemId: string, speaker: Speaker, text: string) => {
    pending.delete(itemId);
    partialText.delete(itemId);
    completed.add(itemId);
    save({ itemId, speaker, text });
  };

  return {
    handle(event: RealtimeEvent): void {
      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          callerSpeaking = true;
          return;
        case 'input_audio_buffer.committed':
          callerSpeaking = false;
          return;
        case 'conversation.item.added': {
          const { id, type, role } = event.item ?? {};
          if (!id || type !== 'message' || (role !== 'user' && role !== 'assistant')) return;
          const speaker = role === 'user' ? 'CALLER' : 'AGENT';
          if (speaker === 'CALLER') callerSpeaking = false;
          if (speakers.has(id) || completed.has(id)) return;
          speakers.set(id, speaker);
          pending.add(id);
          // An agent reply generated during a hand-off was never played to the caller.
          save({ itemId: id, speaker, ...(speaker === 'AGENT' && agentMuted() ? { interrupted: true } : {}) });
          return;
        }
        case 'conversation.item.input_audio_transcription.delta':
          if (event.item_id && !completed.has(event.item_id)) {
            partialText.set(event.item_id, (partialText.get(event.item_id) ?? '') + (event.delta ?? ''));
          }
          return;
        case 'conversation.item.input_audio_transcription.completed':
          if (event.item_id) complete(event.item_id, 'CALLER', event.transcript ?? '');
          return;
        case 'conversation.item.input_audio_transcription.failed':
          if (!event.item_id) return;
          gaps = true;
          complete(event.item_id, 'CALLER', '(could not be transcribed)');
          return;
        case 'response.output_audio_transcript.delta':
          if (event.item_id && !completed.has(event.item_id)) {
            partialText.set(event.item_id, (partialText.get(event.item_id) ?? '') + (event.delta ?? ''));
          }
          return;
        case 'response.output_audio_transcript.done':
          if (event.item_id) complete(event.item_id, 'AGENT', event.transcript ?? '');
          return;
        case 'conversation.item.truncated':
          if (event.item_id) save({ itemId: event.item_id, speaker: 'AGENT', interrupted: true });
          return;
        case 'response.done':
          // A cancelled reply was cut off before it finished.
          if (event.response?.status === 'cancelled') {
            for (const item of event.response.output ?? []) {
              if (item.id && item.type === 'message') save({ itemId: item.id, speaker: 'AGENT', interrupted: true });
            }
          }
          return;
      }
    },

    /** A server-authored line handed to Twilio: records issuance, not that it was heard. */
    system(text: string): void {
      save({ itemId: `system-${randomUUID()}`, speaker: 'SYSTEM', text });
    },

    /** Called when the stream closes; no further transcription events can arrive after this. */
    finish(): void {
      // Save partial text on hang-up and mark unfinished agent replies as interrupted.
      for (const itemId of pending) {
        const speaker = speakers.get(itemId) ?? 'AGENT';
        const text = partialText.get(itemId);
        save({ itemId, speaker, interrupted: speaker === 'AGENT', ...(text ? { text } : {}) });
      }
      const missing = gaps || callerSpeaking || pending.size > 0;
      const id = callSessionId();
      if (!id) return;
      try {
        store.setTranscriptState(id, missing ? 'PARTIAL' : 'COMPLETE_AI_LEG');
      } catch (error) {
        console.error(`Transcript finalize failed (${(error as Error).name}).`);
      }
    },
  };
}
