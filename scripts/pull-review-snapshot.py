"""Read-only production snapshot to this machine; never exports service secrets."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
from datetime import datetime, timezone, timedelta

REMOTE = r'''
import pathlib,json,subprocess,tarfile,io,hashlib,datetime,sys
root=pathlib.Path('/www/wwwroot/333-review-assistant/runtime-data')
files={}
for p in sorted(root.rglob('*')):
    if p.is_symlink(): raise RuntimeError('snapshot refuses symbolic links')
    if p.is_file(): files[str(p.relative_to(root))]=p.read_bytes()
inspect=json.loads(subprocess.check_output(['docker','inspect','333-review-assistant-app-1']))[0]
env=dict(x.split('=',1) for x in inspect['Config']['Env'] if '=' in x)
metadata={'environment':'production','capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'worktreeRevision':subprocess.check_output(['git','-C',str(root.parent),'rev-parse','HEAD']).decode().strip(),
 'worktreeStatus':subprocess.check_output(['git','-C',str(root.parent),'status','--porcelain']).decode(),
 'containerRevision':env.get('APP_REVISION','unknown'),'imageId':inspect['Image'],
 'identities':{'appId':env.get('FEISHU_APP_ID','333'),'ownerOpenId':env.get('FEISHU_OWNER_OPEN_ID',''),
 'learnerOpenId':env.get('FEISHU_LEARNER_OPEN_ID') or env.get('FEISHU_TESTER_OPEN_ID') or env.get('FEISHU_GROUP_TARGET_OPEN_ID','')},
 'files':[{'path':k,'bytes':len(v),'sha256':hashlib.sha256(v).hexdigest()} for k,v in files.items()]}
# A live read is accepted only if every file and the file set stayed unchanged.
if set(files)!=set(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()): raise RuntimeError('file set changed; retry snapshot')
for k,v in files.items():
    if (root/k).read_bytes()!=v: raise RuntimeError('data changed; retry snapshot')
stream=io.BytesIO()
with tarfile.open(fileobj=stream,mode='w:gz') as archive:
    for k,v in list(files.items())+[('snapshot-manifest.json',json.dumps(metadata,ensure_ascii=False,indent=2).encode())]:
        info=tarfile.TarInfo(k);info.size=len(v);info.mode=0o600;archive.addfile(info,io.BytesIO(v))
sys.stdout.buffer.write(stream.getvalue())
'''


def pull(output):
    output = Path(output).resolve()
    if output.exists():
        raise RuntimeError('Choose a new backup directory; existing files are never overwritten.')
    encoded = base64.b64encode(REMOTE.encode()).decode()
    command = f'python3 -c "import base64;exec(base64.b64decode(\'{encoded}\'))"'
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', 'review-assistant-prod', command],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace'))
    # Verify the archive and all content before writing local files.
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:gz') as archive:
        members = archive.getmembers()
        for member in members:
            parts = member.name.replace('\\', '/').split('/')
            if not member.isfile() or member.name.startswith('/') or ':' in member.name or any(p in ('', '.', '..') for p in parts):
                raise RuntimeError('Unsafe archive path')
        contents = {m.name: archive.extractfile(m).read() for m in members}
    manifest = json.loads(contents['snapshot-manifest.json'])
    for item in manifest['files']:
        value = contents[item['path']]
        if len(value) != item['bytes'] or hashlib.sha256(value).hexdigest() != item['sha256']:
            raise RuntimeError('Backup verification failed')
    output.mkdir(parents=True)
    (output / 'production-snapshot.tar.gz').write_bytes(result.stdout)
    for name, value in contents.items():
        target = output / 'original' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value)
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'backup': str(output), 'filesVerified': len(manifest['files']),
                      'archiveSha256': hashlib.sha256(result.stdout).hexdigest(),
                      'capturedAt': manifest['capturedAt']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    parser.add_argument('--output', default=f'.data/local-backups/{stamp}')
    pull(parser.parse_args().output)
