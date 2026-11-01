# kubernetes-axi

An agent-facing TypeScript CLI that runs pinned kubectl with an isolated identity.
The standalone package implements B1.1, B2.1 through B2.4, and B3.1/B3.2: bounded reads, generated command policy, isolated identities and confirmed resource mutations.
The opt-in B1.2 verification journey exercises version and pod reads through a frozen local Artium fixture.
The Linux portion of B1.3 is covered; native Windows execution and ACL conformance remain pending.
Complete command coverage and live commissioning remain later tasks.

```text
kubernetes-axi version --profile <name>
kubernetes-axi get pods --profile <name> --namespace <namespace>
kubernetes-axi get deployments -n <namespace>
kubernetes-axi top node
kubernetes-axi top pod -n <namespace>
kubernetes-axi logs <pod> -n <namespace>
kubernetes-axi native -- get pods -n <namespace> -o json
```

Compact output defaults to TOON.
Use `--help` for the current command surface, or `--version` for the package version without loading the command graph.
Running without arguments shows the selected source, isolated context, namespace, compatible binary and a bounded live pod summary.
Compact reads discover resource names, aliases, scope and kinds dynamically, including custom resources.
Pod output retains name, namespace and phase; nodes report readiness, deployments report desired and available replicas, and metrics aggregate CPU and memory.
Lists retain continuation token, resource version and remaining item count.
Empty events are successful empty lists.
Compact lists request one page of at most 100 objects and do not follow continuation tokens automatically.
Inspect `complete`, `truncated` and `continue` before treating a result as complete.
An oversized server page is truncated with `complete: false`.
Named reads retain NotFound failures; denied access, expired continuation, authentication, unavailable APIs, malformed bodies, timeouts and byte limits have distinct error codes.
Errors retain the upstream status where available.
Each operation has a 15-second budget, at most 64 child invocations, a 5-second default request timeout, a 10-second child limit and a 4 MiB retained-output limit.
Logs preserve text and default to 100 trailing lines and 65,536 bytes; a bounded log snapshot never claims completeness.
Use `get <resource> [name] -o json` for compact JSON, or the native route for upstream presentation and ordered arguments.
Compact JSON serializes the same bounded summary and provenance as TOON; it does not return the upstream Kubernetes object.
Compact `describe` and `explain` wrap upstream text with provenance and `complete: false`; use the native route for unwrapped text.
Native stdout, stderr and exit status are preserved after redaction, with the same time and byte bounds.
Native `kubectl get pods` consumes continuation tokens even when chunking is disabled, so the bounded read retains the original page state explicitly.

## Install

```text
npm install -g @knowttl/kubernetes-axi
kubernetes-axi --version
```

The npm package is `@knowttl/kubernetes-axi`; the executable is `kubernetes-axi`.

## Build and verification

Node and npm requirements are pinned in [package.json](package.json), with exact dependencies in package-lock.json.
The recorded verification toolchain uses Python **3.12.3** and OpenSSL **3.0.13**.
Linux verification also requires `unshare`, `ip` and `prlimit`, with permission to create a user and network namespace.
Python and OpenSSL are verification prerequisites, not product runtime dependencies.
No reference implementation code was copied.

For offline source builds, place the official binaries listed in kubectl-pins.json in `vendor/` using its recorded filenames before dependency installation.
Verify each against the official published URL plus `.sha256`.
The build checks both digests and downloads a missing binary only from its pinned official URL, verifying SHA256 before writing; pre-provision both binaries for offline builds and tests, which remain under outbound deny with no PATH fallback.
Dependency installation uses the npm registry; Kubernetes verification stays local.

```text
npm ci
npm run check
python3 scripts/verify.py task B1.1 --mode offline --pack evidence
python3 scripts/verify.py task B2.1 --mode offline --pack evidence
python3 scripts/verify.py task B2.2 --mode offline --pack evidence
python3 scripts/verify.py task B2.3 --mode offline --pack evidence
python3 scripts/verify.py task B2.4 --mode offline --pack evidence
```

Verification packs the product, installs that tarball into an isolated temporary prefix, and executes its public CLI.
The B1 verifier uses `--prefer-offline` for npm pack and install; populate the dependency cache before running inside the network namespace.
Only the external Kubernetes API is fake.
It uses a verified TLS loopback server, two synthetic token identities and a synthetic client certificate.
Discovery responses are synthetic; see [evidence/README.md](evidence/README.md) for retained response provenance and the fixture integrity source.
The harness binds only 127.0.0.1, constructs all upstream URLs itself and accepts no external upstream endpoint.
`npm test` runs all children in a Linux user/network namespace with only loopback enabled, denying outbound network access at process level.
It requires `unshare` and `ip`; other platform commissioning remains pending.
On Linux the verifier also re-executes inside a network namespace with only loopback, inherited by the server, clients and native kubectl processes.
Live modes are rejected.

