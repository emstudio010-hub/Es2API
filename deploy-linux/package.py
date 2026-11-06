"""Build an allowlisted Linux distribution. Never copy runtime trees wholesale."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent
NAME = os.environ.get('ES2API_RELEASE_NAME', 'Es2API-linux-x64-20261106-r30')
STAGE = ROOT / 'build-cache' / os.environ.get('ES2API_STAGE_FOLDER', NAME)
DIST = ROOT / os.environ.get('ES2API_DIST_FOLDER', 'dist')
PAYLOAD_ROOT = ROOT / 'build-cache/payload' if (ROOT / 'build-cache/payload').exists() else ROOT / 'runtime/vm2'
NODE = 'node-v24.22.2-linux-x64'

def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(dst))

def ignore(directory, names):
    return [n for n in names if n in {'.git', 'node_modules', '.pnpm', 'dist', 'coverage', 'audit.json', '.DS_Store', '__pycache__'} or n.endswith(('.tsbuildinfo', '.log', '.sqlite', '.db', '.exe')) or (n.startswith('.env') and 'example' not in n)]

def tree(src, dst):
    shutil.copytree(str(src), str(dst), ignore=ignore)

def stage():
    if STAGE.exists():
        raise RuntimeError('Stage already exists; preserve it or use a new release name.')
    STAGE.mkdir(parents=True)
    copy(ROOT / 'build-cache/linux/es2api', STAGE / 'bin/es2api')
    copy(ROOT / 'build-cache/linux/kin-api-kernel', STAGE / 'payload/bin/kin-api-kernel')
    copy(ROOT / 'sub2api/backend/resources/model-pricing/model_prices_and_context_window.json', STAGE / 'resources/model_prices_and_context_window.json')
    for name in ['launcher.mjs', 'vm2.mjs', 'compose.yaml']:
        copy(ROOT / 'deploy-linux' / name, STAGE / 'deploy-linux' / name)
    for name in ['es2api.sh', 'install-service.sh']:
        copy(ROOT / 'deploy-linux' / name, STAGE / name)
    copy(ROOT / 'deploy-linux/README.md', STAGE / 'README.md')
    for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md']:
        if (ROOT / name).exists():
            copy(ROOT / name, STAGE / name)
    if (ROOT / 'licenses').exists():
        tree(ROOT / 'licenses', STAGE / 'licenses')
    if (ROOT / 'docs').exists():
        tree(ROOT / 'docs', STAGE / 'docs')
    tree(ROOT / 'assets', STAGE / 'assets')
    for project in ['integration', 'vm2api']:
        for name in ['package.json', 'package-lock.json']:
            copy(ROOT / project / name, STAGE / project / name)
        tree(ROOT / project / 'src', STAGE / project / 'src')
        shutil.copytree(str(ROOT / 'build-cache/deps' / project / 'node_modules'), str(STAGE / project / 'node_modules'))
    tree(ROOT / 'integration/resources', STAGE / 'integration/resources')
    # VM2 source config contains public examples; no runtime routing or slot records.
    tree(ROOT / 'vm2api/web/dist', STAGE / 'vm2api/web/dist')
    tree(ROOT / 'vm2api/scripts', STAGE / 'vm2api/scripts')
    for name in ['VERSION', 'CHANGELOG.md']:
        copy(ROOT / 'vm2api' / name, STAGE / 'vm2api' / name)
    tree(ROOT / 'vm2api/docker', STAGE / 'payload/docker')
    tree(ROOT / 'vm2api/share/wrap-cli', STAGE / 'payload/share/wrap-cli')
    tree(ROOT / 'vm2api/share/codex-cli', STAGE / 'vm2api/share/codex-cli')
    if not (STAGE / 'vm2api/share/codex-cli/linux-x64/source/bubblewrap/COPYING').is_file():
        raise RuntimeError('Missing bubblewrap license/source; run the Codex CLI installer first.')
    cli_root = STAGE / 'vm2api/share/codex-cli/linux-x64'
    cli = json.loads((cli_root / 'manifest.json').read_text(encoding='utf-8'))
    if cli['version'] != '0.155.1' or cli['platform'] != 'linux-x64':
        raise RuntimeError('Unexpected Codex CLI version/platform')
    if (cli_root / 'bin/codex').stat().st_size != cli['bytes'] or digest(cli_root / 'bin/codex') != cli['sha256'] or digest(cli_root / 'codex-resources/bwrap') != cli['bwrap_sha256']:
        raise RuntimeError('Codex CLI payload mismatch')
    payload = json.loads((ROOT / 'vm2api/deploy/payload.json').read_text(encoding='utf-8'))
    for item in payload['files']:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Invalid payload manifest path')
        src = PAYLOAD_ROOT / relative
        if src.stat().st_size != item['size'] or digest(src) != item['sha256']:
            raise RuntimeError('Pinned payload mismatch: ' + item['path'])
        copy(src, STAGE / 'payload' / relative)
    copy(ROOT / 'vm2api/deploy/payload.json', STAGE / 'payload/payload.json')
    with tarfile.open(str(ROOT / 'build-cache' / (NODE + '.tar.xz')), 'r:xz') as archive:
        for member in archive.getmembers():
            if member.name not in {NODE + '/bin/node', NODE + '/LICENSE', NODE + '/README.md'}:
                continue
            target = STAGE / 'node' / member.name[len(NODE) + 1:]
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as src, target.open('wb') as dst:
                shutil.copyfileobj(src, dst)
    for project, license_name in [('sub2api', 'Sub2API-LICENSE'), ('vm2api', 'VM2API-LICENSE'), ('vm2api/web', 'VM2API-Web-LICENSE')]:
        copy(ROOT / project / 'LICENSE', STAGE / 'licenses' / license_name)
    # Include corresponding modified source alongside compiled artifacts.
    for folder in ['backend', 'frontend']:
        tree(ROOT / 'sub2api' / folder, STAGE / 'source/sub2api' / folder)
    for folder in ['web', 'api-kernel', 'worker']:
        tree(ROOT / 'vm2api' / folder, STAGE / 'source/vm2api' / folder)
    for project in ['sub2api', 'vm2api', 'integration']:
        for name in ['README.md', 'DESIGN.md', 'LICENSE', 'CONTRACT.md']:
            src = ROOT / project / name
            if src.exists():
                copy(src, STAGE / 'source' / project / name)
    tree(ROOT / 'integration/resources', STAGE / 'source/integration/resources')
    for folder in ['src', 'test']:
        tree(ROOT / 'integration' / folder, STAGE / 'source/integration' / folder)
    for name in ['package.json', 'package-lock.json']:
        copy(ROOT / 'integration' / name, STAGE / 'source/integration' / name)
    tree(ROOT / 'deploy-linux', STAGE / 'source/deploy-linux')
    metadata = {'product': 'Es2API', 'version': os.environ.get('ES2API_RELEASE_VERSION', '2026.11.06-preview.30'), 'platform': 'linux', 'arch': 'x64', 'node': '24.22.2', 'payload_release': payload['release'], 'tests_run': False, 'contains_user_data': False, 'entrypoint': './es2api.sh', 'deployment_acceptance': 'not performed', 'google_oauth_requires_configuration': True}
    (STAGE / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print('Staged allowlisted release: ' + str(STAGE))

def archive():
    # Required compiled artifacts and dependency installs must exist before archiving.
    if not (STAGE / 'vm2api/src/lib/oauth/credential-import.mjs').is_file():
        raise RuntimeError('Missing shared OAuth import selector')
    for relative in ['node/bin/node', 'bin/es2api', 'payload/bin/kin-api-kernel', 'integration/node_modules/ws/package.json', 'vm2api/node_modules/ws/package.json', 'vm2api/web/dist/index.html', 'integration/resources/modeltrace/PROVENANCE.md', 'vm2api/share/codex-cli/linux-x64/bin/codex', 'vm2api/share/codex-cli/linux-x64/codex-resources/bwrap', 'vm2api/share/codex-cli/linux-x64/LICENSE', 'vm2api/share/codex-cli/linux-x64/manifest.json']:
        if not (STAGE / relative).is_file():
            raise RuntimeError('Missing distribution component: ' + relative)
    jose = STAGE / 'vm2api/node_modules/jose'
    if not (jose / 'LICENSE.md').is_file() or json.loads((jose / 'package.json').read_text(encoding='utf-8'))['version'] != '6.2.15':
        raise RuntimeError('Missing pinned identity verifier or license')
    undici = STAGE / 'integration/node_modules/undici'
    if not (undici / 'LICENSE').is_file() or json.loads((undici / 'package.json').read_text(encoding='utf-8'))['version'] != '8.12.3':
        raise RuntimeError('Missing pinned gateway HTTP transport or license')
    files = sorted(p for p in STAGE.rglob('*') if p.is_file() and p != STAGE / 'SHA256SUMS')
    if any(p.suffix in {'.sqlite', '.db'} or p.name in {'local-secrets.json', 'linux-secrets.json', 'linux-config.json'} or p.relative_to(STAGE).parts[0] == 'runtime' for p in files):
        raise RuntimeError('Unexpected private runtime data in distribution')
    (STAGE / 'SHA256SUMS').write_text(''.join(digest(p) + '  ' + p.relative_to(STAGE).as_posix() + '\n' for p in files), encoding='utf-8')
    DIST.mkdir(parents=True, exist_ok=True)
    target = DIST / (NAME + '.tar.gz')
    if target.exists():
        raise RuntimeError('Refusing to overwrite existing release archive')
    def metadata(info):
        info.uid = info.gid = 0
        info.uname = info.gname = 'root'
        relative = info.name[len(NAME) + 1:]
        executable = relative in {'bin/es2api', 'node/bin/node', 'es2api.sh', 'install-service.sh', 'vm2api/share/codex-cli/linux-x64/bin/codex', 'vm2api/share/codex-cli/linux-x64/codex-resources/bwrap'} or relative.startswith('payload/bin/') or (relative.startswith('payload/share/') and not relative.endswith('.json'))
        info.mode = 0o755 if info.isdir() or executable or relative.endswith('.sh') else 0o644
        return info
    with tarfile.open(str(target), 'w:gz', compresslevel=6) as tar:
        tar.add(str(STAGE), arcname=NAME, filter=metadata)
    sha = digest(target)
    (DIST / (target.name + '.sha256')).write_text(sha + '  ' + target.name + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(target), 'bytes': target.stat().st_size, 'sha256': sha, 'files': len(files) + 1}))

if __name__ == '__main__':
    {'stage': stage, 'archive': archive}[sys.argv[1]]()
