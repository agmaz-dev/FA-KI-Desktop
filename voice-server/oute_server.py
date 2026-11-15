"""Lokaler Stimmen-Server für FA KI Desktop (OuteTTS 1.0, 0.6B, Q8) – schnelle Alternative zu Chatterbox.

Gleiche Schnittstelle wie voice_server.py (OpenAI-kompatibel), läuft nur auf 127.0.0.1.
Das Sprachmodell läuft in einem eigenen llama-server (Vulkan = AMD-Grafikkarte, sonst Prozessor),
dieses Skript macht Text -> Tokens -> Audio (OuteTTS-Bibliothek) und die Stimmprobe (Klonen).
Deutsch ist trainiert, Türkisch nicht: dafür antwortet der Server mit 501, die App nimmt dann Piper.
"""
import argparse
import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=8004)
ap.add_argument('--voices', default='voices')
ap.add_argument('--cache', default='')
ap.add_argument('--llama', required=True, help='Pfad zu llama-server.exe')
ap.add_argument('--gguf', required=True, help='Pfad zur OuteTTS-GGUF-Datei')
ap.add_argument('--llama-port', type=int, default=8081)
ap.add_argument('--whisper', default='base', help='Whisper-Modell für die Stimmprobe (einmalig)')
args = ap.parse_args()

if args.cache:
    os.makedirs(args.cache, exist_ok=True)
    os.environ.setdefault('HF_HOME', args.cache)
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

STATE = {'state': 'loading', 'detail': 'Modell wird gestartet …', 'device': '', 'langs': ['de']}
IFACE = {'i': None, 'proc': None}
SPEAKERS = {}
LOCK = threading.Lock()
GEN = {'n': 0}
LLAMA_URL = f'http://127.0.0.1:{args.llama_port}'
TOKENIZER = 'OuteAI/OuteTTS-1.0-0.6B'


class Cancelled(Exception):
    pass


def _health(timeout=2):
    try:
        with urllib.request.urlopen(LLAMA_URL + '/health', timeout=timeout) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def _start_llama(ngl):
    cmd = [args.llama, '-m', args.gguf, '-c', '4096', '-ngl', str(ngl), '--host', '127.0.0.1', '--port', str(args.llama_port)]
    flags = 0x08000000 if os.name == 'nt' else 0  # CREATE_NO_WINDOW
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags, cwd=os.path.dirname(args.llama))
    t0 = time.time()
    while time.time() - t0 < 180:
        if proc.poll() is not None:
            return None
        if _health():
            return proc
        time.sleep(1)
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass
    return None


def _stop_llama():
    p = IFACE.get('proc')
    if p and p.poll() is None:
        try:
            p.kill()
        except Exception:  # noqa: BLE001
            pass


def _patch_whisper():
    """openai-whisper ruft sonst ffmpeg auf (unter Windows nicht vorhanden): Audio selbst laden."""
    import numpy as np
    import soundfile as sf
    import outetts.version.v3.audio_processor as ap3

    def transcribe_word_level(audio_path, model='base', device=None, language=None):
        import torch
        import torchaudio
        import whisper
        data, sr = sf.read(audio_path, dtype='float32', always_2d=True)
        mono = torch.from_numpy(data.mean(axis=1))
        if sr != 16000:
            mono = torchaudio.functional.resample(mono, sr, 16000)
        arr = mono.numpy().astype(np.float32)
        m = whisper.load_model(model, device=device or 'cpu')
        return m.transcribe(arr, word_timestamps=True, language=language or 'de', fp16=False)

    ap3.transcribe_once_word_level = transcribe_word_level