The verification report records individual cases, native OS, package digest, fixture hashes and kubectl pins.
Without `--artium`, the configured test skips the hosted journeys with an explicit reason.
Supply a built, frozen Artium checkout with its copied dependencies, staged package and fresh admission inventory to opt in.
Its Kubernetes tarball must match the package being verified exactly.
The hosted journey starts the real server and runner, logs in with the real CLI, and replays the retained version and pod responses through the installed package.
It tests a poisoned developer kubeconfig, broader upstream access, host role denial, identity override refusals and cancellation cleanup.
Artium's role grant covers the Kubernetes tool; this evidence does not claim operation-specific role grants.

```text
python3 scripts/verify.py task B1.2 --mode offline --pack evidence --artium <frozen-checkout>
python3 scripts/verify.py task B1.3 --mode offline --pack evidence --artium <frozen-checkout>
```

B1.2 exits 0 only when both standalone and hosted journeys pass.
B1.3 and `gate 1` report native Windows as pending and exit 2 after the Linux journeys pass.
The `release` entry point also remains pending because later stages are unimplemented.
Pending never counts as pass.
The B1.1 verifier reports missing npm or OpenSSL as pending and exits 2; integrity mismatches remain failures and exit 1.
The B2 task commands run the combined B2 harness and private-file checks, which require Linux network namespaces, npm, OpenSSL, prlimit and cached npm dependencies; missing prerequisites fail the run.
The private-file checks interrupt a real write with a file-size limit and verify preservation of the prior file and removal of the temporary file.
Injected Windows ACL checks exercise the platform branch; native Windows commissioning remains pending.

```text
python3 scripts/verify.py task B1.1 --mode offline --pack evidence --negative-control
```

The negative control deliberately returns a wrong pod name from the fake API.
The same outcome assertions must report failure and exit 1 before the verifier is trusted.

The managed kubectl version, supported server minors, binary digests and commissioning status are recorded in [kubectl-pins.json](kubectl-pins.json).
The Windows binary and digest are recorded, but Linux verification does not establish native Windows or ACL conformance.

## Releases

Release Please opens release PRs on `main`, starting at 0.1.0.
Merging a release PR creates the GitHub release and runs the release workflow's clean install, checks and public npm publish with provenance.
Configure the npm trusted publisher for `@knowttl/kubernetes-axi` with owner `knowttl`, repository `kubernetes-axi` and workflow `release-please.yml` before releasing.
The workflow uses GitHub OIDC without an npm token.

## Generated grammar and staged capabilities

[command-metadata.json](command-metadata.json) is extracted from the pinned `k8s.io/kubectl@v0.32.2` Cobra command tree and its logging registration.
It includes the root, hidden alpha group and default help command alongside the built-in command paths.
Every entry includes inherited flags, short aliases, actual pflag types and an effect classification.
[effect-policy.json](effect-policy.json) classifies every exact command path and flag name; generation refuses new, unclassified entries.
The checked-in module checksum lock verifies public upstream dependencies.
Changing the binary pin requires a reviewed metadata and policy update.
Runtime digest checks refuse stale metadata before credential resolution or API calls.

```text
npm run generate:metadata
npm run check:metadata
```

Generation requires Go and the pinned public module dependencies, which may be fetched during setup.
`check:metadata` uses the populated module cache with GOPROXY disabled and checks generated metadata, skill and optional hook guidance.
`npm test` runs this freshness check under outbound deny.
The generator uses a temporary Go adapter to inspect the upstream types; no third-party source is copied into the product.

Unknown flags are rejected before effects.
Compact reads reject unsupported flags explicitly; the native route preserves repeated flags and the native `--` boundary.
AXI `--profile` selects an identity before `native --`; upstream `--profile` after that delimiter is classified as profiling output and refused.
Credential, server, impersonation, TLS-bypass, raw-route, filesystem and streaming options are refused by this milestone's policy.
Cluster mutations use the protected prepare, preview and confirm workflow below.
Arbitrary execution, transfers and connections remain staged for their later capabilities.
Explicit local native configuration edits are available through the native identity adapter described below.
Diff has an approved staged compatibility limit: `NOT_YET_SUPPORTED_STAGED`, before reading a manifest or invoking a helper.
When its later file/helper capability is implemented, native diff must retain exit 0 for no differences, 1 for differences and greater than 1 for failure.

