"""Isolated process for MinerU's pinned Python API (no nested HTTP server)."""
import sys
from pathlib import Path
from mineru.cli.common import do_parse

if __name__ == '__main__':
    do_parse(output_dir=sys.argv[2], pdf_file_names=['source'],
             pdf_bytes_list=[Path(sys.argv[1]).read_bytes()], p_lang_list=['ch'],
             backend='pipeline', parse_method='auto', formula_enable=False, table_enable=True,
             f_draw_layout_bbox=False, f_draw_span_bbox=False, f_dump_orig_pdf=False,
             f_dump_model_output=False)
