import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Failure } from './errors.js';

const fileLimit = 100 * 1024 * 1024;
const totalLimit = 250 * 1024 * 1024;
export function relativeFile(path: string): string {
  if (!path || /[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Failure('PATH_REFUSED', 'Use regular files at canonical relative workspace paths.');
  return path;
}

export async function workspaceTar(root: string, path: string, name = posix.basename(path)): Promise<Buffer> {
  relativeFile(path);
  relativeFile(name);
  const parts = path.split('/');
  for (let count = 1; count <= parts.length; count++) {
    if ((await lstat(join(root, ...parts.slice(0, count)))).isSymbolicLink()) throw new Failure('PATH_REFUSED', 'Workspace links are refused.');
  }
  const chunks: Buffer[] = [];
  let count = 0;
  let total = 0;
  const add = async (source: string, name: string): Promise<void> => {
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Failure('PATH_REFUSED', 'Workspace transfers accept only regular files and directories.');
    if (info.isDirectory()) {
      for (const child of (await readdir(source)).sort()) await add(join(source, child), `${name}/${child}`);
      return;
    }
    if (++count > 100 || info.size > fileLimit || (total += info.size) > totalLimit) throw new Failure('TRANSFER_LIMIT', 'The workspace exceeds its file count or byte limits.');
    const bytes = await readFile(source);
    if (bytes.length !== info.size) throw new Failure('WORKSPACE_CHANGED', 'A workspace file changed during preparation.');
    const header = Buffer.alloc(512);
    const separator = name.lastIndexOf('/');
    const leaf = Buffer.byteLength(name) <= 100 ? name : name.slice(separator + 1);
    const prefix = Buffer.byteLength(name) <= 100 ? '' : name.slice(0, separator);
    if (Buffer.byteLength(leaf) > 100 || Buffer.byteLength(prefix) > 155 || separator < 0 && prefix) throw new Failure('PATH_REFUSED', 'The file path exceeds the portable tar header limits.');
    header.write(leaf, 0, 100); header.write(prefix, 345, 155);
    const octal = (value: number, offset: number, length: number): void => { header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length); };
    octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  };
  await add(join(root, path), name);
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export function readWorkspaceTar(archive: Buffer): { path: string; bytes: Buffer }[] {
  if (archive.length > totalLimit + 102400) throw new Failure('TRANSFER_LIMIT', 'The archive exceeds the workspace limit.');
  const files: { path: string; bytes: Buffer }[] = [];
  const names = new Set<string>();
  let total = 0;
  let offset = 0;
  const number = (header: Buffer, start: number, length: number): number => {
    const text = header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(text)) throw new Failure('ARCHIVE_REFUSED', 'The archive contains an invalid numeric header.');
    return Number.parseInt(text, 8);
  };
  const field = (header: Buffer, start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!archive.subarray(offset).every(byte => byte === 0)) throw new Failure('ARCHIVE_REFUSED', 'The archive has trailing nonzero data.');
      return files;
    }
    const expected = number(header, 148, 8);
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== expected) throw new Failure('ARCHIVE_REFUSED', 'The archive checksum is invalid.');
    const prefix = field(header, 345, 155);
    const name = relativeFile((prefix ? `${prefix}/` : '') + field(header, 0, 100).replace(/\/$/, ''));
    const size = number(header, 124, 12);
    const type = header[156];
    if (![0, 48, 53].includes(type!)) throw new Failure('PATH_REFUSED', 'Links, extended headers and special archive entries are refused.');
    if (size > fileLimit || (total += size) > totalLimit || offset + 512 + size > archive.length) throw new Failure('TRANSFER_LIMIT', 'The archive exceeds its declared or permitted size.');
    if (names.has(name) || [...names].some(other => other.startsWith(name + '/') || name.startsWith(other + '/'))) throw new Failure('PATH_REFUSED', 'The archive has duplicate or conflicting paths.');
    if (type === 53) {
      if (size !== 0) throw new Failure('ARCHIVE_REFUSED', 'Directory entries must have no payload.');
    } else {
      if (files.length >= 100) throw new Failure('TRANSFER_LIMIT', 'The archive exceeds 100 files.');
      names.add(name);
      files.push({ path: name, bytes: Buffer.from(archive.subarray(offset + 512, offset + 512 + size)) });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Failure('ARCHIVE_REFUSED', 'The archive ended before its EOF marker.');
}
