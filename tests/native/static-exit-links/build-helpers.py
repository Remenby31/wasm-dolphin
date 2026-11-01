from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json
import runpy
import subprocess

OWN = Path(__file__).resolve().parent
utilities = runpy.run_path(str(OWN / 'build-callbacks.py'))
candidate, header, original, original_header, disasm = (utilities[k] for k in ('candidate', 'header', 'original', 'original_header', 'disasm'))
function, structure = utilities['function'], utilities['structure']
source = (OWN / 'callbacks.cpp').read_text(encoding='utf8').replace('int main()\n', 'int CallbackFixtureMain()\n')
extra = (OWN / 'helper.template.cpp').read_text(encoding='utf8')
cpp = OWN / 'helpers.cpp'; cpp.write_text(source + '\n' + extra, encoding='utf8')
build = subprocess.run([COMPILER, '-std=c++20', '-O2', *NATIVE_FLAGS, '-Wall', '-Wextra',
    '-DDOLPHIN_WEB_STATIC_EXIT_LINKS=1', str(cpp), '-o', str(OWN / 'helpers.exe')], capture_output=True, text=True, timeout=60)
(OWN / 'helpers-build.log').write_text(build.stdout + build.stderr, encoding='utf8')
if build.returncode: print(build.stdout + build.stderr)
build.check_returncode()
run = subprocess.run([str(OWN / 'helpers.exe')], capture_output=True, text=True, timeout=30)
(OWN / 'helpers-run.log').write_text(run.stdout + run.stderr, encoding='utf8')
report = {'sourceSha256': hashlib.sha256((SOURCE / 'CachedInterpreter.cpp').read_bytes()).hexdigest(),
          'exitCode': run.returncode, 'results': json.loads(run.stdout) if run.stdout.startswith('{') else run.stdout,
          'scope': 'Actual terminal callbacks (native EndBlock, RunWasmBlock) invoked directly, without an execution context.',
          'adapters': 'None beyond the callbacks fixture.'}
(OWN / 'helpers-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2)); run.check_returncode()
