import os
import shutil
import sys
from pathlib import Path

production = Path('/www/wwwroot/333-review-assistant/.env.local')
staging = Path('/www/wwwroot/333-review-assistant-staging/.env.staging.local')
backup_dir = Path('/root/.333-review-ops')
backup = backup_dir / 'production-env-before-group-test-20261001'
group_id = 'oc_7db22a9c09c82f077f554dc4601db9cf'


def updated(path, changes):
    lines = path.read_text(encoding='utf-8').splitlines()
    found = {key: 0 for key in changes}
    output = []
    for line in lines:
        key = line.split('=', 1)[0]
        if key in changes:
            found[key] += 1
            output.append(key + '=' + changes[key])
        else:
            output.append(line)
    if any(count > 1 for count in found.values()):
        raise RuntimeError('Duplicate configuration keys')
    output.extend(key + '=' + changes[key] for key, count in found.items() if not count)
    temporary = path.with_name(path.name + '.switch-tmp')
    temporary.write_text('\n'.join(output) + '\n', encoding='utf-8')
    temporary.chmod(0o600)
    os.replace(str(temporary), str(path))


def enabled(path):
    return [line for line in path.read_text(encoding='utf-8').splitlines() if line.startswith('FEISHU_ENABLED=')]


mode = sys.argv[1]
if mode == 'prepare':
    if backup.exists() and backup.read_bytes() != production.read_bytes():
        raise SystemExit('Production environment differs from saved original; refusing to overwrite')
    staging_text = staging.read_text(encoding='utf-8')
    if not all(staging_text.find(key + '=') >= 0 for key in ('FEISHU_APP_ID', 'FEISHU_APP_SECRET')):
        raise SystemExit('Staging Feishu credentials missing')
    if not backup.exists():
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        shutil.copy2(str(production), str(backup))
        backup.chmod(0o600)
    updated(production, {'FEISHU_ENABLED': 'false'})
    updated(staging, {
        'FEISHU_ENABLED': 'true',
        'FEISHU_GROUP_CHAT_ENABLED': 'true',
        'FEISHU_GROUP_TEST_ENABLED': 'false',
        'FEISHU_TEST_GROUP_ID': group_id,
        'FEISHU_DM_MODE': 'disabled',
    })
    print('Prepared group-test environment; production Feishu disabled in configuration.')
elif mode == 'restore':
    if not backup.exists():
        raise SystemExit('Production environment backup missing')
    updated(staging, {'FEISHU_ENABLED': 'false', 'FEISHU_GROUP_CHAT_ENABLED': 'false'})
    temporary = production.with_name(production.name + '.restore-tmp')
    shutil.copy2(str(backup), str(temporary))
    os.replace(str(temporary), str(production))
    print('Restored production Feishu configuration; staging disabled in configuration.')
else:
    raise SystemExit('usage: switch_feishu_group_test.py prepare|restore')
