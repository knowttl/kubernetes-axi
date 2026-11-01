# Optional session guidance

Read Kubernetes resources using isolated credentials and pinned kubectl v1.32.2.
Use --profile <name> to select an AXI identity.
Use native -- <kubectl arguments> for native output; native --profile is upstream profiling and is blocked because it writes files.
Reads are bounded; inspect complete, truncated and continue before treating output as complete.
Writes default off.
Explicitly enable KUBERNETES_AXI_READ_ONLY=false, then use prepare -- <mutation>, preview <request-key>, and confirm <request-key> --digest <preview-digest>.
Preparation reads exact targets; local preview makes no API calls.
Confirmation is one-shot and refuses stale or changed targets.
Bulk deletion also requires KUBERNETES_AXI_COLLECTION_DELETE=true.
Use server-dry-run -- <mutation> for explicit API validation without persistence.
Exec/attach and named debug mutations require preparation and confirmation.
Linux exec/attach -it confirmations require a real local terminal and util-linux script at /usr/bin/script; input, resize and cancellation use a PTY with redacted output.
Native get --watch and logs --follow stream in a local Linux terminal.
Hosted TTY and native Windows terminal support remain pending.
Token issuance additionally requires KUBERNETES_AXI_ACQUIRE_CREDENTIAL=true, a duration of at most one hour, and --credential-fd <inherited-private-pipe> before confirm.
Issued tokens are delivered once and never retained.
Hosted workspace transfer, byte sessions, followed logs, watches and multi-port forwarding use caller-owned authenticated Artium sessions.
In 0.1.x, run editors, plugins and external render/diff helpers outside the CLI, then prepare the resulting manifest or patch and confirm its preview.
Their execution inside the CLI is refused before effects.
Generic proxy listeners and credential overrides remain refused.
Native completion, options, plugin list and version --client=true work without credentials.
In 0.1.x, run diff and its external helpers outside the CLI.
Submit resulting changes through prepare, preview and confirm.
Run kubernetes-axi --help for available commands and kubernetes-axi native -- <command> --help for generated upstream flags.

Install a session hook only with explicit user opt-in.
Claude Code and Codex SessionStart hooks can run `kubernetes-axi` for the bounded home view.
OpenCode can inject the same home view through a user-managed plugin.
Use a PATH-verified binary or the absolute installed executable path.
No hook is installed by package installation, CLI reads or tests.
The installable skill is an alternative when session hooks are unavailable.