Optional [session hook guidance](docs/hooks.md) provides the bounded home view to Claude Code, Codex or OpenCode after explicit opt-in.
The generated [installable skill](skills/kubernetes-axi/SKILL.md) is an alternative discovery path:

```text
npx skills add knowttl/kubernetes-axi --skill kubernetes-axi
```

Package installation, ordinary reads and tests never install hooks.

## Isolated credentials

Profiles use the shipped axi-credential.schema.json, including SecretRefs for token and privateKey.
Tokens and keys are never accepted in argv or inline in the config file.
There is no persistent login or token store.
Each invocation creates a private kubeconfig and discovery cache below TMPDIR and removes them on completion or failure.
The child receives neither developer kubeconfig settings nor ambient proxy and credential-helper settings.

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

On Linux, config defaults to an absolute XDG_CONFIG_HOME plus `kubernetes-axi/config.json`, or `~/.config/kubernetes-axi/config.json`.
Windows uses APPDATA plus `kubernetes-axi/config.json` and ignores XDG variables.
Select another absolute path with `--config` or KUBERNETES_AXI_CONFIG.
Linux config files must belong to the current uid and must not be writable by group or other.
Secret files must additionally have no group or other permissions; 0600 and 0400 are accepted.

`--profile` and KUBERNETES_AXI_PROFILE select a file profile before environment-profile fields.
Without that selection, KUBERNETES_AXI_ORIGIN, KUBERNETES_AXI_AUTH, KUBERNETES_AXI_CERTIFICATE_AUTHORITY and KUBERNETES_AXI_TOKEN form a token environment profile.
Certificate profiles use KUBERNETES_AXI_CLIENT_CERTIFICATE and KUBERNETES_AXI_PRIVATE_KEY instead of the token.
KUBERNETES_AXI_NAMESPACE is optional.
A partial environment profile fails rather than borrowing fields from the file.
When no environment-profile fields or explicit profile selection are present, the file's defaultProfile is used, or its sole profile if no default is set.
If the file has multiple profiles and no default, select one explicitly.
File profiles may deliberately reference any valid named environment variable through a SecretRef.
If a file profile omits its token or privateKey reference, the secret is read from KUBERNETES_AXI_TOKEN or KUBERNETES_AXI_PRIVATE_KEY respectively.
Certificate authority and client certificate fields contain PEM text, and secret files use absolute local paths.

`auth status`, `profile list`, `config path` and `doctor` inspect standard credential configuration without a cluster request.
Status and doctor verify file permissions, including Windows DACLs; evidence on a native Windows host remains pending.
Private writes use a same-directory exclusive temporary file, fsync and atomic rename, with bounded Windows rename retries.
Redirected paths and insecure files fail before reading credentials.
KUBERNETES_AXI_READ_ONLY accepts only true, false, 1 or 0 and also gates native configuration writes.
Cluster writes default off and additionally require the confirmed request workflow below.

## Prepared mutations and operational commands

Enable writes explicitly in the selected execution environment.
The host's role and operation grants remain independent of this switch.

```sh
export KUBERNETES_AXI_READ_ONLY=false
kubernetes-axi --profile <name> prepare -- patch deployment <name> -n <namespace> --type=merge -p '{"spec":{"replicas":3}}'
kubernetes-axi --profile <name> preview <request-key>
kubernetes-axi --profile <name> confirm <request-key> --digest <preview-digest>
```

`prepare` runs the pinned kubectl through a guarded channel and captures its exact operation sequence.
It sends bounded reads, freezes UIDs and resourceVersions, and never forwards mutations.
The snapshot, signing key and outcome record live in a private `requests/<request-key>` directory beside the selected standard configuration file.
Native identities use that same protected state directory and bind to their selected context and original identity.
The child receives a temporary loopback capability instead of the upstream credentials.

`preview` reads only the saved snapshot and performs no API requests or helper execution.
Its digest covers the cluster and identity binding, namespace, selected objects, original request bytes, and the exact normalized bytes to be forwarded.
Secret payloads, last-applied configuration and configured credential values are redacted from the public preview.

`confirm` requires the exact digest and original identity, rechecks every captured target, and atomically claims the request before writing.
Object changes use UID/resourceVersion preconditions.
A repeated confirmation never replays a mutation.
Conflicts and transport failures return failure with the method, route, upstream status where available and a reconciliation read of the target identity/version.
Partial operations remain failures and preserve results for completed requests; prepare a fresh request to act on the remaining targets.

