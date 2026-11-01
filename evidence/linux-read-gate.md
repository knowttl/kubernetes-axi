# Packaged Linux read evidence

The B1.2 verifier passed 21 installed standalone checks and 34 hosted variants against the controlled TLS Kubernetes API.
The hosted route used the real Artium CLI, listening server, credential store, runner, installed Kubernetes package and pinned kubectl.
All test descendants ran inside a Linux user and network namespace containing only loopback.
The host role grant covers the Kubernetes tool; operation-specific role grants are not claimed.
Both token and certificate cancellation removed the private profile, native kubeconfig, materialized key and caches beneath the call workspace.
No real cluster, credentials or developer kubeconfig were used.

| Input | Immutable identifier |
| --- | --- |
| Artium frozen revision | `e9dd034159d70b62be9df8742827d4b7123f4e4f` |
| Artium Git archive SHA-256 | `b74b074157d2bc5f1404c1910251b19a6adff0fb6f476c70cc64472a353b5fea` |
| Kubernetes package SHA-256 | `b67d569bfbe6d1483aac35b8508d75d971e59defaeb7aea2a51fef4d6d7ffe5b` |
| Official kubectl | `v1.32.2`, Linux amd64 |
| kubectl SHA-256 | `4f6a959dcc5b702135f8354cc7109b542a2933c46b808b248a214c1f69f817ea` |
| P-001 SHA-256 | `5bb68b565b647ad87f70eead7b04f53392dbbd200e64eb5f9a435328ec4bdb63` |
| P-006 SHA-256 | `22ab7c898cedb6ae531887333fd28d56718d12ccb8f782bdd01573f0750ccf94` |
| Credential standard capture SHA-256 | `f72fe2f0c6e39ec2cbdd143bd2eb5b432d58e134214059883ad61579d13690df` |

The observed operating system was Linux x86_64 on kernel `6.6.87.2-microsoft-standard-WSL2`, with Node `24.14.0`.
WSL supplies Linux evidence only.
Native Windows remains pending and has no simulated pass.
See [README.md](../README.md#development) for verification commands, prerequisites and pending-result semantics.
