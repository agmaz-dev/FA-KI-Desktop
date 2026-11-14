'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  settings: { get: inv('settings:get'), set: inv('settings:set') },
  chats: {
    list: inv('chats:list'), load: inv('chats:load'), save: inv('chats:save'),
    remove: inv('chats:delete'), export: inv('chats:export'), clear: inv('chats:clear'),
  },
  app: { info: inv('app:info'), openDataDir: inv('app:openDataDir') },
  files: { pick: inv('files:pick') },
  ollama: {
    status: inv('ollama:status'), models: inv('ollama:models'), show: inv('ollama:show'),
    remove: inv('ollama:delete'), pull: inv('ollama:pull'), pullCancel: inv('ollama:pullCancel'),
    onPull: on('ollama:pullProgress'),
  },
  chat: {
    start: inv('chat:start'), stop: inv('chat:stop'),
    onDelta: on('chat:delta'), onDone: on('chat:done'), onError: on('chat:error'),
  },
  ocr: { run: inv('ocr:run') },
  speech: {
    status: inv('speech:status'), prepareStt: inv('speech:prepareStt'), prepareTts: inv('speech:prepareTts'),
    abort: inv('speech:abort'), transcribe: inv('speech:transcribe'), synthesize: inv('speech:synthesize'),
    onProgress: on('speech:progress'),
  },
});
