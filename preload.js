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
  app: {
    info: inv('app:info'), openDataDir: inv('app:openDataDir'), pickFolder: inv('dialog:pickFolder'),
    onTtsStart: on('app:ttsStart'), onClipImage: on('clip:image'),
  },
  files: { pick: inv('files:pick') },
  mail: { setPassword: inv('mail:setPassword'), test: inv('mail:test') },
  github: { setToken: inv('github:setToken'), test: inv('github:test') },
  agent: { pickDir: inv('agent:pickDir'), clearDir: inv('agent:clearDir'), check: inv('agent:check'), openDir: inv('agent:openDir') },
  hf: { search: inv('hf:search'), details: inv('hf:details'), translate: inv('hf:translate'), setToken: inv('hf:setToken') },
  panel: { bounds: inv('panel:bounds'), openUrl: inv('panel:openUrl'), html: inv('panel:html'), nav: inv('panel:nav'), newTab: inv('panel:newTab'), selectTab: inv('panel:selectTab'), closeTab: inv('panel:closeTab'), close: inv('panel:close'), external: inv('panel:external'), pdf: inv('panel:pdf'), onState: on('panel:state') },
  sys: { stats: inv('sys:stats') },
  models: {
    status: inv('models:status'), list: inv('models:list'), show: inv('models:show'), remove: inv('models:remove'),
    download: inv('models:download'), cancel: inv('models:cancelDownload'), downloads: inv('models:downloads'), unload: inv('models:unload'),
    pickDir: inv('models:pickDir'), resetDir: inv('models:resetDir'), openDir: inv('models:openDir'),
    ollamaFound: inv('models:ollamaFound'), ollamaImport: inv('models:ollamaImport'),
    onProgress: on('models:downloadProgress'), onState: on('models:downloadState'), onEngine: on('models:engineStatus'),
  },

  chat: {
    start: inv('chat:start'), stop: inv('chat:stop'),
    onTool: on('chat:tool'), onDelta: on('chat:delta'), onDone: on('chat:done'), onError: on('chat:error'),
  },
  ocr: { run: inv('ocr:run') },
  voice: { status: inv('voice:status'), setup: inv('voice:setup'), cancel: inv('voice:cancel'), cleanOld: inv('voice:cleanOld'), onProgress: on('voice:progress') },
  supertonic: { setup: inv('supertonic:setup'), cancel: inv('supertonic:cancel') },
  phonon: { setup: inv('phonon:setup'), cancel: inv('phonon:cancel'), remove: inv('phonon:remove'), preview: inv('phonon:preview') },
  voxtral: { setup: inv('voxtral:setup'), cancel: inv('voxtral:cancel'), remove: inv('voxtral:remove') },
  speech: {
    status: inv('speech:status'), prepareStt: inv('speech:prepareStt'), prepareTts: inv('speech:prepareTts'),
    abort: inv('speech:abort'), transcribe: inv('speech:transcribe'), warmStt: inv('speech:warmStt'), synthesize: inv('speech:synthesize'), serverVoices: inv('speech:serverVoices'),
    startServer: inv('speech:startServer'), cancelSynth: inv('speech:cancelSynth'), pickSample: inv('speech:pickSample'),
    onProgress: on('speech:progress'),
  },
});
