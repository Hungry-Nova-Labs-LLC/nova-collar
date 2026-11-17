"""Sign Mach-O files inside dependency archives before sealing the outer app."""
import argparse
import base64
import copy
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

ARCHIVES = {'.zip', '.jar', '.whl'}
MACHO = {bytes.fromhex(x) for x in ('feedface', 'cefaedfe', 'feedfacf', 'cffaedfe')}
FAT = {'cafebabe': 'big', 'bebafeca': 'little', 'cafebabf': 'big', 'bfbafeca': 'little'}
THIN = {'feedface': ('big', 28), 'cefaedfe': ('little', 28), 'feedfacf': ('big', 32), 'cffaedfe': ('little', 32)}
LEGACY_POWERPC = {18, 0x01000012}


def is_macho(header):
    if header[:4] in MACHO:
        return True
    endian = FAT.get(header[:4].hex())
    # Java class files share CAFEBABE; their version is not a fat-architecture count.
    return bool(endian and len(header) >= 8 and 0 < int.from_bytes(header[4:8], endian) <= 32)


def command(args):
    subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def macho_cputypes(path):
    """Read at most 32 architecture headers, including old PowerPC slices."""
    with Path(path).open('rb') as stream:
        length = os.fstat(stream.fileno()).st_size
        header = stream.read(8)
        thin = THIN.get(header[:4].hex())
        if thin:
            endian, minimum = thin
            if length < minimum:
                raise RuntimeError('Truncated native archive member header.')
            return {int.from_bytes(header[4:8], endian)}
        endian = FAT.get(header[:4].hex())
        count = int.from_bytes(header[4:8], endian) if endian and len(header) == 8 else 0
        if not 0 < count <= 32:
            raise RuntimeError('Invalid native archive architecture table.')
        wide = header[:4].hex() in {'cafebabf', 'bfbafeca'}
        entry_size = 32 if wide else 20
        table_end = 8 + count * entry_size
        table = stream.read(count * entry_size)
        if len(table) != count * entry_size:
            raise RuntimeError('Truncated native archive architecture table.')
        types, ranges = set(), []
        for index in range(count):
            entry = table[index * entry_size:(index + 1) * entry_size]
            cpu = int.from_bytes(entry[:4], endian)
            offset = int.from_bytes(entry[8:16] if wide else entry[8:12], endian)
            size = int.from_bytes(entry[16:24] if wide else entry[12:16], endian)
            if offset < table_end or size < 28 or offset + size > length:
                raise RuntimeError('Invalid native archive architecture bounds.')
            if any(offset < end and start < offset + size for start, end in ranges):
                raise RuntimeError('Overlapping native archive architectures.')
            stream.seek(offset)
            leaf = stream.read(8)
            leaf_format = THIN.get(leaf[:4].hex())
            if not leaf_format or size < leaf_format[1] or int.from_bytes(leaf[4:8], leaf_format[0]) != cpu:
                raise RuntimeError('Native archive architecture header does not match its table.')
            types.add(cpu)
            ranges.append((offset, offset + size))
        return types


