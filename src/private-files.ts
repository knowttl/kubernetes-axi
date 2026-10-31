import { constants } from 'node:fs';
import { open, lstat, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Failure } from './errors.js';

export async function readPrivate(path: string, secret: boolean): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Failure('CONFIG_INSECURE', 'Use a regular, unredirected credential file.');
  }
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await handle.stat();
    if (stat.dev !== metadata.dev || stat.ino !== metadata.ino || !stat.isFile() ||
        (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & (secret ? 0o077 : 0o022)) !== 0))) {
      throw new Failure('CONFIG_INSECURE', 'Credential file must be owned by the current user; use chmod 600 on Linux.');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function restrictWindows(path: string): void {
  // Paths travel through the child environment, never interpolated into PowerShell code.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $p=$env:KUBERNETES_AXI_ACL_PATH; ' +
    '$acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); ' +
    '$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }; ' +
    '$ids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"); ' +
    'foreach($id in $ids) { $sid=New-Object System.Security.Principal.SecurityIdentifier($id); ' +
    '$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","Allow"); ' +
    '$acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl'],
  { env: { ...process.env, KUBERNETES_AXI_ACL_PATH: path }, stdio: 'ignore' });
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  if (process.platform === 'win32') restrictWindows(path);
}

export async function writePrivate(path: string, content: string): Promise<void> {
  // The containing invocation directory is already private, including on Windows.
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  if (process.platform === 'win32') restrictWindows(path);
}
