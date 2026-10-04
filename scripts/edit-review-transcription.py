"""Local candidate OCR corrections, with version checks and transactional history."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys

DDL = '''
CREATE TABLE IF NOT EXISTS upload_transcriptions(job_id TEXT PRIMARY KEY REFERENCES processing_jobs(id),title TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT,items_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS upload_transcription_versions(job_id TEXT NOT NULL REFERENCES processing_jobs(id),version INTEGER NOT NULL,title TEXT NOT NULL,edited_at TEXT NOT NULL,actor TEXT NOT NULL,items_json TEXT NOT NULL,PRIMARY KEY(job_id,version));
'''


def connect(candidate):
    db = sqlite3.connect(candidate / 'review-candidate.sqlite')
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(DDL)
    return db


def export(candidate, db):
    report_file = candidate / 'migration-report.json'
    report = json.loads(report_file.read_text(encoding='utf-8'))
    for table in [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]:
        rows = [dict(r) for r in db.execute(f'SELECT * FROM {table}')]
        for row in rows:
            for key in tuple(row):
                if key.endswith('_json') and row[key] is not None:
                    row[key[:-5]] = json.loads(row.pop(key))
        (candidate / 'tables' / f'{table}.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
        report['tableCounts'][table] = len(rows)
    report['localCorrectionVersions'] = db.execute('SELECT count(*) FROM upload_transcription_versions WHERE actor="project-admin"').fetchone()[0]
    report['candidateUpdatedAt'] = datetime.now(timezone.utc).isoformat()
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (candidate / 'schema.sql').write_text('\n'.join(r[0] + ';' for r in db.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name")), encoding='utf-8')


def seed(candidate, db):
    # Published knowledge points take priority; unsaved OCR drafts remain editable drafts.
    for job in db.execute('SELECT * FROM processing_jobs').fetchall():
        if db.execute('SELECT 1 FROM upload_transcriptions WHERE job_id=?', (job['id'],)).fetchone():
            continue
        points = db.execute('SELECT * FROM knowledge_points WHERE source_id=?', (job['id'],)).fetchall()
        version = db.execute('SELECT snapshot_json FROM draft_versions WHERE job_id=? ORDER BY version DESC LIMIT 1', (job['id'],)).fetchone()
        content = json.loads(version[0]).get('content', {}) if version else {}
        items = [{'id': p['id'], 'knowledgePointId': p['id'], 'title': p['title'], 'text': p['body'] or ''} for p in points] if points else [{'id': i.get('id', f'item-{n}'), 'knowledgePointId': None, 'title': i.get('title', ''), 'text': i.get('text', '')} for n, i in enumerate(content.get('items', []))]
        title = content.get('title') or '待转写的上传图片'
        encoded = json.dumps(items, ensure_ascii=False)
        db.execute('INSERT INTO upload_transcriptions VALUES (?,?,?,?,?)', (job['id'], title, 1, None, encoded))
        db.execute('INSERT INTO upload_transcription_versions VALUES (?,?,?,?,?,?)', (job['id'], 1, title, datetime.now(timezone.utc).isoformat(), 'migration-original', encoded))
    db.commit()
    export(candidate, db)


def save(candidate, db, body):
    job_id, title, items = body.get('jobId'), body.get('title'), body.get('items')
    if not isinstance(title, str) or not 0 < len(title.strip()) <= 200 or not isinstance(items, list) or len(items) > 200:
        raise ValueError('invalid_transcription')
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('title'), str) or not item['title'].strip() or len(item['title']) > 200 or not isinstance(item.get('text'), str) or len(item['text']) > 30000:
            raise ValueError('invalid_item')
    if len({i.get('id') for i in items}) != len(items) or any(not isinstance(i.get('id'), str) for i in items):
        raise ValueError('invalid_item_ids')
    with db:
        current = db.execute('SELECT * FROM upload_transcriptions WHERE job_id=?', (job_id,)).fetchone()
        if not current: raise ValueError('unknown_upload')
        if body.get('expectedVersion') != current['version']: raise ValueError('version_conflict')
        old = json.loads(current['items_json'])
        old_ids = {i['id'] for i in old}
        if old_ids - {i['id'] for i in items}: raise ValueError('correction_cannot_delete_items')
        old_refs = {i['id']: i.get('knowledgePointId') for i in old}
        for item in items:
            if item.get('knowledgePointId') != old_refs.get(item['id']): raise ValueError('point_binding_changed')
        if title.strip() == current['title'] and items == old:
            return {'version': current['version'], 'saved': True, 'unchanged': True}
        version, now = current['version'] + 1, datetime.now(timezone.utc).isoformat()
        payload = json.dumps(items, ensure_ascii=False)
        db.execute('UPDATE upload_transcriptions SET title=?,version=?,updated_at=?,items_json=? WHERE job_id=?', (title.strip(), version, now, payload, job_id))
        db.execute('INSERT INTO upload_transcription_versions VALUES (?,?,?,?,?,?)', (job_id, version, title.strip(), now, 'project-admin', payload))
        for item in items:
            if item.get('knowledgePointId'):
                db.execute('UPDATE knowledge_points SET title=?,body=? WHERE id=? AND source_id=?', (item['title'].strip(), item['text'], item['knowledgePointId'], job_id))
        if db.execute('PRAGMA foreign_key_check').fetchall(): raise ValueError('foreign_key_error')
    export(candidate, db)
    return {'saved': True, 'version': version, 'items': len(items), 'productionChanged': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['seed', 'save'])
    parser.add_argument('--candidate', required=True)
    args = parser.parse_args()
    candidate = Path(args.candidate).resolve()
    if not (candidate / 'migration-report.json').is_file(): raise ValueError('candidate_required')
    db = connect(candidate)
    try:
        if args.action == 'seed':
            seed(candidate, db)
            print(json.dumps({'seeded': True, 'uploads': db.execute('SELECT count(*) FROM upload_transcriptions').fetchone()[0]}))
        else:
            print(json.dumps(save(candidate, db, json.loads(sys.stdin.buffer.read().decode('utf-8')))))
    except ValueError as error:
        print(json.dumps({'error': str(error)})); sys.exit(2)
    finally:
        db.close()
