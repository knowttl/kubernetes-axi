import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The adapter constructs Cobra commands only. It never executes a command or loads kubeconfig.
const adapter = `package main
import (
 "encoding/json"
 "os"
 "strings"
 "github.com/spf13/cobra"
 "github.com/spf13/pflag"
 "k8s.io/kubectl/pkg/cmd"
 "k8s.io/component-base/logs"
)
type Flag struct { Name string \`json:"name"\`; Short string \`json:"short"\`; Type string \`json:"type"\`; Default string \`json:"default"\`; NoOpt string \`json:"noOpt"\`; Usage string \`json:"usage"\` }
type Command struct { Path string \`json:"path"\`; Aliases []string \`json:"aliases"\`; Flags []Flag \`json:"flags"\`; Use string \`json:"use"\`; Short string \`json:"description"\` }
func main() {
 root := cmd.NewDefaultKubectlCommand()
 logs.AddFlags(root.PersistentFlags())
 root.InitDefaultHelpCmd()
 result := []Command{}
 var walk func(*cobra.Command)
 walk = func(c *cobra.Command) {
  c.InitDefaultHelpFlag()
  flags := pflag.NewFlagSet("metadata", pflag.ContinueOnError)
  flags.AddFlagSet(c.InheritedFlags()); flags.AddFlagSet(c.Flags())
  entry := Command{Path: strings.TrimPrefix(c.CommandPath(), "kubectl"), Aliases: c.Aliases, Use: c.Use, Short: c.Short, Flags: []Flag{}}
  entry.Path = strings.TrimSpace(entry.Path)
  flags.VisitAll(func(f *pflag.Flag) { entry.Flags = append(entry.Flags, Flag{f.Name,f.Shorthand,f.Value.Type(),f.DefValue,f.NoOptDefVal,f.Usage}) })
  result = append(result, entry)
  for _, child := range c.Commands() { walk(child) }
 }
 walk(root)
 encoder := json.NewEncoder(os.Stdout); encoder.SetEscapeHTML(false)
 if err := encoder.Encode(result); err != nil { panic(err) }
}
`;

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(readFileSync(join(root, 'kubectl-pins.json'), 'utf8'));
if (pins.version !== 'v1.32.2') throw new Error('Review the upstream module pin and effect policy before changing kubectl.');
const directory = mkdtempSync(join(tmpdir(), 'kubernetes-axi-metadata-'));
writeFileSync(join(directory, 'go.mod'), 'module kubernetes-axi-metadata\n\ngo 1.23.0\n\nrequire k8s.io/kubectl v0.32.2\n');
writeFileSync(join(directory, 'main.go'), adapter);
if (existsSync(join(root, 'upstream-modules.sum'))) writeFileSync(join(directory, 'go.sum'), readFileSync(join(root, 'upstream-modules.sum')));
const commands = JSON.parse(execFileSync('go', ['run', '-mod=mod', '.'], {
  cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GOFLAGS: '-p=2' },
})) as { path: string; aliases: string[] | null; flags: { name: string; short: string; type: string; default: string; noOpt: string; usage: string }[]; use: string; description: string }[];

