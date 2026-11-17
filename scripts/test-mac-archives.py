"""Regression: sign native code inside nested archives and maintain wheel hashes."""
import base64
import csv
import hashlib
import importlib.util
import io
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('mac_archives', Path(__file__).with_name('sign-mac-archives.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def zipped(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
            archive.getinfo(name).external_attr = 0
    return data.getvalue()


def thin_header(cpu, endian='big', wide=False):
    magic = {('big', False): 'feedface', ('little', False): 'cefaedfe', ('big', True): 'feedfacf', ('little', True): 'cffaedfe'}[(endian, wide)]
    return bytes.fromhex(magic) + cpu.to_bytes(4, endian) + bytes(24 if wide else 20)


def fat_header(cpus, endian='big', wide=False):
    magic = {('big', False): 'cafebabe', ('little', False): 'bebafeca', ('big', True): 'cafebabf', ('little', True): 'bfbafeca'}[(endian, wide)]
    slices = [thin_header(cpu, endian, cpu == 0x01000012) for cpu in cpus]
    offset = 8 + len(cpus) * (32 if wide else 20)
    table = bytearray()
    for cpu, data in zip(cpus, slices):
        width = 8 if wide else 4
        table.extend(cpu.to_bytes(4, endian) + bytes(4) + offset.to_bytes(width, endian) + len(data).to_bytes(width, endian) + bytes(8 if wide else 4))
        offset += len(data)
    return bytes.fromhex(magic) + len(cpus).to_bytes(4, endian) + table + b''.join(slices)


with tempfile.TemporaryDirectory(prefix='nova-sign-test-') as directory:
    root = Path(directory)
    header_file = root / 'header-fixture'
    for endian in ('big', 'little'):
        for wide in (False, True):
            for cpu in (7, 18, 0x01000012):
                header_file.write_bytes(thin_header(cpu, endian, wide))
                assert module.macho_cputypes(header_file) == {cpu}
            header_file.write_bytes(fat_header([18, 7, 0x01000012], endian, wide))
            assert module.macho_cputypes(header_file) == {18, 7, 0x01000012}
    malformed = [b'', thin_header(18)[:8], bytes.fromhex('cafebabe00000021'), fat_header([18])[:20]]
    invalid_bounds = bytearray(fat_header([18]))
    invalid_bounds[16:20] = (1).to_bytes(4, 'big')
    malformed.append(invalid_bounds)
    mismatch = bytearray(fat_header([18]))
    mismatch[-24:-20] = (7).to_bytes(4, 'big')
    malformed.append(mismatch)
    for data in malformed:
        header_file.write_bytes(data)
        try:
            module.macho_cputypes(header_file)
            raise AssertionError('Malformed native headers must be rejected')
        except RuntimeError:
            pass
    legacy = root / 'legacy'
    legacy.mkdir()
    (legacy / 'upstream.jar').write_bytes(zipped({'native/legacy.dylib': fat_header([18, 7])}))
    recorded = []
    with patch.object(module.subprocess, 'check_output', return_value='Mach-O universal binary'), patch.object(module, 'command', side_effect=lambda args: recorded.append(args)):
        legacy_result = module.sign_archives(legacy, '-')
    assert legacy_result['legacyMembersWithDebugRecordsPreserved'] == ['upstream.jar/native/legacy.dylib']
    assert len(legacy_result['signedNativeMembers']) == 1
    assert not any('lipo' in args or 'strip' in args for args in recorded)
    assert any(args[:3] == ['codesign', '--force', '--sign'] for args in recorded)
    source = root / 'fixture.c'
    source.write_text('int nova_archive_fixture(void) { return 42; }\n')
    binary = root / 'fixture.dylib'
    subprocess.run(['xcrun', 'clang', '-dynamiclib', str(source), '-o', str(binary)], check=True)
    unsigned = binary.read_bytes()
    bundle = root / 'bundle'
    bundle.mkdir()
    java_class = bytes.fromhex('cafebabe0000003d') + b'class fixture'
    jar = zipped({'native/libfixture.dylib': unsigned, 'Fixture.class': java_class, 'LICENSE': b'retained notice'})
    (bundle / 'extension.zip').write_bytes(zipped({'lib/engine.jar': jar, '../not-extracted.txt': b'kept inside zip'}))
    record = 'module.so,sha256=stale,1\nfixture.dist-info/RECORD,,\n'
    (bundle / 'fixture.whl').write_bytes(zipped({'module.so': unsigned, 'fixture.dist-info/RECORD': record}))
    plain = zipped({'Fixture.class': java_class, 'LICENSE': b'retained notice'})
    (bundle / 'plain.jar').write_bytes(plain)
    result = module.sign_archives(bundle, '-')
    assert len(result['signedNativeMembers']) == 2
    assert len(result['repackedArchives']) == 3
    assert not (root / 'not-extracted.txt').exists()
    assert (bundle / 'plain.jar').read_bytes() == plain
    with zipfile.ZipFile(bundle / 'extension.zip') as outer, zipfile.ZipFile(io.BytesIO(outer.read('lib/engine.jar'))) as inner:
        assert inner.read('LICENSE') == b'retained notice'
        assert inner.getinfo('LICENSE').external_attr == 0
        assert inner.read('Fixture.class') == java_class
        binary.write_bytes(inner.read('native/libfixture.dylib'))
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    with zipfile.ZipFile(bundle / 'fixture.whl') as wheel:
        content = wheel.read('module.so')
        rows = list(csv.reader(io.StringIO(wheel.read('fixture.dist-info/RECORD').decode())))
        assert rows[0] == ['module.so', 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(content).digest()).decode().rstrip('='), str(len(content))]
        binary.write_bytes(content)
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    protected = root / 'protected'
    protected.mkdir()
    signed_jar = zipped({'libfixture.dylib': unsigned, 'META-INF/UPSTREAM.SF': b'existing Java signature'})
    (protected / 'signed.jar').write_bytes(signed_jar)
    try:
        module.sign_archives(protected, '-')
        raise AssertionError('Signed Java archive should require explicit handling')
    except RuntimeError as error:
        assert 'Java signature' in str(error)
    assert (protected / 'signed.jar').read_bytes() == signed_jar
    for diagnostic in (None, b'synthetic-private-signing-diagnostic'):
        failure = subprocess.CalledProcessError(1, ['synthetic-private-signing-command'], stderr=diagnostic)
        with patch.object(sys, 'argv', [str(Path(module.__file__)), str(bundle), '--identity', '-']), patch.object(subprocess, 'check_output', return_value='Mach-O native binary'), patch.object(subprocess, 'run', side_effect=failure):
            try:
                runpy.run_path(module.__file__, run_name='__main__')
                raise AssertionError('A failed signing command must fail the CLI')
            except SystemExit as error:
                assert str(error) == 'Release signing failed while processing embedded native code.'
print('PASS bounded thin/fat PowerPC headers, legacy strip preservation, sanitized signing failures, nested archive signing, wheel integrity, notices, unchanged Java classes, and signed-JAR protection')