Bulk deletion additionally requires `KUBERNETES_AXI_COLLECTION_DELETE=true`.
Preparation refuses incomplete selections and selections over 100 objects.
It freezes the selected list, rejects changed selections during confirmation, and uses collection-delete requests restricted to each exact name with UID/resourceVersion preconditions.
This requires the API's `deletecollection` permission independently of individual deletion permission.

```sh
export KUBERNETES_AXI_COLLECTION_DELETE=true
kubernetes-axi --profile <name> prepare -- delete configmaps -n <namespace> -l app=selected
kubernetes-axi --profile <name> server-dry-run -- apply -f /absolute/path/manifest.json --validate=false
```

`server-dry-run` is a separate explicit API operation with `dryRun=All`; it never issues a confirmation request.
It requires enabled writes and the server's own resource permissions and admission checks.
Local previews do not validate server admission.

The workflow supports create, replace, client/server apply, merge/strategic/JSON patch, deletion, rollout changes, scaling, autoscaling, node cordon/uncordon/taint/drain, certificate approval/denial, labels, annotations, set, run, expose and disruption budgets.
Resource names must be explicit; generated names cannot be bound to a stable preview.
Caller-selected Kustomize helpers, arbitrary programs, interactive sessions and credential overrides remain unavailable.
Rollout history and bounded status use the read path; status requires `--watch=false`.
Authorization and identity reviews use their own non-persistent POST APIs and permissions, even in read-only mode.
A successful identity review grants no data permissions.

Typed requests are decoded using protobufjs 7.6.6 and generated schemas and JSON field mappings from checksummed official Kubernetes v0.32.2 protobuf and Go contracts.
Unknown protobuf types are refused before forwarding.
Regenerate schemas with `node scripts/generate-protobuf.ts`; the pinned Go module cache must contain the source files.
The configured test verifies both generated metadata and schemas without outbound networking or an Artium fixture.
Run `python3 scripts/verify.py task B3.1 --mode offline --pack evidence` or `B3.2` for the combined offline journeys.
Artium journeys remain opt-in via `--artium <frozen-checkout>` and require an exact matching package pin.
Native Windows mutation commissioning remains pending.
The frozen Artium fixture owns hosted profile injection and role policy; it is local integration evidence, not a claim of released Artium support.

## Explicit native identity

```text
kubernetes-axi --native-config /absolute/kubeconfig get pods
kubernetes-axi --native-config ambient native -- --context=<context> get pods -o json
kubernetes-axi --native-config /absolute/kubeconfig --trust-exec get pods
kubernetes-axi --native-config /absolute/kubeconfig native -- config use-context <context>
```

`ambient` uses native KUBECONFIG precedence, or the platform home directory's `.kube/config` when it is unset.
An explicitly selected file does not merge other native files.
Native selection is refused when a standard profile is selected or injected.
The adapter resolves the selected context in memory and executes with an isolated temporary kubeconfig.
Ordinary reads leave the original native files unchanged, and cancellation removes temporary credentials.
Native context selection is available after `native --`; other identity, impersonation, raw-output and TLS-bypass flags remain refused.
Selected native kubeconfig users containing `as`, `as-uid`, `as-groups` or `as-user-extra` are also refused before cluster requests.
All native identities, including helpers, require explicit CA trust.

Helpers require explicit `--trust-exec` after reviewing the selected configuration.
A tool-owned shim brokers each ExecCredential acquisition or renewal over a private local socket.
The parent registers acquired credentials and encoded forms before returning them to kubectl.
Redaction covers literal, JavaScript and Go JSON-escaped, URI-encoded and base64 forms, including nested JSON escaping.
Raw helper output and failures never reach public streams.
The helper receives its native API version, cluster information and noninteractive execution information.
Its existing environment and cache remain helper-owned under the local ambient exception; credentials are never imported into AXI storage.
ExecCredential helper identities cannot use `prepare`, `confirm` or `server-dry-run` for resource mutations because the helper's actual principal is not bound to the preview.
These workflows fail with `AUTH_HELPER_MUTATION_UNAVAILABLE` before any API request or helper acquisition, including with `--trust-exec`.
Use a static token or client-certificate identity for mutations; helper reads, authorization reviews and identity reviews remain supported.
Principal binding for future helper mutations is tracked in [issue #19](https://github.com/knowttl/kubernetes-axi/issues/19).
Helpers requiring a terminal, legacy auth-provider plugins and native Windows helper channels fail explicitly; their commissioning remains pending.

Native configuration operations require a single explicit source path.
Successful edits atomically replace that source file, preserving other native sources.
Generic `config set`, credential argv writes and raw credential inspection are refused.
Public native Secret reads are refused; compact `get secrets` returns metadata only.
