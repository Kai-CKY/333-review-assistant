"""Real MinerU smoke test; synthetic data only. Runs inside the parser image."""
import io
import json
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from worker import parse_pdf

def fixture():
    stream = io.BytesIO()
    c = canvas.Canvas(stream)
    c.setFont('Helvetica', 20)
    c.drawString(60, 700, 'Curriculum standard frequency 9 year 2025')
    c.drawString(60, 650, 'TEXTCODE 739251')
    c.showPage()
    image = Image.new('RGB', (1400, 700), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=42)
    draw.text((60, 100), 'Concept map frequency 8 year 2024', font=font, fill='black')
    draw.text((60, 230), 'SCANCODE 864203', font=font, fill='black')
    c.drawImage(ImageReader(image), 40, 350, width=520, height=260)
    c.save()
    return stream.getvalue()

if __name__ == '__main__':
    result = parse_pdf(fixture())
    assert len(result['pages']) == 2
    text = ['\n'.join(b['plainText'] for b in p['blocks']) for p in result['pages']]
    assert '739251' in text[0], text
    assert '864203' in text[1], text
    print(json.dumps({'engine': result['parserName'], 'version': result['parserVersion'], 'pages': len(text), 'textPage': True, 'scanPage': True, 'text': text}))
