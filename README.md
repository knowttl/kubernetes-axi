# kubernetes-axi

An agent-facing TypeScript CLI that runs pinned kubectl with an isolated identity.
This first development milestone implements **Plan task B1.1**, a server-version read and compact pod list through the installed standalone package.
Artium integration, complete command coverage and native platform commissioning belong to later plan tasks and remain pending.

```text
kubernetes-axi version --profile <name>
kubernetes-axi get pods --profile <name> --namespace <namespace>
```

Output is TOON.
Use `--help` for the current command surface, or `--version` for the package version without loading the command graph.
Pod output retains name, namespace, phase, continuation token, resource version and remaining item count.
This milestone performs one bounded list and does not follow the continuation token automatically.
It uses kubectl discovery followed by kubectl's raw GET transport for a page limited to 100 pods.
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
Python and OpenSSL are verification prerequisites, not product runtime dependencies.
No reference implementation code was copied.

Before installation, place the official binaries listed in kubectl-pins.json in `vendor/` using its recorded filenames.
Verify each against the official published URL plus `.sha256`.
The offline build checks both digests and never downloads a binary or falls back to PATH.
Dependency installation uses the npm registry; Kubernetes verification stays local.

```text
npm ci
npm run check
python3 scripts/verify.py task B1.1 --mode offline --pack evidence
```

Verification packs the product, installs that tarball into an isolated temporary prefix, and executes its public CLI.
Only the external Kubernetes API is fake.
It uses a verified TLS loopback server, two synthetic token identities and a synthetic client certificate.
Discovery responses are synthetic; see [evidence/README.md](evidence/README.md) for retained response provenance and the fixture integrity source.
The harness binds only 127.0.0.1, constructs all upstream URLs itself and accepts no external upstream endpoint.
Live modes are rejected.

The verification report records individual cases, native OS, package digest, fixture hashes and kubectl pins.
`--artium <checkout>` optionally records that checkout's revision; it does not claim Artium verification.
The `gate 1` and `release` entry points report the remaining prerequisites as pending and exit 2, even after B1.1 passes.
Pending never counts as pass.
Missing npm or OpenSSL also report pending and exit 2; integrity mismatches remain failures and exit 1.

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

All currently supported operations are reads.
KUBERNETES_AXI_READ_ONLY accepts only true, false, 1 or 0; no write journal is produced.
The broader native kubeconfig adapter, credential-management commands and hosted identity policy are later tasks.
