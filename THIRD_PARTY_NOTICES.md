# Third-party notices

The local package contains official kubectl v1.32.2 binaries from the Kubernetes project.
Copyright The Kubernetes Authors.
Kubectl is licensed under the Apache License, Version 2.0, reproduced in third-party/kubectl-LICENSE.txt.
Source: https://github.com/kubernetes/kubernetes/tree/v1.32.2.
The binary URLs and SHA-256 values are recorded in kubectl-pins.json.
These binaries are unmodified.

The generated protobuf schema and JSON field mappings derive from the official k8s.io/api and k8s.io/apimachinery v0.32.2 .proto and Go files, also under the Kubernetes Apache 2.0 license.
Source file SHA-256 pins and generation are recorded in scripts/generate-protobuf.ts.
The runtime npm dependencies @toon-format/toon, ajv and protobufjs are distributed by npm with their own license files.
No code was copied from the kubernetes-axi reference implementation.
