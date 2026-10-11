#!/usr/bin/env python3
"""Prepare lockfile-matched runtime fixtures from the local npm cache.

No network, package installation, lifecycle hooks, or node_modules writes.
Prints the temporary fixture root for HONESTY_KIT_ROOT and NODE_OPTIONS.
Only public kit runtime files and unchanged package metadata are copied.
"""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import tempfile

root = Path(__file__).resolve().parent.parent
lock = json.loads((root / 'package-lock.json').read_text())
dependencies = json.loads((root / 'package.json').read_text())['devDependencies']
cache = Path.home() / '.npm' / '_cacache' / 'content-v2'
expected_files = {}
kit_names = []
for name, version in dependencies.items():
    if not (name.endswith('-kit') or name == 'trust-core'):
        continue
    kit_names.append(name)
    integrity = lock['packages']['node_modules/' + name]['integrity']
    algorithm, digest = integrity.split('-', 1)
    if algorithm != 'sha512':
        raise ValueError(f'{name}: expected a SHA-512 lockfile integrity')
    hex_digest = base64.b64decode(digest, validate=True).hex()
    archive_path = cache / algorithm / hex_digest[:2] / hex_digest[2:4] / hex_digest[4:]
    data = archive_path.read_bytes()
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != digest:
        raise ValueError(f'{name}: cached archive does not match the lockfile')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            relative = PurePosixPath(member.name).relative_to('package')
            if '..' in relative.parts:
                raise ValueError(f'{name}: unsafe archive path')
            path = str(relative)
            wanted = path == 'package.json' or (path.startswith('dist/') and (path.endswith('.js') or path.endswith('.js.map')))
            if not member.isfile() or not wanted:
                continue
            expected_files[Path(name) / relative] = archive.extractfile(member).read()
    if json.loads(expected_files[Path(name) / 'package.json'])['version'] != version:
        raise ValueError(f'{name}: archive version does not match the site')
    print(f'{name}@{version}: SHA-512 matched lockfile', file=sys.stderr)

expected_files[Path('loader.mjs')] = (
    "import { pathToFileURL } from 'node:url';\n"
    f"const kits = new Set({json.dumps(kit_names)});\n"
    "export function resolve(specifier, context, nextResolve) {\n"
    "  if (kits.has(specifier)) return { url: pathToFileURL(`${process.env.HONESTY_KIT_ROOT}/${specifier}/dist/index.js`).href, shortCircuit: true };\n"
    "  return nextResolve(specifier, context);\n"
    "}\n"
).encode()
expected_files[Path('register.mjs')] = (
    "import { register } from 'node:module';\n"
    "register(new URL('./loader.mjs', import.meta.url));\n"
).encode()


def matches(candidate):
    """Reuse only unchanged regular files, without following fixture symlinks."""
    try:
        if candidate.is_symlink() or not candidate.is_dir():
            return False
        for relative, expected in expected_files.items():
            target = candidate
            for part in relative.parts:
                target = target / part
                if target.is_symlink():
                    return False
            if not target.is_file() or target.read_bytes() != expected:
                return False
        return True
    except OSError:
        return False


fixtures = next((candidate for candidate in sorted(Path('/tmp').glob('honesty-kits-pinned-*'))
                 if matches(candidate)), None)
if fixtures is None:
    fixtures = Path(tempfile.mkdtemp(prefix='honesty-kits-pinned-', dir='/tmp'))
    for relative, contents in expected_files.items():
        target = fixtures / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
else:
    print('Reusing byte-matched runtime fixtures', file=sys.stderr)
print(fixtures)
