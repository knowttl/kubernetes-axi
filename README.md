# kubernetes-axi

Agent-facing Kubernetes CLI that runs a pinned kubectl with an isolated identity, with cluster writes disabled by default.

[Why](#why-this-exists) | [Quickstart](#quickstart) | [Use with your agent](#use-with-your-agent) | [Commands](#commands) | [Safety](#safety) | [Configuration](#configuration) | [Output](#output-and-exit-codes) | [Limitations](#limitations) | [Development](#development) | [Security](#security) | [License](#license)

## Why this exists

Raw kubectl output is unbounded, mixes credentials from the developer's kubeconfig into every call and can change a cluster in one step.
kubernetes-axi returns bounded, token-efficient TOON with provenance fields (`complete`, `truncated`, `continue`) so an agent knows when a result is partial.
Each call runs the pinned kubectl v1.32.2 with a private kubeconfig built from a selected profile, never from ambient developer settings.
Cluster writes are off by default and need an explicit switch plus a prepare, preview and confirm workflow.

## Quickstart

Requires Node 24.14.0 and npm 11.9.0, as pinned in [package.json](package.json).

```text
npm install --global @knowttl/kubernetes-axi
kubernetes-axi --version
kubernetes-axi --help
```

Without a usable credential configuration, cluster commands fail with a structured error such as:

```text
error:
  code: AUTH_REQUIRED
  message: Supply a complete environment profile or select a configured profile.
```

First authenticated read, using a configured profile:

```text
kubernetes-axi version --profile <name>
kubernetes-axi get pods --profile <name> --namespace <namespace>
```

Running `kubernetes-axi` with no arguments shows the selected source, isolated context, namespace, compatible binary and a bounded live pod summary.

## Use with your agent

- Optional session hooks for Claude Code, Codex and OpenCode are described in [docs/hooks.md](docs/hooks.md).
  A hook is installed only after explicit opt-in; package installation, CLI reads and tests never install one.
- An installable skill is an alternative when hooks are unavailable: `npx skills add knowttl/kubernetes-axi --skill kubernetes-axi`.
  Its source is [skills/kubernetes-axi/SKILL.md](skills/kubernetes-axi/SKILL.md).

## Commands

`kubernetes-axi --help` lists the compact read surface.
Use `kubernetes-axi help <command>` for command-specific help without credentials or cluster requests, including `help top pod` and `help prepare`.
Native targets also support `kubernetes-axi native -- help <command>`; inherited flags may precede `help`, as in `kubernetes-axi -n kube-system help get`.
A bare `--version` prints the package version without loading the command graph.
Version probes with selection flags, such as `--native-config <path> --version`, also print the package version without loading credentials or contacting the cluster.

```text
kubernetes-axi version
kubernetes-axi get <resource> [name]
kubernetes-axi api-versions
kubernetes-axi api-resources
kubernetes-axi logs <pod> -n <namespace>
kubernetes-axi top node
kubernetes-axi top pod -n <namespace>
kubernetes-axi describe <resource> <name>
kubernetes-axi explain <resource>
kubernetes-axi native -- <kubectl arguments>
```

Global flags: `--config <absolute-path>`, `--profile <name>`, `--namespace <name>` (`-n`), `--json`, `--help`.
Inspection commands that need no cluster request: `auth status`, `profile list`, `config path` and `doctor`.
`doctor` and `auth status` validate local credential configuration and file permissions; `connectivity: not checked` means they do not test server reachability or authentication acceptance.
With `--native-config`, `doctor` and `auth status` inspect the selected native context, and `config path` lists the native source paths.
Profiles belong to standard configuration; omit `--native-config` when running `profile list`.

Reads:

- Compact reads discover resource names, aliases, scope and kinds dynamically, including custom resources.
  Compact `get` accepts one resource type and a separate optional name; use `native -- get` for `TYPE/NAME`, comma lists or `all`.
- Selectors require compact lists without a resource name: `get <resource>` accepts `-l` / `--selector` and `--field-selector`, while `top node` and `top pod` accept `-l` / `--selector`.
  Combining a name with a selector returns `USAGE` (exit 2) before any API request; omit the name to filter a list, or omit the selector for a named read.
- Pods report name, namespace and phase, nodes report readiness, deployments report desired and available replicas, and `top` aggregates CPU and memory.
- See [Output and exit codes](#output-and-exit-codes) for compact JSON and native output formats.
- Pass `get <resource> --continue '<token>'` to fetch the next bounded page, keeping the original namespace and selectors.
  Each page remains limited to 100 objects; an expired token requires a fresh list.
- `describe`, `explain`, `rollout history` and `rollout status <resource> --watch=false` wrap upstream text with provenance and `complete: false`.
  Rollout status requires explicit `--watch=false` in both compact and native modes because the upstream default watches.
- `logs` preserves text and defaults to 100 trailing lines and 65,536 bytes.
- `native -- <kubectl arguments>` returns upstream presentation and preserves ordered and repeated flags.
  Its stdout, stderr and exit status are kept after redaction, with the same time and byte bounds.
- `--profile` before `native --` selects an AXI identity; upstream `--profile` after the delimiter is refused as profiling output.

Cluster writes and operations (all require `KUBERNETES_AXI_READ_ONLY=false`):

```text
kubernetes-axi --profile <name> prepare -- <mutation>
kubernetes-axi --profile <name> preview <request-key>
kubernetes-axi --profile <name> confirm <request-key> --digest <preview-digest>
kubernetes-axi --profile <name> server-dry-run -- <mutation>
```

- Supported mutations: create, replace, client and server apply, merge, strategic and JSON patch, delete, rollout changes, scale, autoscale, node cordon, uncordon, taint and drain, certificate approval and denial, labels, annotations, `set`, `run`, `expose` and disruption budgets.
- Resource names must be explicit; generated names cannot be bound to a stable preview.
- Non-interactive `exec` and `attach` and `debug --attach=false` use the same workflow.
- Authorization and identity reviews use their own non-persistent POST APIs and work in read-only mode.

Generated grammar:

- [command-metadata.json](command-metadata.json) is extracted from the pinned `k8s.io/kubectl@v0.32.2` command tree, with inherited flags, aliases, pflag types and an effect classification.
- [effect-policy.json](effect-policy.json) classifies every exact command path and flag name.
- Run `kubernetes-axi native -- <command> --help` for generated upstream flags.
- Regenerate with `npm run generate:metadata`, which needs Go and the pinned public module dependencies.
  `npm run check:metadata` verifies freshness offline.

## Safety

- Reads are bounded: one page of at most 100 objects, no automatic continuation, a 15-second budget per read, at most 64 child invocations, a 5-second request timeout, a 10-second child limit and 4 MiB of retained output.
- Cluster writes default off.
  `KUBERNETES_AXI_READ_ONLY` accepts only `true`, `false`, `1` or `0`; see [Native identity](#native-identity) for the local configuration write policy.
- `prepare` runs the pinned kubectl through a guarded channel, captures the exact operation sequence, freezes UIDs and resourceVersions, and never forwards mutations.
  The child gets a temporary loopback capability, not the upstream credentials.
- `preview` reads only the saved snapshot and makes no API request.
  Its digest covers the cluster and identity binding, namespace, selected objects and the exact bytes to be forwarded.
  Managed identity binding hashes the resolved credentials, original cluster origin, CA trust, authentication type and default profile namespace; SecretRef file paths and environment variable names do not affect it.
  This binding change invalidates managed requests prepared by earlier versions; prepare and preview those requests again before confirming.
  Native preparations remain compatible.
  Secret payloads, last-applied configuration and configured credential values are redacted from the public preview.
  The private saved request under `requests/<request-key>` beside the config file retains the original payloads, including Secret data, so protect that directory.
- `confirm` needs the exact digest and original identity, rechecks every target, uses UID and resourceVersion preconditions and claims the request atomically.
  A repeated confirmation never replays a mutation.
- Conflicts and transport failures return a failure with the method, route, upstream status where available and a reconciliation read of the target.
  Partial operations stay failures and keep results for completed requests; prepare a fresh request for the rest.
- Bulk deletion also needs `KUBERNETES_AXI_COLLECTION_DELETE=true`, at most 100 frozen objects and the API's `deletecollection` permission.
- `server-dry-run` is an explicit `dryRun=All` API operation that never issues a confirmation.
- Token issuance (`create token`) additionally needs `KUBERNETES_AXI_ACQUIRE_CREDENTIAL=true`, a duration of at most one hour and a private inherited pipe passed as `--credential-fd <fd>` to `confirm`.
  The token is delivered once and never stored.
- Exec/attach request timeouts are fixed: omit `--request-timeout` or use exactly `5s` for standalone execution and `0` for hosted sessions, whose separate session deadline remains enforced.
  Conflicting overrides fail before preparation makes API requests.
- Credential overrides, server overrides, impersonation, TLS bypass and generic proxy listeners are refused.
  Unknown flags are rejected before any effect.
- In 0.1.x, execution of editors, plugins and external render/diff helpers is refused before effects, including when writes are enabled.
  Run those tools outside the CLI, then submit their manifest or patch through preparation, preview and confirmation.
  An opt-in two-stage local execution design is tracked in [issue 30](https://github.com/knowttl/kubernetes-axi/issues/30).
- Raw reads are classified by API subresource position, including nested proxy routes, legacy proxy/watch routes and query-based watches.
  Namespace and object names such as `token`, `proxy`, `portforward`, `exec`, `attach` and `watch` do not by themselves require special capabilities; ordinary reads and mutations keep their usual policy.
  Raw execution, token issuance and proxy connections cannot bypass their explicit capability boundaries.
  Raw resource mutations still require preparation and confirmation.
- Secrets in text output are redacted, including literal, escaped, URI, form and base64 forms.
  Public native Secret reads are refused; `get secrets` returns metadata only.
- Runtime digest checks refuse stale generated metadata before credential resolution or API calls.

### Bounded execution and the 0.1.x capability boundary

Non-interactive `exec` and `attach` use the prepare, preview and confirm workflow.
Preparation freezes the named pod, container and exact command argument sequence without opening a stream.
Confirmation checks the selected identity, cluster and pod snapshot before invoking pinned kubectl.
The private gateway supports WebSocket GET and kubectl's SPDY fallback, preserves separate stdout/stderr, and returns the remote exit code.
Both operations require `KUBERNETES_AXI_READ_ONLY=false`.

In 0.1.x, managed interactive `exec`, `attach` and debugging are refused before effects, even in a real terminal.
Standalone watches, followed logs and port forwarding are also refused before effects.
Credentials come only from existing config/profile and secure credential references.
Tool-managed sessions never read credential secrets from terminal prompts.
Canonical streaming redaction is tracked in [issue #34](https://github.com/knowttl/kubernetes-axi/issues/34), and redesigned interactive exec/attach in [issue #35](https://github.com/knowttl/kubernetes-axi/issues/35).
Existing hosted bounded/noninteractive byte sessions, watches, followed logs and forwarding retain their established behavior.

`debug --attach=false` still prepares named create or ephemeral-container patches through the mutation policy.
Helper-backed mutations and execution remain refused.
Native Windows support remains pending.

Native `completion`, `options`, `plugin list` and `version --client=true` run offline without credentials.
`plugin list` discovers programs on PATH without executing them.

```sh
kubernetes-axi --profile <name> prepare -- exec <pod> -n <namespace> -c <container> -- printf '%s\n' 'hello'
kubernetes-axi --profile <name> preview <request-key>
kubernetes-axi --profile <name> confirm <request-key> --digest <preview-digest>
kubernetes-axi native -- completion bash
```

See [Output and exit codes](#output-and-exit-codes) for confirmation replay behavior.

### Native identity

```text
kubernetes-axi --native-config /absolute/kubeconfig get pods
kubernetes-axi --native-config ambient native -- --context=<context> get pods -o json
kubernetes-axi --native-config /absolute/kubeconfig --trust-exec get pods
```

- `ambient` uses native KUBECONFIG precedence, or `~/.kube/config` when unset.
  Native selection is refused when a standard profile is selected.
- The adapter resolves the context in memory and runs with an isolated temporary kubeconfig; ordinary reads leave native files unchanged.
- Native server URL path prefixes are preserved for compact reads and native raw reads.
  With a server ending in `/k8s/clusters/c1`, pass `native -- get --raw=/api/v1/pods`; the CLI adds the configured prefix.
- For a prepared mutation or execution using an explicit native context, confirm with `--context <original-context>` after the request key and digest.
  The preview's confirmation hint includes the selected context; choosing another context cannot retarget the prepared request.
- Credential helpers need explicit `--trust-exec`.
  Helper identities can read but cannot use `prepare`, `confirm` or `server-dry-run`; they fail with `AUTH_HELPER_MUTATION_UNAVAILABLE`.
  Use a static token or client certificate for mutations.
  Tracked in [issue #19](https://github.com/knowttl/kubernetes-axi/issues/19).
- Native configuration edits need a single explicit source path selected with `--native-config /absolute/kubeconfig`; `ambient` is refused for native `config` operations.
  These edits run directly through `native -- config <command>`, without prepare, preview or confirm, and make no cluster API requests.
  They are allowed when `KUBERNETES_AXI_READ_ONLY` is unset, `false` or `0`; explicit `true` or `1` blocks them.
  The source file is updated only after the command succeeds.
  Generic `config set`, credential argv writes and raw credential inspection are refused.

### Hosted sessions

Used with an Artium host that has the Kubernetes session integration (a frozen local fixture is the only verified integration).

- Caller-owned file trees can be uploaded; host file arguments use `workspace:<relative-path>` and copy downloads use `artifact:<relative-path>`.
  Copy needs `tar` in the container.
- The session API at `/v1/tools/kubernetes-axi/sessions` provides start, status, output and cancel, with bounded stdin, followed logs and pod watches.
  Every operation checks the caller, login family, current operation grant and credential revision.
- Hosted byte output releases safe bytes without waiting for more output or stream closure.
  Only trailing bytes that could complete a registered credential form remain buffered until further output resolves the match or the stream ends.
  A completed match, including one split across chunks, stops the session with `CREDENTIAL_OUTPUT_REFUSED` before that credential is emitted.
- Port-forward sessions freeze a named pod and up to eight numeric remote ports.
  Continued client input after a remote-initiated half-close is not supported; see [issue 26](https://github.com/knowttl/kubernetes-axi/issues/26).

```text
artium-axi kubernetes-axi tunnel <session-id> --port 8080 --port 9090
```

## Configuration

Profiles follow [axi-credential.schema.json](axi-credential.schema.json) and take tokens and private keys only as SecretRefs, never in argv or inline.
There is no persistent login or token store.
Each invocation creates a private kubeconfig and discovery cache below `TMPDIR` and removes them afterwards.

```json
{
  "version": 1,
  "defaultProfile": "selected",
  "profiles": {
    "selected": {
      "origin": "https://127.0.0.1:6443",
      "auth": "token",
      "namespace": "default",
      "certificateAuthority": "<trusted PEM CA certificate>",
      "token": { "env": "SELECTED_TOKEN" }
    }
  }
}
```

Config file location, in order:

- `--config <absolute-path>` or `KUBERNETES_AXI_CONFIG`.
- Linux: an absolute `XDG_CONFIG_HOME` plus `kubernetes-axi/config.json`, else `~/.config/kubernetes-axi/config.json`.
- Windows: `APPDATA` plus `kubernetes-axi/config.json`.

Linux config files must belong to the current uid and not be writable by group or other.
Secret files must have no group or other permissions (0600 or 0400).

Environment variables:

| Variable | Purpose |
| --- | --- |
| `KUBERNETES_AXI_PROFILE` | Select a file profile, same as `--profile`. |
| `KUBERNETES_AXI_ORIGIN`, `KUBERNETES_AXI_AUTH`, `KUBERNETES_AXI_CERTIFICATE_AUTHORITY`, `KUBERNETES_AXI_TOKEN` | Token environment profile. |
| `KUBERNETES_AXI_CLIENT_CERTIFICATE`, `KUBERNETES_AXI_PRIVATE_KEY` | Certificate profile, used instead of the token. |
| `KUBERNETES_AXI_NAMESPACE` | Optional default namespace. |
| `KUBERNETES_AXI_READ_ONLY` | `false` enables cluster writes; see [Native identity](#native-identity) for local configuration edits. |
| `KUBERNETES_AXI_COLLECTION_DELETE` | `true` allows bulk deletion. |
| `KUBERNETES_AXI_ACQUIRE_CREDENTIAL` | `true` allows token issuance. |

A partial environment profile fails rather than borrowing fields from the file.
With no environment fields or selection, the file's `defaultProfile` is used, or its sole profile.
A file profile that omits its token or private key reference reads `KUBERNETES_AXI_TOKEN` or `KUBERNETES_AXI_PRIVATE_KEY`.
Insecure or redirected paths fail before credentials are read.

### Host transport

Embedding hosts can import `main` from `@knowttl/kubernetes-axi/dist/cli.js` and call `await main(args, { transport: { socketPath: '/absolute/private/relay.sock' } })`.
The lower-level `readCluster` export accepts the same transport setting as its fifth argument.
There is no environment variable, profile field or CLI flag for this host-owned setting.
Without it, connections retain their existing behavior.

The host must own and protect the Unix socket and enforce upstream HTTPS trust and certificate pins.
The socket accepts ordinary HTTP requests with origin-form paths and the original cluster `Host` header, including its port.
Static bearer tokens are sent through that socket.
The host must scope its upstream trust to that original endpoint.
kubectl reads use a temporary capability-protected loopback HTTP bridge to the socket; workflow HTTPS requests use it directly.
Redirects from the read bridge are refused so kubectl cannot leave the relay.
Relay addresses do not enter the preparation and confirmation binding described in [Safety](#safety).

Hosts that preconfigure their relay for the selected managed client-certificate identity can pass `transport: { socketPath, endpoint: 'https://cluster.example:6443', capabilities: { clientCertificate: true } }`.
The host already owns the certificate and private key and must install them in its relay's endpoint-scoped TLS options before invoking kubernetes-axi.
No certificate or private key is sent back to the host or over the relay socket.
Native kubeconfig client-certificate identities remain refused because the host has not selected them.
For a preconfigured TLS name, add `capabilities: { serverName: true }` and `serverName: 'api.cluster.example'`; both capabilities can be declared together.
A native `tls-server-name` override must equal the declared `serverName`.
Capabilities require `endpoint` to match the original HTTPS cluster origin, including its port; they never grant trust to another endpoint.
The host must declare only the capabilities it has configured for the selected identity, retain exact certificate pins, and verify the upstream chain, validity and hostname on the data connection.
Without the corresponding capability, certificate identities and TLS server-name overrides retain the existing `HOST_TRANSPORT_UNAVAILABLE` refusal.
Credential helpers remain refused regardless of capabilities.
Hosted byte sessions and upgrade operations (`exec`, `attach`, `port-forward`) also fail explicitly because this relay contract cannot carry them.
Hosts enabling transport when launching the IPC session worker must pass the setting in the message's `transport` field; the worker refuses it before starting a session.
These refusals never fall back to a direct cluster connection.

## Output and exit codes

- Output is TOON by default; `--json` serializes the same approved fields, including structured help and errors.
  Compact JSON preserves the bounded summary rather than the upstream object; text reads such as `logs` and `describe` retain their envelopes.
  Supply the bare flag once, before a native or workflow `--` separator.
  Arguments after that separator belong to kubectl or the remote command, including a literal `--json`.
  Package-version probes (`--version`, `-v`, `-V`) remain plain version text with `--json`.
  Failures carry `error.code` and `error.message` and keep the upstream status where available.
- Distinct codes cover missing resources, denied access, expired continuation, authentication, unavailable APIs, malformed bodies, timeouts and byte limits.
  Read arguments rejected by the API use `BAD_REQUEST`, including invalid containers, unavailable previous logs and malformed selectors.
  Missing execution pods and scale targets use `RESOURCE_NOT_FOUND`.
  Missing saved preview or confirmation requests use `REQUEST_NOT_FOUND`; permission failures reading them use `REQUEST_UNREADABLE`.
  An explicitly selected missing standard config file uses `CONFIG_NOT_FOUND`; a missing default config without a complete environment profile uses `AUTH_REQUIRED`.
- Check `complete`, `truncated` and `continue` before treating a list as complete.
  An oversized server page is truncated with `complete: false`, and a bounded log snapshot never claims completeness.
  A nonempty `continue` also means the list is incomplete even when `truncated` is false; `truncated` describes local output clipping.
- Repeated confirmation returns `replayed: true` without repeating the operation.
  Execution replays include the stored `exitCode` and preserve that process exit status; remote stdout and stderr are not retained for replay.
- Empty event lists are successful.
- Usage errors exit 2; other failures exit 1.
  Native commands and confirmed execution preserve the upstream process exit status.
- The verification entry points exit 0 on pass, 1 on failure and 2 when a prerequisite is pending.

| Invocation | Presentation |
| --- | --- |
| `get pods` | Compact TOON summary with provenance and page state. |
| `get pods --json` or `get pods -o json` | JSON encoding of the same compact summary. |
| `describe pod <name>` | TOON envelope with provenance, upstream `text`, `complete: false` and an execution/byte bound. |
| `--json describe pod <name>` | JSON encoding of that text envelope. |
| `native -- describe pod <name>` | Explicit native text output and native stderr. |
| `native -- get pods -o json` | Explicit upstream JSON, with the upstream resource shape. |

The explicit `native --` route and confirmed exec/attach return upstream output and exit status even when the outer CLI receives `--json`.
Credential redaction remains in place for every presentation.
Compact Event, ConfigMap, Secret and custom-resource rows retain identity metadata (`name`, optional `namespace`, and `kind`).
Use explicit native reads for richer non-secret resource output; public native Secret output remains refused.
Text envelopes retain conservative `complete: false`; the bound describes the request and byte limits rather than full coverage of related resources.
Public previews retain zero and null field values alongside the frozen mutation payload so zero-valued intent remains visible.

`auth status` and `doctor` inspect local configuration, credential references and protected-file permissions.
Their `connectivity: not checked` result makes no claim that the server accepted the identity.
Use an ordinary bounded read to verify server access.
Preparation failures expose classified missing-file, missing-target and missing-name errors; unclassified upstream failures use the structured `UPSTREAM_FAILED` diagnostic.
Native diagnostics preserve repeated discovery output and the upstream exit status after credential redaction.
Endpoint and identity information can remain in explicitly requested native output.
Existing refusal codes and exit statuses remain compatible: watch/follow requests use usage refusals, while standalone port forwarding uses the historical `LOCAL_TERMINAL_REQUIRED` capability refusal even in a real terminal.
Interactive execution and local program execution remain refused before effects.
Explicit multiple-name deletion, like selector-based collection deletion, requires `KUBERNETES_AXI_COLLECTION_DELETE=true` and confirmation of the frozen targets.

## Limitations

- Native Windows execution, ACL conformance and helper channels are pending; Linux is the verified platform.
- Live cluster commissioning and complete command coverage are pending.
- For local editor, plugin and external helper restrictions, see [Safety](#safety).
- Standalone mode has no direct file transfer or generic proxy listener; execution and streaming restrictions are described in the [0.1.x capability boundary](#bounded-execution-and-the-01x-capability-boundary).
- Hosted transfers, byte sessions and port forwarding are verified only against a frozen local Artium fixture, not a released Artium.
- Terminal-bound helpers and legacy auth-provider plugins fail explicitly.
- Supported server minors are listed in [kubectl-pins.json](kubectl-pins.json).
- The `release` verification entry point is pending.

## Development

Node and npm are pinned in [package.json](package.json), with exact dependencies in package-lock.json.
Verification also uses Python 3.12.3 and OpenSSL 3.0.13, plus `unshare`, `ip` and `prlimit` with permission to create a user and network namespace.

```text
npm ci
npm run check
python3 scripts/verify.py task B1.1 --mode offline --pack evidence
python3 scripts/verify.py task B5.1 --mode offline --pack evidence
python3 scripts/verify.py task B5.2 --mode offline --pack evidence
```

The verifier uses Python 3; use `python3` on Linux hosts without a `python` alias.
B5.1 verifies the reduced 0.1.x boundary: interactive and standalone-streaming requests refuse before effects, while bounded execution and offline native client/config commands remain available.
B5.2 runs cumulative package journeys, strict types and generated-contract checks.
Artium hosted proof is optional for the 0.1.x package gate.
Add `--artium <frozen-checkout>` to either B5 command to opt in to hosted verification.
Both commands then include the B4.1 workspace, B4.2 execution and B4.3 tunnel cases and inherit their hosted results.
If no hosted cases are selected or completed, the verifier reports pending (exit 2); hosted failures or a missing hosted report produce failure (exit 1).
B5.2 additionally runs the selected frozen Artium aggregate.
For B5.2 with `--artium`, private hygiene runs when `ARTIUM_AXI_HYGIENE_DENY_LIST_FILE` supplies the owner's external deny list; otherwise it reports pending.
Container acceptance requires separate owner evidence and remains pending in the verifier.

- For offline builds, place the official kubectl binaries named in [kubectl-pins.json](kubectl-pins.json) in `vendor/` before installing; the build checks their SHA256 digests and otherwise downloads only from the pinned official URL.
- `npm test` runs inside a loopback-only Linux namespace, so outbound network access is denied.
  Kubernetes command journeys fake only the external Kubernetes API, through a verified TLS loopback server with synthetic identities.
  Verifier-report regression tests substitute child verifier reports to check completed, omitted, failed and missing hosted results.
- The package-contract check packs and installs the package offline in a temporary directory, checks the published file contract and admission module exports, and runs the installed bin with `--help` and `--version`.
- Hosted journeys need a frozen Artium checkout: `python3 scripts/verify.py task B1.2 --mode offline --pack evidence --artium <frozen-checkout>`.
  Without `--artium` they are skipped with an explicit reason.
- B3.4 also needs a verified `strace` in `KUBERNETES_AXI_TEST_WRITE_OBSERVER` with its digest in `KUBERNETES_AXI_TEST_WRITE_OBSERVER_SHA256`; without it the task reports pending and exits 2.
- Retained fixture provenance is in [evidence/README.md](evidence/README.md).
- Release Please opens release PRs on `main`; merging one publishes to npm with provenance through the `release-please.yml` workflow.

See [CONTRIBUTING.md](CONTRIBUTING.md) for test-quality rules.

## Security

No `SECURITY.md` exists yet; a reporting policy is pending.

## License

kubernetes-axi is released under the MIT license; see [LICENSE](LICENSE).
The bundled kubectl license is in [third-party/kubectl-LICENSE.txt](third-party/kubectl-LICENSE.txt), and notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
