import io
import unittest
from unittest.mock import patch
from pypdf import PdfWriter
from worker import normalize, parse_pdf

class ParserTests(unittest.TestCase):
    def test_preserves_pages_tables_and_unread_regions(self):
        with patch('importlib.metadata.version', return_value='3.4.5'):
            result = normalize([
                {'page_idx': 0, 'type': 'text', 'text': '第一章', 'bbox': [10,20,30,40]},
                {'page_idx': 1, 'type': 'table', 'table_body': '<table><tr><td>课程</td><td>9</td></tr></table>'},
                {'page_idx': 1, 'type': 'image'}], 3)
        self.assertEqual([p['pageNumber'] for p in result['pages']], [1,2,3])
        self.assertEqual(result['pages'][0]['blocks'][0]['bbox'], [10,20,30,40])
        self.assertIn('课程 | 9', result['pages'][1]['blocks'][0]['plainText'])
        self.assertIn('核对', result['pages'][1]['blocks'][1]['plainText'])
        self.assertEqual(result['pages'][2]['blocks'], [])

    def test_rejects_invalid_page_and_empty_content(self):
        with self.assertRaises(ValueError): normalize([{'page_idx': 5}], 2)
        with self.assertRaises(ValueError): normalize([], 2)

    def test_rejects_encrypted_and_oversized_before_engine(self):
        writer = PdfWriter(); writer.add_blank_page(width=100, height=100); writer.encrypt('test-password')
        b = io.BytesIO(); writer.write(b)
        with self.assertRaisesRegex(ValueError, 'encrypted_pdf'): parse_pdf(b.getvalue())
        writer = PdfWriter()
        for _ in range(31): writer.add_blank_page(width=100, height=100)
        b = io.BytesIO(); writer.write(b)
        with self.assertRaisesRegex(ValueError, 'too_many_pages'): parse_pdf(b.getvalue())
        with self.assertRaisesRegex(ValueError, 'invalid_pdf'): parse_pdf(b'not pdf')

if __name__ == '__main__': unittest.main()
