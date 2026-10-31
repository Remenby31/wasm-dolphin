from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json
import re
import runpy
import subprocess

OWN = Path(__file__).resolve().parent
utilities = runpy.run_path(str(OWN / 'build-callbacks.py'))
candidate, header, original, original_header, disasm = (utilities[k] for k in ('candidate', 'header', 'original', 'original_header', 'disasm'))
function, structure = utilities['function'], utilities['structure']
source = (OWN / 'callbacks.cpp').read_text(encoding='utf8').replace('int main()\n', 'int CallbackFixtureMain()\n')
names = ['OsInterruptFunctionOperands']
method_names = ['FastOsInterruptCallBranch']
declarations = ''.join('  struct ' + name + ';\n' for name in names)
declarations += ''.join('  static s32 ' + method + '(PowerPC::PowerPCState&, const ' + operand + '&);\n'
                        for method, operand in zip(method_names, names))
source = source.replace('  struct FastInstructionOperands;', declarations + '  struct FastInstructionOperands;')
new_operands = '\n'.join(structure(header, 'struct CachedInterpreter::' + name + '\n') for name in names)
old_operands = '\n'.join(structure(original_header, 'struct CachedInterpreter::' + name + '\n') for name in names).replace('CachedInterpreter::', 'BaselineInterpreter::')
source = source.replace('template <>\nstruct CachedInterpreter::EndBlockOperands<false>', new_operands + '\n\ntemplate <>\nstruct CachedInterpreter::EndBlockOperands<false>', 1)
source = source.replace('struct BaselineInterpreter::FastInstructionOperands', old_operands + '\nstruct BaselineInterpreter::FastInstructionOperands', 1)
new_methods = '\n'.join(function(candidate, 's32 CachedInterpreter::' + name + '(PowerPC::PowerPCState&') for name in method_names)
old_methods = '\n'.join(function(original, 's32 CachedInterpreter::' + name + '(PowerPC::PowerPCState&') for name in method_names).replace('CachedInterpreter::', 'BaselineInterpreter::')
counter_names = sorted(set(re.findall(r'\bs_fast_[a-z0-9_]+', old_methods + new_methods)))
counter_decl = '\n'.join('u32 ' + name + ' = 0;' for name in counter_names)
reset = '\n'.join('  ' + name + ' = 0;' for name in counter_names)
snapshot = 'return {' + ', '.join(counter_names) + '};'
extra = (OWN / 'helper.template.cpp').read_text(encoding='utf8')
for key, value in {'COUNTERS': counter_decl, 'RESET_COUNTERS': reset, 'SNAPSHOT_COUNTERS': snapshot,
                   'ORIGINAL_HELPERS': old_methods, 'CANDIDATE_HELPERS': new_methods}.items():
    extra = extra.replace('/* ' + key + ' */', value)
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
          'scope': 'Actual original/candidate terminal callbacks invoked directly and the actual inline OS-interrupt call branch with its operand layout.',
          'adapters': 'Deterministic OS-interrupt inline stub shared by both variants; compares PPC state, accounting and helper counters.'}
(OWN / 'helpers-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2)); run.check_returncode()
