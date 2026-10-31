---
name: kubernetes-axi
description: Inspect Kubernetes resources, discovery, metrics and logs with bounded output and isolated credentials.
---

Read Kubernetes resources using isolated credentials and pinned kubectl v1.32.2.
Use --profile <name> to select an AXI identity.
Use native -- <kubectl arguments> for native output; native --profile is upstream profiling and is blocked because it writes files.
Reads are bounded; inspect complete, truncated and continue before treating output as complete.
Writes, execution, transfers, connections, credential overrides and streaming require later capability support and are refused.
Not yet supported (staged): diff requires the later file and external-helper execution capability. Native exit meanings remain 0 for no differences, 1 for differences, and greater than 1 for failure.
Run npx -y @knowttl/kubernetes-axi --help for available compact reads and npx -y @knowttl/kubernetes-axi native -- <command> --help for generated upstream flags.

