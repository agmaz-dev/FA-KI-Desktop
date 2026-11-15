"""Lokaler Stimmen-Server für FA KI Desktop (Chatterbox Multilingual).

Läuft nur auf diesem PC (127.0.0.1). Schnittstelle (OpenAI-kompatibel):
  GET  /                  -> 200 (Server läuft)
  GET  /status            -> {"state": "loading|ready|error", "detail": "..."}
  GET  /v1/audio/voices   -> {"voices": ["meine_stimme.wav", ...]}
  POST /v1/audio/speech   -> WAV; JSON: {"input": "...", "voice": "datei.wav", "language": "de|tr"}
"""
import argparse
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=8004)
ap.add_argument('--voices', default='voices')
ap.add_argument('--cache', default='')
ap.add_argument('--device', default='auto')
args = ap.parse_args()

if args.cache:
    os.makedirs(args.cache, exist_ok=True)
    os.environ.setdefault('HF_HOME', args.cache)
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

STATE = {'state': 'loading', 'detail': 'Modell wird geladen (beim ersten Mal wird es heruntergeladen) …', 'device': ''}
MODEL = {'m': None}
LOCK = threading.Lock()
GEN = {'n': 0}  # wird bei /cancel hochgezählt; laufende Aufträge brechen dann ab
LANGS = {'de', 'tr', 'en', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'ru', 'ar', 'zh', 'ja', 'ko', 'hi', 'sv', 'da', 'fi', 'el', 'he', 'ms', 'no', 'sw'}


def _load_on(dev):
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    return ChatterboxMultilingualTTS.from_pretrained(device=dev)


def load_model(force_cpu=False):
    STATE.update(state='loading', detail='Modell wird geladen (beim ersten Mal wird es heruntergeladen) …')
    try:
        import torch
        try:
            torch.set_num_threads(max(2, (os.cpu_count() or 4) - 1))
        except Exception:  # noqa: BLE001
            pass
        dev = args.device
        if dev == 'auto':
            dev = 'cuda' if (torch.cuda.is_available() and not force_cpu) else 'cpu'
        if force_cpu:
            dev = 'cpu'
        note = ''
        try:
            MODEL['m'] = _load_on(dev)
        except Exception as e:  # noqa: BLE001
            if dev == 'cpu':
                raise
            note = f' (Grafikkarte nicht nutzbar: {type(e).__name__}; Prozessor)'
            dev = 'cpu'
            MODEL['m'] = _load_on(dev)
        name = ''
        if dev == 'cuda':
            try:
                name = ': ' + torch.cuda.get_device_name(0)
            except Exception:  # noqa: BLE001
                name = ''
        STATE.update(state='ready', device=dev, detail=('Bereit (GPU' + name + ')') if dev == 'cuda' else 'Bereit (Prozessor)' + note)
    except Exception as e:  # noqa: BLE001
        STATE.update(state='error', detail=f'{type(e).__name__}: {e}')


def chunks(text, limit=230):
    text = re.sub(r'\s+', ' ', text).strip()
    parts = re.split(r'(?<=[.!?…:;])\s+', text)
    out, cur = [], ''
    for p in parts:
        while len(p) > limit:
            cut = p.rfind(',', 0, limit)
            cut = cut if cut > 60 else p.rfind(' ', 0, limit)
            cut = cut if cut > 0 else limit
            piece, p = p[:cut + 1].strip(), p[cut + 1:].strip()
            if cur:
                out.append(cur)
                cur = ''
            out.append(piece)
        if len(cur) + len(p) + 1 <= limit:
            cur = (cur + ' ' + p).strip()
        else:
            if cur:
                out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return [c for c in out if re.search(r'\w', c)]


def voice_path(name):
    name = os.path.basename(str(name or ''))
    if not name:
        return None
    p = os.path.join(args.voices, name)
    return p if os.path.isfile(p) else None


class Cancelled(Exception):
    pass


def synth(text, lang, voice, my_gen):
    import numpy as np
    import soundfile as sf
    lang = lang if lang in LANGS else 'de'
    pieces = []
    sr = MODEL['m'].sr
    for c in chunks(text):
        kw = dict(language_id=lang, exaggeration=0.5, cfg_weight=0.5)
        vp = voice_path(voice)
        if vp:
            kw['audio_prompt_path'] = vp
        wav = None
        for attempt in (1, 2):
            if GEN['n'] != my_gen:
                raise Cancelled()
            try:
                with LOCK:
                    if GEN['n'] != my_gen:
                        raise Cancelled()
                    wav = MODEL['m'].generate(c, **kw)
                break
            except Cancelled:
                raise
            except RuntimeError as e:
                # Zu wenig Grafikspeicher (z. B. weil Ollama ihn belegt): auf den Prozessor wechseln
                if attempt == 1 and 'out of memory' in str(e).lower() and STATE.get('device') == 'cuda':
                    with LOCK:
                        MODEL['m'] = None
                        try:
                            import gc
                            import torch
                            gc.collect()
                            torch.cuda.empty_cache()
                        except Exception:  # noqa: BLE001
                            pass
                        load_model(force_cpu=True)
                        if STATE['state'] != 'ready':
                            raise
                    continue
                raise
        a = wav.squeeze().detach().cpu().numpy() if hasattr(wav, 'detach') else np.asarray(wav).squeeze()
        pieces.append(a.astype('float32'))
        pieces.append(np.zeros(int(sr * 0.12), dtype='float32'))
    audio = np.concatenate(pieces) if pieces else np.zeros(int(sr * 0.2), dtype='float32')
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format='WAV', subtype='PCM_16')
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):  # ruhig bleiben
        pass

    def _send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == '/':
            return self._send(200, {'ok': True})
        if self.path == '/status':
            return self._send(200, STATE)
        if self.path in ('/v1/audio/voices', '/voices'):
            try:
                names = sorted(f for f in os.listdir(args.voices) if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg')))
            except OSError:
                names = []
            return self._send(200, {'voices': names})
        return self._send(404, {'error': 'nicht gefunden'})

    def do_POST(self):  # noqa: N802
        if self.path == '/cancel':
            GEN['n'] += 1
            return self._send(200, {'ok': True})
        if self.path != '/v1/audio/speech':
            return self._send(404, {'error': 'nicht gefunden'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
        except Exception:  # noqa: BLE001
            return self._send(400, {'error': 'Ungültige Anfrage'})
        text = str(req.get('input') or '').strip()
        if not text:
            return self._send(400, {'error': 'Kein Text'})
        my_gen = GEN['n']
        t0 = time.time()
        while STATE['state'] == 'loading' and time.time() - t0 < 100:
            time.sleep(0.5)
        if STATE['state'] != 'ready':
            return self._send(503, {'error': STATE['detail']})
        try:
            wav = synth(text, str(req.get('language') or 'de')[:2].lower(), req.get('voice'), my_gen)
        except Cancelled:
            return self._send(499, {'error': 'abgebrochen'})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {'error': f'{type(e).__name__}: {e}'})
        return self._send(200, wav, 'audio/wav')


if __name__ == '__main__':
    os.makedirs(args.voices, exist_ok=True)
    threading.Thread(target=load_model, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()
