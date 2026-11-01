---
name: kubernetes-axi
description: Inspect Kubernetes resources, discovery, metrics and logs with bounded output and isolated credentials.
---

Read Kubernetes resources using isolated credentials and pinned kubectl v1.32.2.
Use --profile <name> to select an AXI identity.
Use native -- <kubectl arguments> for native output; native --profile is upstream profiling and is blocked because it writes files.
Reads are bounded; inspect complete, truncated and continue before treating output as complete.
Writes default off. Explicitly enable KUBERNETES_AXI_READ_ONLY=false, then use prepare -- <mutation>, preview <request-key>, and confirm <request-key> --digest <preview-digest>.
Preparation reads exact targets; local preview makes no API calls. Confirmation is one-shot and refuses stale or changed targets. Bulk deletion also requires KUBERNETES_AXI_COLLECTION_DELETE=true.
Use server-dry-run -- <mutation> for explicit API validation without persistence.
Bounded non-interactive exec/attach and named debug mutations require preparation and confirmation. Token issuance additionally requires KUBERNETES_AXI_ACQUIRE_CREDENTIAL=true, a duration of at most one hour, and --credential-fd <inherited-private-pipe> before confirm. Issued tokens are delivered once and never retained. Local rendering/plugin helpers, transfers, proxy connections, credential overrides and interactive sessions remain refused.
Not yet supported (staged): diff requires the later file and external-helper execution capability. Native exit meanings remain 0 for no differences, 1 for differences, and greater than 1 for failure.
Run npx -y @knowttl/kubernetes-axi --help for available commands and npx -y @knowttl/kubernetes-axi native -- <command> --help for generated upstream flags.

