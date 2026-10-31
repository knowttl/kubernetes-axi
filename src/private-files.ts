import { constants } from 'node:fs';
import { open, lstat, mkdir, chmod, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { Failure } from './errors.js';

export interface PrivateFileOptions {
  platform?: NodeJS.Platform;
  restrictAcl?: (path: string) => void;
  verifyAcl?: (path: string) => void;
  diagnostic?: boolean;
}

export async function readPrivate(path: string, secret: boolean, options: PrivateFileOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  await unredirected(path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Failure('CONFIG_INSECURE', `Use a regular, unredirected credential file: ${path}.`);
  }
  if (platform === 'win32' && options.diagnostic) (options.verifyAcl ?? verifyWindows)(path);
  const handle = await open(path, constants.O_RDONLY | (platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await handle.stat();
    if (stat.dev !== metadata.dev || stat.ino !== metadata.ino || !stat.isFile() ||
        (platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & (secret ? 0o077 : 0o022)) !== 0))) {
      throw new Failure('CONFIG_INSECURE', `Credential file must be owned by the current user; use chmod 600 ${path}.`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function verifyWindows(path: string): void {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $acl=Get-Acl -LiteralPath $env:KUBERNETES_AXI_ACL_PATH; ' +
      '$ids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"); ' +
      'if(!$acl.AreAccessRulesProtected) { throw "Unprotected" }; ' +
      'foreach($rule in $acl.Access) { $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; ' +
      'if($rule.AccessControlType -ne "Allow" -or $sid -notin $ids) { throw "Unexpected access" } }; ' +
      'foreach($sid in $ids) { if(!($acl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl })) { throw "Missing access" } }'],
    { env: { ...process.env, KUBERNETES_AXI_ACL_PATH: path }, stdio: 'ignore' });
  } catch { throw new Failure('CONFIG_INSECURE', `Re-run the tool private write to protect the Windows ACL: ${path}.`); }
}

function restrictWindows(path: string): void {
  // Paths travel through the child environment, never interpolated into PowerShell code.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $p=$env:KUBERNETES_AXI_ACL_PATH; ' +
    '$acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); ' +
    '$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }; ' +
    '$ids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"); ' +
    'foreach($id in $ids) { $sid=New-Object System.Security.Principal.SecurityIdentifier($id); ' +
    '$rule=if((Get-Item -LiteralPath $p).PSIsContainer) { New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow") } else { New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","Allow") }; ' +
    '$acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl'],
  { env: { ...process.env, KUBERNETES_AXI_ACL_PATH: path }, stdio: 'ignore' });
}

export async function privateDirectory(path: string, options: PrivateFileOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  await unredirected(path, true);
  const missing: string[] = [];
  for (let current = path;; current = dirname(current)) {
    try { await lstat(current); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.push(current); }
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory, { mode: 0o700 });
    if (platform === 'win32') (options.restrictAcl ?? restrictWindows)(directory);
  }
  if (platform !== 'win32') {
    if ((await lstat(path)).uid !== process.getuid?.()) throw new Failure('CONFIG_INSECURE', 'Use a directory owned by the current user.');
    await chmod(path, 0o700);
  }
  if (platform === 'win32' && !missing.includes(path)) (options.restrictAcl ?? restrictWindows)(path);
}

export async function writePrivate(path: string, content: string, options: PrivateFileOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  await privateDirectory(dirname(path), options);
  await unredirected(path, true);
  try { await readPrivate(path, true, options); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(dirname(path), `.private-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      if (platform === 'win32') (options.restrictAcl ?? restrictWindows)(temporary);
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    const deadline = Date.now() + 1000;
    for (;;) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error;
        await setTimeout(50);
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

async function unredirected(path: string, missing = false): Promise<void> {
  for (let current = path;; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Failure('CONFIG_INSECURE', 'Use an unredirected credential path; remove symbolic links or junctions.');
    } catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
