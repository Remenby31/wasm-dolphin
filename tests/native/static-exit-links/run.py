"""Run all repository static-link native fixtures in a caller-owned temporary directory."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--work', required=True)
parser.add_argument('--compiler', required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
work = Path(args.work).resolve()
assets = Path(__file__).resolve().parent
assert work.is_dir() and not any(work.iterdir()), 'Use a new empty temporary directory'
assert work != assets, 'Never generate executable artifacts inside committed fixture assets'
source = root / 'vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter'
assert (source / 'CachedInterpreterLink.h').is_file(), 'Promoted static-link header missing'
assert 'void BeginBlock(' in (source / 'CachedInterpreterLink.h').read_text(encoding='utf8'), 'Promoted lean BeginBlock API missing'

allowed = lambda path: path.suffix in ('.py', '.inc', '.h') or path.name.endswith('.template.cpp') or path.name in ('test-header.cpp', 'cases.json')
for path in assets.iterdir():
    if path.is_file() and allowed(path): shutil.copyfile(path, work / path.name)

environment = os.environ.copy()
environment['DOLPHIN_STATIC_LINK_TEST_ROOT'] = str(root)
environment['DOLPHIN_STATIC_LINK_TEST_CXX'] = args.compiler
ppc = source.parent
input_paths = [path for path in source.glob('CachedInterpreter*') if path.is_file()] + [
    source / 'WasmDeferredCompileQueue.h', ppc / 'JitCommon/JitCache.cpp',
    ppc / 'JitCommon/JitCache.h', ppc / 'JitInterface.cpp', ppc / 'Gekko.h',
]
inputs = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in input_paths}
for name in ['extract-base.py', 'run-header.py', 'build-gates.py', 'build-stats.py']:
    execution = subprocess.run([sys.executable, str(work / name)], cwd=root, env=environment,
                               capture_output=True, text=True, timeout=450)
    (work / (name + '.output.log')).write_text(execution.stdout + execution.stderr, encoding='utf8')
    if execution.returncode:
        print(execution.stdout + execution.stderr, file=sys.stderr)
        raise SystemExit(execution.returncode)

expected = json.loads((work / 'cases.json').read_text(encoding='utf8'))
phases = []
for name in ['header', 'cache', 'callbacks', 'helpers', 'gates', 'stats']:
    report = json.loads((work / (name + '-result.json')).read_text(encoding='utf8'))
    assert report['exitCode'] == 0 and not report['results']['failed'], 'Native phase failed: ' + name
    assert sorted(report['results']['passed']) == sorted(expected[name]), 'Required native groups changed or disappeared: ' + name
    phases.append({'phase': name, 'groups': report['results']['passed']})
callback_report = json.loads((work / 'callbacks-result.json').read_text(encoding='utf8'))
assert callback_report['referenceMode'] == 'explicit macro-0 view of actual promoted vendor source'
assert callback_report['referenceViewSha256'] != callback_report['candidateViewSha256'], 'Differential reference aliases enabled candidate'
for path, digest in inputs.items():
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'Promoted source changed during tests: ' + str(path)
result = {
    'passingGroups': sum(len(phase['groups']) for phase in phases), 'phases': phases,
    'source': str(source), 'sourceSha256': hashlib.sha256((source / 'CachedInterpreter.cpp').read_bytes()).hexdigest(),
    'headerSha256': hashlib.sha256((source / 'CachedInterpreterLink.h').read_bytes()).hexdigest(),
    'referenceMode': callback_report['referenceMode'],
    'referenceViewSha256': callback_report['referenceViewSha256'],
    'candidateViewSha256': callback_report['candidateViewSha256'],
}
assert result['passingGroups'] == 49, 'All 49 required native groups must run'
(work / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
print(json.dumps(result))
