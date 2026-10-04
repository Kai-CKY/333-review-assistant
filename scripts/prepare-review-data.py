"""Build a LOCAL, reviewable relational candidate. Does not connect to production."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

SCHEMA = '''
PRAGMA foreign_keys=ON;
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE people(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL UNIQUE CHECK(role IN ('learner','admin')));
CREATE TABLE channel_identities(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), app_id TEXT NOT NULL, channel TEXT NOT NULL, external_id TEXT NOT NULL, UNIQUE(app_id,channel,external_id));
CREATE TABLE role_bindings(person_id TEXT PRIMARY KEY REFERENCES people(id), role TEXT NOT NULL, source TEXT NOT NULL, captured_at TEXT NOT NULL);
CREATE TABLE identity_observations(id TEXT PRIMARY KEY, person_id TEXT REFERENCES people(id), scope_id TEXT, label TEXT, evidence_kind TEXT NOT NULL, observed_at TEXT, imported_at TEXT NOT NULL, snapshot_json TEXT NOT NULL);
CREATE TABLE identity_change_events(id TEXT PRIMARY KEY, person_id TEXT REFERENCES people(id), field TEXT NOT NULL, old_value TEXT, new_value TEXT, source_event_id TEXT, occurred_at TEXT);
CREATE TABLE learner_profiles(person_id TEXT PRIMARY KEY REFERENCES people(id), exam_goal TEXT, study_stage TEXT, daily_minutes INTEGER, version TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE profile_change_events(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), field TEXT NOT NULL, occurred_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE conversation_scopes(id TEXT PRIMARY KEY, app_id TEXT, channel TEXT, chat_type TEXT, chat_id TEXT, peer_id TEXT, thread_id TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE conversation_sessions(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES conversation_scopes(id), created_at TEXT, archived_at TEXT, is_current INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
CREATE TABLE conversation_events(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversation_sessions(id), ordinal INTEGER NOT NULL, event_type TEXT NOT NULL, source_event_id TEXT, sender_id TEXT, text TEXT, assistant_text TEXT, occurred_at TEXT, snapshot_json TEXT NOT NULL, UNIQUE(session_id,ordinal));
CREATE INDEX conversation_events_session_time ON conversation_events(session_id,occurred_at);
CREATE TABLE memory_notes(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES conversation_scopes(id), text TEXT NOT NULL, source_id TEXT, status TEXT NOT NULL, created_at TEXT);
CREATE TABLE memory_note_versions(id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES memory_notes(id), version INTEGER NOT NULL, text TEXT NOT NULL, occurred_at TEXT, snapshot_json TEXT NOT NULL, UNIQUE(note_id,version));
CREATE TABLE knowledge_sources(id TEXT PRIMARY KEY, scope_id TEXT REFERENCES conversation_scopes(id), title TEXT, current_version INTEGER, created_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE knowledge_revisions(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES knowledge_sources(id), version INTEGER NOT NULL, occurred_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE source_pages(id TEXT PRIMARY KEY, source_id TEXT REFERENCES knowledge_sources(id), page_number INTEGER, asset_id TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE knowledge_points(id TEXT PRIMARY KEY, source_id TEXT REFERENCES knowledge_sources(id), scope_id TEXT REFERENCES conversation_scopes(id), title TEXT NOT NULL, body TEXT, source_version INTEGER, uploaded_at TEXT, forgotten_on TEXT, hidden INTEGER NOT NULL, origin_status TEXT NOT NULL, snapshot_json TEXT NOT NULL);
CREATE INDEX knowledge_points_scope ON knowledge_points(scope_id,uploaded_at);
CREATE TABLE knowledge_relations(id TEXT PRIMARY KEY, from_point_id TEXT NOT NULL REFERENCES knowledge_points(id), to_point_id TEXT NOT NULL REFERENCES knowledge_points(id), relation TEXT NOT NULL, snapshot_json TEXT NOT NULL);
CREATE TABLE assets(id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL);
CREATE TABLE learning_enrollments(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id), reason TEXT NOT NULL, enrolled_on TEXT, source_event_id TEXT, UNIQUE(person_id,knowledge_point_id));
CREATE TABLE study_plan_items(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), knowledge_point_id TEXT REFERENCES knowledge_points(id), kind TEXT NOT NULL, planned_on TEXT, status TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE scheduler_configs(version TEXT PRIMARY KEY, name TEXT NOT NULL, parameters_json TEXT NOT NULL, historical_version_known INTEGER NOT NULL);
CREATE TABLE review_states(person_id TEXT NOT NULL REFERENCES people(id), knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id), stage TEXT, interval_days INTEGER, next_review_on TEXT, last_reviewed_on TEXT, last_rating TEXT, pending_forgotten INTEGER NOT NULL, scheduler_version TEXT REFERENCES scheduler_configs(version), historical_scheduler_version TEXT, snapshot_json TEXT NOT NULL, PRIMARY KEY(person_id,knowledge_point_id));
CREATE INDEX review_states_due ON review_states(person_id,next_review_on);
CREATE TABLE learning_events(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), knowledge_point_id TEXT REFERENCES knowledge_points(id), event_type TEXT NOT NULL, on_date TEXT, recorded_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE review_logs(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id), rating TEXT, reviewed_on TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE answer_attempts(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), knowledge_point_id TEXT REFERENCES knowledge_points(id), answer_text TEXT, created_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE answer_feedbacks(id TEXT PRIMARY KEY, attempt_id TEXT REFERENCES answer_attempts(id), status TEXT, created_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE reference_answers(id TEXT PRIMARY KEY, knowledge_point_id TEXT NOT NULL REFERENCES knowledge_points(id), status TEXT, current_version INTEGER, snapshot_json TEXT NOT NULL);
CREATE TABLE reference_answer_versions(id TEXT PRIMARY KEY, answer_id TEXT NOT NULL REFERENCES reference_answers(id), version INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
CREATE TABLE practice_sessions(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), knowledge_point_id TEXT REFERENCES knowledge_points(id), status TEXT, created_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE task_completion_logs(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), reported_on TEXT, content TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE processing_jobs(id TEXT PRIMARY KEY, scope_id TEXT REFERENCES conversation_scopes(id), session_id TEXT REFERENCES conversation_sessions(id), job_type TEXT NOT NULL, status TEXT, created_at TEXT, source_message_id TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE job_events(id TEXT PRIMARY KEY, job_id TEXT REFERENCES processing_jobs(id), event_type TEXT NOT NULL, occurred_at TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE draft_versions(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES processing_jobs(id), version INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
CREATE TABLE context_usage_events(id TEXT PRIMARY KEY, reply_event_id TEXT REFERENCES conversation_events(id), scope_id TEXT REFERENCES conversation_scopes(id), captured_at TEXT NOT NULL, snapshot_json TEXT NOT NULL);
CREATE TABLE channel_records(id TEXT PRIMARY KEY, record_type TEXT NOT NULL, scope_key TEXT, source_key TEXT, snapshot_json TEXT NOT NULL);
CREATE TABLE migration_inventory(source_path TEXT PRIMARY KEY, target_table TEXT NOT NULL, target_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, UNIQUE(target_table,target_id));
CREATE TABLE migration_metadata(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
'''


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def stable_id(prefix, *parts):
    return prefix + '-' + hashlib.sha256(encoded(parts).encode()).hexdigest()[:24]


def prepare(backup, output):
    backup, output = Path(backup).resolve(), Path(output).resolve()
    if output.exists():
        raise RuntimeError('Choose a new candidate directory; never overwrite review data.')
    raw = (backup / 'original' / 'review-assistant.json').read_bytes()
    source = json.loads(raw)
    # The owner confirmed these eight legacy rows were generated demo content.
    removed_demo = [p['id'] for p in source.get('knowledgePoints', []) if p.get('sourceLabel') == '演示知识库']
    source['knowledgePoints'] = [p for p in source.get('knowledgePoints', []) if p['id'] not in removed_demo]
    for collection in ('reviewStates', 'memoryEvents', 'reviewLogs', 'answerAttempts', 'taskCompletionLogs'):
        source[collection] = [r for r in source.get(collection, []) if r.get('knowledgePointId') not in removed_demo]
    manifest = json.loads((backup / 'manifest.json').read_text(encoding='utf-8'))
    expected = next(f['sha256'] for f in manifest['files'] if f['path'] == 'review-assistant.json')
    if hashlib.sha256(raw).hexdigest() != expected:
        raise RuntimeError('Source snapshot differs from backup manifest')
    now = datetime.now(timezone.utc).isoformat()
    output.mkdir(parents=True)
    db = sqlite3.connect(output / 'review-candidate.sqlite')
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    checks = []
    problems = []

    def put(table, **values):
        columns = ','.join(values)
        db.execute(f'INSERT INTO {table} ({columns}) VALUES ({",".join("?" for _ in values)})', tuple(values.values()))

    def provenance(path, table, identifier, snapshot):
        digest = hashlib.sha256(encoded(snapshot).encode()).hexdigest()
        put('migration_inventory', source_path=path, target_table=table, target_id=identifier, source_sha256=digest)
        checks.append((path, table, identifier, snapshot))

    def scope_ref(key):
        return key if key in scopes else None

    def point_ref(key):
        if key and key not in point_ids:
            problems.append(f'未知知识点关联：{key}')
            return None
        return key

    learner = source['user']['id']
    bindings = manifest['identities']
    people = [{'id': learner, 'display_name': '羊羊', 'role': 'learner'},
              {'id': 'project-admin', 'display_name': '管理者', 'role': 'admin'}]
    for person in people:
        put('people', **person)
        put('role_bindings', person_id=person['id'], role=person['role'], source='captured_server_configuration', captured_at=manifest['capturedAt'])
        external = bindings.get('learnerOpenId' if person['role'] == 'learner' else 'ownerOpenId')
        if external:
            put('channel_identities', id=stable_id('identity', person['id'], bindings['appId']), person_id=person['id'], app_id=bindings['appId'], channel='feishu', external_id=external)
    user = source['user']
    put('learner_profiles', person_id=learner, exam_goal=user.get('examGoal'), study_stage=user.get('studyStage'), daily_minutes=user.get('dailyAvailableMinutes'), version=user.get('profileVersion'), snapshot_json=encoded(user))
    provenance('user', 'learner_profiles', learner, user)
    memory = source.get('agentMemory', {})
    streams = memory.get('streams', {})
    scopes = set(streams)
    for key, stream in streams.items():
        scope = stream['scope']
        put('conversation_scopes', id=key, app_id=scope.get('appId'), channel=scope.get('channel'), chat_type=scope.get('chatType'), chat_id=scope.get('chatId'), peer_id=scope.get('peerId'), thread_id=scope.get('threadId'), snapshot_json=encoded(stream))
        provenance(f'agentMemory.streams.{key}', 'conversation_scopes', key, stream)
    for sid, session in memory.get('sessions', {}).items():
        snapshot = {k: v for k, v in session.items() if k != 'events'}
        key = session['scopeKey']
        put('conversation_sessions', id=sid, scope_id=key, created_at=session.get('createdAt'), archived_at=session.get('archivedAt'), is_current=int(streams[key]['sessionId'] == sid), snapshot_json=encoded(snapshot))
        provenance(f'agentMemory.sessions.{sid}', 'conversation_sessions', sid, snapshot)
        for i, event in enumerate(session.get('events', [])):
            eid = stable_id('event', sid, i, event.get('eventId'))
            put('conversation_events', id=eid, session_id=sid, ordinal=i, event_type=event.get('type', 'unknown'), source_event_id=event.get('eventId'), sender_id=event.get('senderId'), text=event.get('text') or event.get('user'), assistant_text=event.get('assistant'), occurred_at=event.get('at'), snapshot_json=encoded(event))
            provenance(f'agentMemory.sessions.{sid}.events.{i}', 'conversation_events', eid, event)
    for key, notes in memory.get('notes', {}).items():
        for i, note in enumerate(notes):
            nid = stable_id('note', key, i)
            put('memory_notes', id=nid, scope_id=key, text=note['text'], source_id=note.get('sourceId'), status='active', created_at=note.get('at'))
            put('memory_note_versions', id=nid + '-v1', note_id=nid, version=1, text=note['text'], occurred_at=note.get('at'), snapshot_json=encoded(note))
            provenance(f'agentMemory.notes.{key}.{i}', 'memory_note_versions', nid + '-v1', note)
    photos = source.get('photoKnowledge', {})
    documents = photos.get('documents', {})
    for did, doc in documents.items():
        snapshot = {k: v for k, v in doc.items() if k != 'revisions'}
        put('knowledge_sources', id=did, scope_id=scope_ref(doc.get('scopeKey')), title=doc.get('title'), current_version=doc.get('currentVersion'), created_at=doc.get('createdAt'), snapshot_json=encoded(snapshot))
        provenance(f'photoKnowledge.documents.{did}', 'knowledge_sources', did, snapshot)
        for i, rev in enumerate(doc.get('revisions', [])):
            rid = stable_id('revision', did, i)
            put('knowledge_revisions', id=rid, source_id=did, version=rev.get('version', i + 1), occurred_at=rev.get('savedAt') or rev.get('at'), snapshot_json=encoded(rev))
            provenance(f'photoKnowledge.documents.{did}.revisions.{i}', 'knowledge_revisions', rid, rev)
    point_ids = {p['id'] for p in source.get('knowledgePoints', [])}
    for i, point in enumerate(source.get('knowledgePoints', [])):
        pid = point['id']
        did = point.get('sourceDocumentId')
        if did and did not in documents:
            problems.append(f'知识点的资料未找到：{pid}')
        put('knowledge_points', id=pid, source_id=did if did in documents else None, scope_id=scope_ref(point.get('sourceScopeKey')), title=point['title'], body=point.get('text') or point.get('recallPrompt'), source_version=point.get('sourceVersion'), uploaded_at=point.get('sourceUploadedAt'), forgotten_on=point.get('forgottenOn'), hidden=int(bool(point.get('hidden'))), origin_status='manual_upload' if point.get('sourceKind') == 'saved_knowledge' else 'legacy_unknown', snapshot_json=encoded(point))
        provenance(f'knowledgePoints.{i}', 'knowledge_points', pid, point)
        answer = point.get('reviewedAnswer')
        if answer:
            aid = stable_id('answer', pid)
            put('reference_answers', id=aid, knowledge_point_id=pid, status=answer.get('status', 'legacy_unknown'), current_version=answer.get('version', 1), snapshot_json=encoded(answer))
            put('reference_answer_versions', id=aid + '-v1', answer_id=aid, version=1, snapshot_json=encoded(answer))
    parameters = {'firstIntervals': {'again': 1, 'hard': 1, 'good': 3, 'easy': 5}, 'multipliers': {'again': 0.4, 'hard': 1.2, 'good': 2.5, 'easy': 3.8}, 'againInterval': 1}
    put('scheduler_configs', version='four-rating-v1', name='四档间隔算法', parameters_json=encoded(parameters), historical_version_known=0)
    for i, state in enumerate(source.get('reviewStates', [])):
        pid = state['knowledgePointId']
        put('review_states', person_id=learner, knowledge_point_id=pid, stage=state.get('stage'), interval_days=state.get('intervalDays'), next_review_on=state.get('nextReviewOn'), last_reviewed_on=state.get('lastReviewedOn'), last_rating=state.get('lastRating'), pending_forgotten=int(bool(state.get('pendingForgottenReview'))), scheduler_version='four-rating-v1', historical_scheduler_version=None, snapshot_json=encoded(state))
        provenance(f'reviewStates.{i}', 'review_states', pid, state)
        event = next((e for e in source.get('memoryEvents', []) if e.get('knowledgePointId') == pid), {})
        reason = 'forgotten_upload' if state.get('pendingForgottenReview') else 'legacy_review_state'
        put('learning_enrollments', id=stable_id('enrollment', learner, pid), person_id=learner, knowledge_point_id=pid, reason=reason, enrolled_on=event.get('on'), source_event_id=event.get('id'))
        # No future review logs or new study plans are invented during conversion.
    for i, event in enumerate(source.get('memoryEvents', [])):
        eid = event.get('id') or stable_id('learning', i)
        put('learning_events', id=eid, person_id=learner, knowledge_point_id=point_ref(event.get('knowledgePointId')), event_type=event.get('type', 'unknown'), on_date=event.get('on'), recorded_at=event.get('recordedAt'), snapshot_json=encoded(event))
        provenance(f'memoryEvents.{i}', 'learning_events', eid, event)
    for key, table in [('reviewLogs', 'review_logs'), ('answerAttempts', 'answer_attempts'), ('answerFeedbacks', 'answer_feedbacks'), ('taskCompletionLogs', 'task_completion_logs')]:
        for i, row in enumerate(source.get(key, [])):
            rid = row.get('id') or stable_id(table, i)
            columns = {'id': rid, 'snapshot_json': encoded(row)}
            if table != 'answer_feedbacks': columns['person_id'] = learner
            if table in ('review_logs', 'answer_attempts'): columns['knowledge_point_id'] = point_ref(row.get('knowledgePointId'))
            if table == 'review_logs': columns.update(rating=row.get('rating'), reviewed_on=row.get('reviewedOn'))
            if table == 'answer_attempts': columns.update(answer_text=row.get('answer'), created_at=row.get('createdAt'))
            if table == 'answer_feedbacks': columns.update(attempt_id=row.get('attemptId'), status=row.get('status'), created_at=row.get('createdAt'))
            if table == 'task_completion_logs': columns.update(reported_on=row.get('reportedOn'), content=row.get('content'))
            put(table, **columns)
            provenance(f'{key}.{i}', table, rid, row)
    practice = source.get('practiceSessions', {})
    for key, session in (practice.items() if isinstance(practice, dict) else enumerate(practice)):
        sid = session.get('id') or stable_id('practice', key)
        task = session.get('task', {})
        put('practice_sessions', id=sid, person_id=learner, knowledge_point_id=point_ref(task.get('knowledgePointId') or task.get('id')), status=session.get('status', 'legacy_unknown'), created_at=session.get('createdAt'), snapshot_json=encoded(session))
        provenance(f'practiceSessions.{key}', 'practice_sessions', sid, session)
    for jid, draft in photos.get('drafts', {}).items():
        snapshot = {k: v for k, v in draft.items() if k not in ('versions', 'reads', 'actions', 'assets')}
        put('processing_jobs', id=jid, scope_id=scope_ref(draft.get('scopeKey')), session_id=draft.get('sessionId'), job_type=draft.get('mode', 'photo_knowledge'), status=draft.get('status'), created_at=draft.get('createdAt'), source_message_id=draft.get('sourceMessageId'), snapshot_json=encoded(snapshot))
        provenance(f'photoKnowledge.drafts.{jid}', 'processing_jobs', jid, snapshot)
        for i, version in enumerate(draft.get('versions', [])):
            vid = stable_id('draft-version', jid, i)
            put('draft_versions', id=vid, job_id=jid, version=version.get('version', i + 1), snapshot_json=encoded(version))
            provenance(f'photoKnowledge.drafts.{jid}.versions.{i}', 'draft_versions', vid, version)
        for kind in ('reads', 'actions', 'assets'):
            for i, event in enumerate(draft.get(kind, [])):
                eid = stable_id('job-event', jid, kind, i)
                put('job_events', id=eid, job_id=jid, event_type=kind, occurred_at=event.get('at') if isinstance(event, dict) else None, snapshot_json=encoded(event))
                provenance(f'photoKnowledge.drafts.{jid}.{kind}.{i}', 'job_events', eid, event)
    for key in ('photoKnowledge.events', 'feedbackJobs', 'feishu.sessions', 'feishu.privateChats', 'feishu.conversations', 'feishu.groupCheckinPrompts'):
        value = source
        for component in key.split('.'): value = value.get(component, {})
        for i, row in enumerate(value if isinstance(value, list) else []):
            rid = stable_id('channel-record', key, i)
            put('channel_records', id=rid, record_type=key, scope_key=row.get('scopeKey'), source_key=row.get('id') or row.get('openId'), snapshot_json=encoded(row))
            provenance(f'{key}.{i}', 'channel_records', rid, row)
    for chat, group in source.get('feishu', {}).get('groupConversations', {}).items():
        for external, member in group.get('members', {}).items():
            oid = stable_id('observation', chat, external)
            person = learner if external == bindings.get('learnerOpenId') else 'project-admin' if external == bindings.get('ownerOpenId') else None
            snapshot = {'externalId': external, **member}
            put('identity_observations', id=oid, person_id=person, scope_id=None, label=member.get('label'), evidence_kind='legacy_label_source_unknown', observed_at=None, imported_at=now, snapshot_json=encoded(snapshot))
            provenance(f'feishu.groupConversations.{chat}.members.{external}', 'identity_observations', oid, snapshot)
        for i, turn in enumerate(group.get('turns', [])):
            rid = stable_id('channel-turn', chat, i)
            put('channel_records', id=rid, record_type='legacy_group_turn_cache', scope_key=chat, source_key=None, snapshot_json=encoded(turn))
            provenance(f'feishu.groupConversations.{chat}.turns.{i}', 'channel_records', rid, turn)
    asset_files = [f for f in manifest['files'] if f['path'].startswith(('knowledge-assets/', 'knowledge-library/'))]
    for file in asset_files:
        value = (backup / 'original' / file['path']).read_bytes()
        if hashlib.sha256(value).hexdigest() != file['sha256']:
            raise RuntimeError('Attachment mismatch')
        put('assets', id=stable_id('asset', file['path']), relative_path=file['path'], sha256=file['sha256'], byte_size=file['bytes'])
    metadata = {'sourceSchemaVersion': source.get('schemaVersion'), 'memoryVersion': memory.get('version'), 'photoSchemaVersion': photos.get('schemaVersion'), 'backupPath': str(backup), 'capturedAt': manifest['capturedAt'], 'sourceSha256': expected, 'status': 'LOCAL_REVIEW_CANDIDATE_NOT_ACTIVATED'}
    for key, value in metadata.items(): put('migration_metadata', key=key, value_json=encoded(value))
    put('schema_migrations', version=1, name='local-relational-review-candidate', applied_at=now)
    # Every imported entity must round-trip through its own immutable snapshot.
    for path, table, identifier, snapshot in checks:
        id_column = 'person_id' if table == 'learner_profiles' else 'knowledge_point_id' if table == 'review_states' else 'id'
        row = db.execute(f'SELECT snapshot_json FROM {table} WHERE {id_column}=?', (identifier,)).fetchone()
        if not row or json.loads(row['snapshot_json']) != snapshot:
            raise RuntimeError(f'Entity mismatch: {path}')
    integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
    foreign_keys = [tuple(r) for r in db.execute('PRAGMA foreign_key_check')]
    if integrity != 'ok' or foreign_keys or problems:
        raise RuntimeError(encoded({'integrity': integrity, 'foreignKeys': foreign_keys, 'references': problems}))
    db.commit()
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    exports = output / 'tables'
    exports.mkdir()
    counts = {}
    for table in tables:
        rows = [dict(r) for r in db.execute(f'SELECT * FROM {table}')]
        for row in rows:
            for k in tuple(row):
                if k.endswith('_json') and row[k] is not None:
                    row[k[:-5]] = json.loads(row.pop(k))
        counts[table] = len(rows)
        (exports / f'{table}.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
    db.close()
    unknown = [p['id'] for p in source['knowledgePoints'] if p.get('sourceKind') != 'saved_knowledge']
    report = {'status': metadata['status'], 'generatedAt': now, 'capturedAt': manifest['capturedAt'], 'backupPath': str(backup), 'sourceSha256': expected, 'tableCounts': counts, 'verifiedEntities': len(checks), 'integrityCheck': integrity, 'foreignKeyErrors': foreign_keys, 'assetsVerified': len(asset_files), 'retainedKnowledgePointIds': [p['id'] for p in source['knowledgePoints']], 'legacyUnknownPointIds': unknown, 'removedDemoPointIds': removed_demo, 'warnings': ['已按管理者确认删除旧示例知识点，手动上传内容为当前基准。', '10 条遗忘记录保留为待复习，不生成完成记录或自评。', '历史身份识别时间、修正记录与模型上下文加载引用未采集，不补造。', '原正式容器版本 unknown；此候选尚未接入应用仓储，不可直接部署。'], 'checks': [{'name': '手动上传知识点 ID 保留，示例点已移除', 'passed': counts['knowledge_points'] == len(source['knowledgePoints'])}, {'name': '会话消息逐条保留', 'passed': counts['conversation_events'] == sum(len(s.get('events', [])) for s in memory.get('sessions', {}).values())}, {'name': '归档与当前会话分开', 'passed': counts['conversation_sessions'] == len(memory.get('sessions', {}))}, {'name': '附件内容哈希校验', 'passed': True}, {'name': '没有新增虚构复习或自评', 'passed': counts['review_logs'] == len(source.get('reviewLogs', []))}, {'name': '每条迁移实体内容往返核验', 'passed': True}, {'name': '外键与数据库完整性', 'passed': integrity == 'ok' and not foreign_keys}]}
    (output / 'migration-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'schema.sql').write_text(SCHEMA, encoding='utf-8')
    (output / 'REVIEW.md').write_text('# 本地新版数据候选\n\n本目录尚未同步线上。原始备份位于 `' + str(backup) + '`。\n\n- SQLite：review-candidate.sqlite\n- 独立表可读导出：tables/\n- 校验与待核对说明：migration-report.json\n- 表结构：schema.sql\n\n已删除管理者确认的 8 个旧示例知识点，保留 10 个手动上传知识点；10 条遗忘状态不是完成记录。\n历史未记录的识别证据与上下文引用保持为空。\n原始备份不变，样板的本地转写校正会留存新版本。\n应用仓储、提醒发送、线上切换将在样板及数据确认后实现。\n', encoding='utf-8')
    print(json.dumps({'candidate': str(output), 'tables': len(tables), 'entitiesVerified': len(checks), 'assetsVerified': len(asset_files), 'integrity': integrity, 'foreignKeyErrors': len(foreign_keys)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    prepare(args.backup, args.output)
