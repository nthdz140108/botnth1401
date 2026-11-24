import test from 'node:test';
import assert from 'node:assert/strict';
import { sendVoiceMusic } from '../src/service-debug/chat-zalo/chat-special/send-voice/send-voice.js';

test('download callers can observe a failed Zalo audio send', async () => {
  const api = {
    sendMessage: async () => ({ msgId: 'caption' }),
    sendVoice: async () => { throw new Error('voice rejected'); },
  };
  await assert.rejects(() => sendVoiceMusic(api, { threadId: 'room', type: 1, data: { dName: 'Test' } }, {
    title: 'Audio', voiceUrl: 'https://cdn/audio.aac', caption: 'Audio',
  }, 30000, { throwOnError: true }), /voice rejected/);
});
