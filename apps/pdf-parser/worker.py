"""Private single-worker adapter for the pinned MinerU pipeline, not an LLM API."""
import base64
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from pypdf import PdfReader

LIMIT = 10 * 1024 * 1024
LOCK = threading.Lock()


class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []
    def handle_data(self, data):
        self.parts.append(data)
    def handle_endtag(self, tag):
        if tag in ('tr', 'p', 'div'): self.parts.append('\n')
        elif tag in ('td', 'th'): self.parts.append(' | ')


def normalize(content, page_count):
    pages = [{'pageNumber': i + 1, 'blocks': []} for i in range(page_count)]
    for index, item in enumerate(content):
        page = item.get('page_idx')
        if not isinstance(page, int) or page < 0 or page >= page_count:
            raise ValueError('invalid_output_page')
        kind = item.get('type', 'text')
        pieces = [item.get('text', ''), item.get('content', ''), item.get('code_body', '')]
        for key in ('table_caption', 'table_footnote', 'image_caption', 'image_footnote', 'chart_caption', 'chart_footnote', 'code_caption', 'code_footnote', 'list_items'):
            value = item.get(key, [])
            pieces.extend(value if isinstance(value, list) else [value])
        if item.get('table_body'):
            html = Text(); html.feed(item['table_body']); pieces.append(''.join(html.parts))
        plain = '\n'.join(p for p in pieces if isinstance(p, str) and p.strip())
        if not plain.strip() and kind in ('image', 'table', 'chart'):
            plain = '【此页有图片或表格区域，未得到可读文字，请对照原 PDF 人工核对。】'
        if plain.strip():
            pages[page]['blocks'].append({'blockId': f'p{page+1}-b{index+1}', 'type': kind,
                'plainText': plain, 'markdown': item.get('table_body') or plain,
                'bbox': item.get('bbox'), 'confidence': None})
    if not any(p['blocks'] for p in pages): raise ValueError('empty_output')
    return {'parserName': 'mineru', 'parserVersion': importlib.metadata.version('mineru'), 'bboxUnits': 'normalized_0_1000', 'pages': pages,
            'warnings': ['转写结果需人工核对；空白页或未识读区域不得视为完整识别。']}


def parse_pdf(raw):
    if len(raw) > LIMIT or not raw.startswith(b'%PDF-'): raise ValueError('invalid_pdf')
    with tempfile.TemporaryDirectory(prefix='333-pdf-') as temp:
        root = Path(temp); source = root / 'source.pdf'; source.write_bytes(raw)
        try:
            reader = PdfReader(source)
            if reader.is_encrypted: raise ValueError('encrypted_pdf')
            pages = len(reader.pages)
            if pages > 30: raise ValueError('too_many_pages')
            if pages < 1: raise ValueError('invalid_pdf')
        except ValueError: raise
        except Exception: raise ValueError('invalid_pdf') from None
        output = root / 'output'
        cmd = [sys.executable, str(Path(__file__).with_name('engine.py')), str(source), str(output)]
        # All output is temporary; no user-controlled path or shell interpolation.
        with open(root / 'engine.log', 'wb') as log:
            process = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=os.name != 'nt', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            try: code = process.wait(timeout=1200)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
                else: os.killpg(process.pid, signal.SIGKILL)
                process.wait(); raise ValueError('parser_timeout') from None
        if code:
            # Do not log user document text. Detailed engine logs stay in the temporary directory.
            print(f'MinerU process failed with exit code {code}', flush=True)
            raise ValueError('parser_failed')
        files = list(output.rglob('*_content_list.json'))
        if len(files) != 1: raise ValueError('missing_output')
        result = normalize(json.loads(files[0].read_text(encoding='utf-8')), pages)
        if len(json.dumps(result, ensure_ascii=False)) > 4_000_000: raise ValueError('output_too_large')
        return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers()
        try: self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_GET(self):
        if self.path != '/health': return self.reply(404, {'error': 'not_found'})
        self.reply(200, {'ready': True, 'engine': 'mineru', 'version': importlib.metadata.version('mineru'), 'busy': LOCK.locked()})
    def do_POST(self):
        if self.path != '/parse': return self.reply(404, {'error': 'not_found'})
        if not LOCK.acquire(blocking=False): return self.reply(429, {'error': 'parser_busy'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= LIMIT * 4 // 3 + 100: return self.reply(413, {'error': 'too_large'})
            self.connection.settimeout(30)
            body = json.loads(self.rfile.read(length))
            raw = base64.b64decode(body['base64'], validate=True)
            result = parse_pdf(raw)
            self.reply(200, result)
        except ValueError as e:
            code = str(e)
            self.reply(422, {'error': code if code in {'invalid_pdf', 'encrypted_pdf', 'too_many_pages', 'parser_timeout'} else 'parser_failed'})
        except Exception:
            self.reply(500, {'error': 'parser_failed'})
        finally: LOCK.release()


if __name__ == '__main__':
    ThreadingHTTPServer((os.getenv('PDF_BIND', '0.0.0.0'), int(os.getenv('PDF_PORT', '8010'))), Handler).serve_forever()