const policy = JSON.parse(readFileSync(join(root, 'effect-policy.json'), 'utf8')) as { commands: Record<string, string>; flags: Record<string, string>; flagOverrides: Record<string, Record<string, string>>; approvedLimits: Record<string, string>; operationSequences: Record<string, string[]> };
const metadata = {
  version: pins.version, upstream: 'k8s.io/kubectl@v0.32.2',
  moduleLock: createHash('sha256').update(readFileSync(join(directory, 'go.sum'))).digest('hex'),
  commands: commands.map(command => {
    const effect = policy.commands[command.path];
    if (!effect) throw new Error(`Unclassified command: ${command.path}`);
    const sequence = Object.entries(policy.operationSequences).filter(([path]) => command.path === path || command.path.startsWith(`${path} `)).sort(([a], [b]) => b.length - a.length)[0]?.[1];
    if (['clusterWrite', 'authorization'].includes(effect) && !sequence) throw new Error(`Missing operation sequence: ${command.path}`);
    return { ...command, aliases: command.aliases ?? [], effect, ...(sequence ? { operations: sequence } : {}),
      ...(policy.approvedLimits[command.path] ? { compatibilityLimit: policy.approvedLimits[command.path] } : {}),
      flags: command.flags.map(flag => {
        if (!policy.flags[flag.name]) throw new Error(`Unclassified flag: ${command.path} --${flag.name}`);
        return { ...flag, default: flag.name === 'cache-dir' ? '<home>/.kube/cache' : flag.default, effect: policy.flagOverrides[command.path]?.[flag.name] ?? policy.flags[flag.name] };
      }) };
  }),
};
const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
const digest = createHash('sha256').update(metadataText).digest('hex');
const executionLimit = "In 0.1.x, managed interactive exec/attach/debug and standalone watch, follow and port-forward requests are refused before effects. Credentials come only from existing config/profile and secure credential references; tool-managed sessions never read credential secrets from terminal prompts. Bounded noninteractive execution and existing hosted bounded sessions remain supported. Streaming redaction and interactive execution redesigns are tracked at https://github.com/knowttl/kubernetes-axi/issues/34 and https://github.com/knowttl/kubernetes-axi/issues/35.";
const guidance = `Read Kubernetes resources using isolated credentials and pinned kubectl ${pins.version}.\nUse --profile <name> to select an AXI identity.\nUse native -- <kubectl arguments> for native output; native --profile is upstream profiling and is blocked because it writes files.\nReads are bounded; inspect complete, truncated and continue before treating output as complete.\nWrites default off. Explicitly enable KUBERNETES_AXI_READ_ONLY=false, then use prepare -- <mutation>, preview <request-key>, and confirm <request-key> --digest <preview-digest>.\nPreparation reads exact targets; local preview makes no API calls. Confirmation is one-shot and refuses stale or changed targets. Bulk deletion also requires KUBERNETES_AXI_COLLECTION_DELETE=true.\nUse server-dry-run -- <mutation> for explicit API validation without persistence.\nExec/attach and named debug mutations require preparation and confirmation. ${executionLimit} Native Windows support remains pending. Token issuance additionally requires KUBERNETES_AXI_ACQUIRE_CREDENTIAL=true, a duration of at most one hour, and --credential-fd <inherited-private-pipe> before confirm. Issued tokens are delivered once and never retained. Hosted workspace transfer, byte sessions, followed logs, watches and multi-port forwarding use caller-owned authenticated Artium sessions. In 0.1.x, run editors, plugins and external render/diff helpers outside the CLI, then prepare the resulting manifest or patch and confirm its preview. Their execution inside the CLI is refused before effects. Generic proxy listeners and credential overrides remain refused. Native completion, options, plugin list and version --client=true work without credentials.\n${Object.values(policy.approvedLimits).join('\n')}\nRun kubernetes-axi --help for available commands and kubernetes-axi native -- <command> --help for generated upstream flags.\n`;
const markdownGuidance = guidance.replaceAll('. ', '.\n');
const outputs: Record<string, string> = {
  'upstream-modules.sum': readFileSync(join(directory, 'go.sum'), 'utf8'),
  'command-metadata.json': metadataText,
  'src/metadata-pin.ts': `// Generated by scripts/generate-metadata.ts.\nexport const metadataSha256 = '${digest}';\nexport const executionLimit = ${JSON.stringify(executionLimit)};\nexport const guidance = ${JSON.stringify(guidance)};\n`,
  'skills/kubernetes-axi/SKILL.md': `---\nname: kubernetes-axi\ndescription: Inspect Kubernetes resources, discovery, metrics and logs with bounded output and isolated credentials.\n---\n\n${markdownGuidance.replaceAll('kubernetes-axi ', 'npx -y @knowttl/kubernetes-axi ')}\n`,
  'docs/hooks.md': `# Optional session guidance\n\n${markdownGuidance}\nInstall a session hook only with explicit user opt-in.\nClaude Code and Codex SessionStart hooks can run \`kubernetes-axi\` for the bounded home view.\nOpenCode can inject the same home view through a user-managed plugin.\nUse a PATH-verified binary or the absolute installed executable path.\nNo hook is installed by package installation, CLI reads or tests.\nThe installable skill is an alternative when session hooks are unavailable.\n`,
};
for (const [relative, content] of Object.entries(outputs)) {
  const destination = join(root, relative);
  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== content) throw new Error(`Stale generated file: ${relative}`);
  } else {
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, content);
  }
}
rmSync(directory, { recursive: true, force: true });