def load_model():
    try:
        STATE.update(state='loading', detail='Sprachmodell wird gestartet …')
        proc = _start_llama(99)
        device = 'gpu'
        note = ''
        if proc is None:
            _stop_llama()
            note = ' (Grafikkarte nicht nutzbar, Prozessor)'
            STATE.update(detail='Grafikkarte startet nicht, Prozessor wird versucht …')
            proc = _start_llama(0)
            device = 'cpu'
        if proc is None:
            raise RuntimeError('llama-server startet nicht (weder Grafikkarte noch Prozessor).')
        IFACE['proc'] = proc

        STATE.update(detail='Audio-Teil wird geladen (beim ersten Mal Download) …')
        import outetts
        from outetts import Backend, Interface, InterfaceVersion, ModelConfig
        _patch_whisper()
        cfg = ModelConfig(
            model_path=args.gguf, tokenizer_path=TOKENIZER, interface_version=InterfaceVersion.V3,
            backend=Backend.LLAMACPP_SERVER, device='cpu', max_seq_length=4096,
        )
        IFACE['i'] = Interface(cfg)
        STATE.update(state='ready', device=device, detail=f'Bereit (OuteTTS, {"Grafikkarte" if device == "gpu" else "Prozessor"}){note}')
    except Exception as e:  # noqa: BLE001
        STATE.update(state='error', detail=f'{type(e).__name__}: {e}')


def voice_path(name):
    name = os.path.basename(str(name or ''))
    if not name:
        return None
    p = os.path.join(args.voices, name)
    return p if os.path.isfile(p) else None


def get_speaker(voice):
    """Stimmprofil aus der Aufnahme (einmalig, dauert; danach als .oute.json gespeichert)."""
    vp = voice_path(voice)
    if not vp:
        raise RuntimeError('Stimmprobe nicht gefunden – bitte in den Einstellungen eine Aufnahme wählen.')
    if vp in SPEAKERS:
        return SPEAKERS[vp]
    prof = vp + '.oute.json'
    iface = IFACE['i']
    if os.path.isfile(prof):
        sp = iface.load_speaker(prof)
    else:
        STATE['detail'] = 'Stimmprofil wird aus Deiner Aufnahme erstellt (einmalig) …'
        sp = iface.create_speaker(vp, whisper_model=args.whisper)
        iface.save_speaker(sp, prof)
        STATE['detail'] = f'Bereit (OuteTTS, {"Grafikkarte" if STATE["device"] == "gpu" else "Prozessor"})'
    SPEAKERS[vp] = sp
    return sp


def synth(text, voice, my_gen):
    import numpy as np
    import soundfile as sf
    from outetts import GenerationConfig, GenerationType, SamplerConfig
    if GEN['n'] != my_gen:
        raise Cancelled()
    with LOCK:
        if GEN['n'] != my_gen:
            raise Cancelled()
        iface = IFACE['i']
        sp = get_speaker(voice)
        out = iface.generate(GenerationConfig(
            text=text, speaker=sp, generation_type=GenerationType.CHUNKED,
            sampler_config=SamplerConfig(temperature=0.4), max_length=4096, server_host=LLAMA_URL,
        ))
    if out is None or getattr(out, 'audio', None) is None:
        raise RuntimeError('Es wurde kein Audio erzeugt.')
    a = out.audio.detach().cpu().float().numpy().squeeze()
    buf = io.BytesIO()
    sf.write(buf, a.astype('float32'), int(out.sr), format='WAV', subtype='PCM_16')
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
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
        lang = str(req.get('language') or 'de')[:2].lower()
        if lang == 'tr':
            return self._send(501, {'error': 'Türkisch wird von OuteTTS nicht unterstützt'})
        my_gen = GEN['n']
        t0 = time.time()
        while STATE['state'] == 'loading' and time.time() - t0 < 1500:
            time.sleep(0.5)
        if STATE['state'] != 'ready':
            return self._send(503, {'error': STATE['detail']})
        try:
            wav = synth(text, req.get('voice'), my_gen)
        except Cancelled:
            return self._send(499, {'error': 'abgebrochen'})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {'error': f'{type(e).__name__}: {e}'})
        return self._send(200, wav, 'audio/wav')


if __name__ == '__main__':
    os.makedirs(args.voices, exist_ok=True)
    threading.Thread(target=load_model, daemon=True).start()
    try:
        ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()
    finally:
        _stop_llama()