def sign_archives(root, identity):
    root = Path(root)
    if identity != '-' and not re.fullmatch(r'[A-Fa-f0-9]{40}', identity):
        raise RuntimeError('Archive signing requires the pinned company certificate fingerprint.')
    signed = []
    rebuilt = []
    preserved_legacy = []

    def archive(path, label, depth=0):
        if depth > 8:
            raise RuntimeError(f'Archive nesting is too deep: {label}')
        with tempfile.TemporaryDirectory(prefix='nova-archive-') as directory, zipfile.ZipFile(path) as source:
            temporary = Path(directory)
            changes = {}
            for index, entry in enumerate(source.infolist()):
                if entry.is_dir():
                    continue
                with source.open(entry) as stream:
                    header = stream.read(8)
                nested = Path(entry.filename).suffix.lower() in ARCHIVES
                native = is_macho(header)
                if not nested and not native:
                    continue
                # Never extract an archive member to its supplied path.
                target = temporary / str(index) / Path(entry.filename).name
                target.parent.mkdir()
                with source.open(entry) as stream, target.open('wb') as output:
                    shutil.copyfileobj(stream, output)
                child_label = f'{label}/{entry.filename}'
                if nested:
                    if archive(target, child_label, depth + 1):
                        changes[entry.filename] = target
                elif native:
                    description = subprocess.check_output(['file', '-b', str(target)], text=True, stderr=subprocess.PIPE)
                    if 'Mach-O' not in description:
                        continue
                    # Current strip cannot rewrite PowerPC relocations. codesign can
                    # still sign these upstream slices; preserve their bytes and scan them.
                    if macho_cputypes(target) & LEGACY_POWERPC:
                        preserved_legacy.append(child_label)
                    else:
                        command(['xcrun', 'strip', '-S', str(target)])
                    if (str(Path.home()) + '/').encode() in target.read_bytes():
                        raise RuntimeError(f'Native archive member contains a developer home path: {child_label}')
                    args = ['codesign', '--force', '--sign', identity, '--options', 'runtime']
                    if identity != '-':
                        args.append('--timestamp')
                    command([*args, str(target)])
                    command(['codesign', '--verify', '--strict', str(target)])
                    if identity != '-':
                        prefix = str(target.parent / 'signing-certificate')
                        command(['codesign', '-d', '--extract-certificates=' + prefix, str(target)])
                        certificate = subprocess.check_output(['openssl', 'x509', '-inform', 'DER', '-in', prefix + '0', '-noout', '-fingerprint', '-sha1'], text=True, stderr=subprocess.PIPE)
                        match = re.search(r'Fingerprint=([A-Fa-f0-9:]+)', certificate)
                        if not match or match.group(1).replace(':', '').upper() != identity.upper():
                            raise RuntimeError(f'Native archive member has a different signing identity: {child_label}')
                    if (str(Path.home()) + '/').encode() in target.read_bytes():
                        raise RuntimeError(f'Signed native archive member contains a developer home path: {child_label}')
                    changes[entry.filename] = target
                    signed.append(child_label)
            if not changes:
                return False
            names = source.namelist()
            if len(names) != len(set(names)):
                raise RuntimeError(f'Cannot safely rewrite duplicate archive members: {label}')
            if any(re.match(r'^META-INF/[^/]+\.(SF|RSA|DSA|EC)$', name, re.I) for name in names):
                raise RuntimeError(f'Cannot change native code in a signed JAR without invalidating its Java signature: {label}')
            if path.suffix.lower() == '.whl':
                records = [name for name in names if name.endswith('.dist-info/RECORD')]
                if len(records) != 1 or any(name.endswith(('/RECORD.jws', '/RECORD.p7s')) for name in names):
                    raise RuntimeError(f'Unsupported wheel RECORD/signature layout: {label}')
                rows = list(csv.reader(io.StringIO(source.read(records[0]).decode('utf-8'))))
                if not changes.keys() <= {row[0] for row in rows}:
                    raise RuntimeError(f'Wheel RECORD does not cover changed members: {label}')
                for row in rows:
                    if row[0] in changes:
                        data = changes[row[0]].read_bytes()
                        row[1:] = ['sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='), str(len(data))]
                text = io.StringIO(newline='')
                csv.writer(text, lineterminator='\n').writerows(rows)
                record = temporary / 'updated-record'
                record.write_text(text.getvalue(), encoding='utf-8')
                changes[records[0]] = record
            replacement = temporary / 'rewritten.zip'
            with zipfile.ZipFile(replacement, 'w') as output:
                output.comment = source.comment
                for entry in source.infolist():
                    # ZipInfo retains names, timestamps, permissions, and compression.
                    copied = copy.copy(entry)
                    with output.open(copied, 'w') as destination:
                        if entry.filename in changes:
                            with changes[entry.filename].open('rb') as stream:
                                shutil.copyfileobj(stream, destination)
                        else:
                            with source.open(entry) as stream:
                                shutil.copyfileobj(stream, destination)
                    # zipfile defaults a zero external_attr to owner-only UNIX mode.
                    # Restore upstream metadata before writing the central directory.
                    copied.external_attr = entry.external_attr
            mode = path.stat().st_mode
            shutil.copyfile(replacement, path)
            os.chmod(path, mode)
            rebuilt.append(label)
            return True

    for path in sorted(root.rglob('*')):
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in ARCHIVES:
            archive(path, path.relative_to(root).as_posix())
    return {'signedNativeMembers': signed, 'repackedArchives': rebuilt, 'legacyMembersWithDebugRecordsPreserved': preserved_legacy}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--identity', required=True)
    args = parser.parse_args()
    try:
        result = sign_archives(args.root, args.identity)
    except subprocess.CalledProcessError:
        raise SystemExit('Release signing failed while processing embedded native code.') from None
    policy = 'Explicitly approved associated-owner' if os.environ.get('HNL_APPLE_SIGNING_POLICY') == 'associated-owner' else 'Hungry Nova Labs LLC company'
    result['signingPolicy'] = f'Pinned {policy} Developer ID Application certificate; embedded native leaf fingerprints are verified.' if args.identity != '-' else 'Ad-hoc synthetic fixture signing only; not a public release.'
    result['changes'] = 'Native macOS members were Developer ID signed for distribution. Debug records were stripped except from the listed legacy PowerPC members that current Apple strip cannot rewrite; all members were checked for developer home paths. ZIP/JAR/wheel containers were repacked and wheel RECORD hashes updated. Upstream source and license notices are retained.'
    (args.root / 'MAC-PACKAGING-CHANGES.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f"release signing: signed {len(result['signedNativeMembers'])} embedded native files in {len(result['repackedArchives'])} archives.")
