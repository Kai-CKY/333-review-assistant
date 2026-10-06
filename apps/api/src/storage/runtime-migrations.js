// Column names are fixed here. Snapshot JSON retains provider evidence and optional metadata.
export const ledgerColumns={
  model_requests:{model:['model','TEXT'],api:['api','TEXT'],key_alias:['key','TEXT'],key_resource_id:['keyResourceId','TEXT'],step:['step','TEXT'],response_id:['responseId','TEXT'],input_tokens:['input','INTEGER'],cached_tokens:['cached','INTEGER'],output_tokens:['output','INTEGER'],reasoning_tokens:['reasoning','INTEGER'],nano_cost:['nanoCost','INTEGER'],price_version:['priceVersion','TEXT'],usage_status:['usageStatus','TEXT'],business_status:['businessStatus','TEXT'],ended_at:['endedAt','TEXT'],attempt_id:['attemptId','TEXT'],scope_key:['scopeKey','TEXT'],operation_id:['operationId','TEXT']},
  model_price_versions:{model:['model','TEXT'],tier:['tier','TEXT'],input_price:['input','REAL'],cached_price:['cached','REAL'],output_price:['output','REAL'],effective_from:['effectiveFrom','TEXT'],source:['source','TEXT']},
  cost_budget_settings:{daily:['daily','REAL'],monthly:['monthly','REAL'],version:['version','INTEGER'],policy:['policy','TEXT'],actor_id:['actorId','TEXT']},
  cost_budget_alerts:{period:['period','TEXT'],prefix:['prefix','TEXT'],version:['version','INTEGER'],threshold:['threshold','INTEGER'],nano_cost:['nanoCost','INTEGER']},
  cost_official_statements:{key_alias:['key','TEXT'],from_day:['from','TEXT'],to_day:['to','TEXT'],paid_yuan:['paidYuan','REAL'],tokens:['tokens','INTEGER'],source_hash:['sourceHash','TEXT'],actor_id:['actorId','TEXT']},
  management_operations:{kind:['kind','TEXT'],actor_id:['actorId','TEXT'],chat_id:['chatId','TEXT'],scope_key:['scopeKey','TEXT'],session_id:['sessionId','TEXT'],message_id:['messageId','TEXT'],request_id:['requestId','TEXT'],fingerprint:['fingerprint','TEXT'],execution_source:['executionSource','TEXT'],occurred_at:['occurredAt','TEXT'],recorded_at:['recordedAt','TEXT'],verification:['verification','TEXT']}
};
export function migrateRuntime(db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);`);
    for (const table of ['model_requests','model_price_versions','cost_budget_settings','cost_budget_alerts','cost_official_statements','management_operations']) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,environment TEXT,task_id TEXT,purpose TEXT,status TEXT,record_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ${table}_scope ON ${table}(environment,created_at);
        CREATE INDEX IF NOT EXISTS ${table}_task ON ${table}(task_id);`);
    }
    const add = (table, columns) => {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
      if (!existing.size) return;
      for (const [name,type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    add('review_logs',[['reviewed_at','TEXT'],['recorded_at','TEXT'],['attempt_id','TEXT']]);
    add('answer_attempts',[['submitted_at','TEXT'],['actor_id','TEXT']]);
    for(const [table,columns] of Object.entries(ledgerColumns)){
      const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
      for(const [name,[field,type]] of Object.entries(columns))if(!existing.has(name)){
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        db.prepare(`UPDATE ${table} SET ${name}=json_extract(record_json,?)`).run('$.'+field);
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS model_requests_key ON model_requests(key_alias,environment,created_at); CREATE INDEX IF NOT EXISTS management_operations_scope ON management_operations(scope_key,created_at)');
    db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?,?,?)').run(2026100601,'management-cost-review',new Date().toISOString());
  }).immediate();
}
