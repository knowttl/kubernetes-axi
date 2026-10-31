"""B1.1 outcomes through the installed CLI, never an in-process replacement."""
import base64
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import time
import unittest
from urllib.parse import quote
from urllib.parse import parse_qs, urlsplit

from fake_api import FakeAPI

PACKAGE = None
PACK = None
NEGATIVE_CONTROL = False


class PackagedRead(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="kubernetes-axi-test-")
        cls.root = Path(cls.workspace.name)
        cls.api = FakeAPI(cls.root, PACK, NEGATIVE_CONTROL)

    @classmethod
    def tearDownClass(cls):
        cls.api.close()
        cls.workspace.cleanup()

    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.sandbox.cleanup)
        self.home = Path(self.sandbox.name)
        self.temp = self.home / "tmp"
        self.temp.mkdir(mode=0o700)
        self.profile = {
            "origin": self.api.origin, "auth": "token", "namespace": "kube-system",
            "certificateAuthority": self.api.ca, "token": {"env": "SELECTED_TOKEN"},
        }
        self.config = self.home / "config.json"
        self.save_profile()
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(("KUBERNETES_", "KUBECONFIG", "XDG_"))}
        self.env.update({
            "HOME": str(self.home), "USERPROFILE": str(self.home),
            "APPDATA": str(self.home), "LOCALAPPDATA": str(self.home),
            "XDG_CONFIG_HOME": str(self.home), "TMPDIR": str(self.temp), "TMP": str(self.temp), "TEMP": str(self.temp),
            "KUBERNETES_AXI_CONFIG": str(self.config), "SELECTED_TOKEN": "synthetic-selected-token+/=",
        })
        self.api.requests.clear()
        self.api.echo = None
        self.api.status = 200
        self.api.server_minor = "32"

    def save_profile(self):
        self.config.write_text(json.dumps({"version": 1, "defaultProfile": "selected", "profiles": {"selected": self.profile}}))
        self.config.chmod(0o600)

    def run_cli(self, *args, package=None):
        command = ["node", str((package or PACKAGE) / "bin/kubernetes-axi.js"), *args]
        result = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.stderr, "")
        self.assertEqual(list(self.temp.iterdir()), [], "invocation credentials and caches must be removed")
        return result

    def read_pods(self, *flags):
        result = self.run_cli("get", "pods", *flags)
        self.assertEqual(result.returncode, 0, result.stdout)
        return self.decode_output(result.stdout)

    def decode_output(self, text):
        result = subprocess.run(
            ["node", "--input-type=module", "-e", "import { decode } from '@toon-format/toon'; import { readFileSync } from 'node:fs'; console.log(JSON.stringify(decode(readFileSync(0, 'utf8'))));"],
            cwd=PACKAGE, input=text, check=True, capture_output=True, text=True, timeout=10,
        )
        return json.loads(result.stdout)

    def expect_error(self, code, *args, package=None):
        result = self.run_cli(*args, package=package)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.decode_output(result.stdout)["error"]["code"], code)
        self.assertNotIn("synthetic-selected-token", result.stdout)
        self.assertEqual(self.api.requests, [], "rejected input must not reach Kubernetes")

    def test_AC_001_server_version(self):
        result = self.run_cli("version")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.decode_output(result.stdout)["gitVersion"], self.api.version["gitVersion"])

    def test_installed_version_fast_path(self):
        shim = PACKAGE.parent.parent / ".bin" / ("kubernetes-axi.cmd" if os.name == "nt" else "kubernetes-axi")
        baseline_times = []
        version_times = []
        for _ in range(5):
            started = time.perf_counter()
            subprocess.run(["node", "-e", "console.log(1)"], env=self.env, check=True, capture_output=True, timeout=10)
            baseline_times.append(time.perf_counter() - started)
            started = time.perf_counter()
            result = subprocess.run([str(shim), "--version"], env=self.env, capture_output=True, text=True, timeout=10, shell=os.name == "nt")
            version_times.append(time.perf_counter() - started)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "0.1.0\n", ""))
        self.assertLess(statistics.median(version_times), statistics.median(baseline_times) * 4)
        self.assertEqual(self.api.requests, [])

    def test_AC_006_pod_and_continuation(self):
        output = self.read_pods()
        self.assertEqual(output["pods"], [{"name": "resource-008", "namespace": "kube-system", "phase": "Running"}])
        self.assertEqual(output["continue"], "opaque-page-020")
        self.assertEqual(output["resourceVersion"], "145743580")
        self.assertEqual(output["remainingItemCount"], 18)
        paths = {path.split("?")[0] for path, _ in self.api.requests}
        self.assertTrue({"/api", "/apis", "/api/v1", "/api/v1/namespaces/kube-system/pods"}.issubset(paths))
        pages = [urlsplit(path) for path, _ in self.api.requests if urlsplit(path).path.endswith('/pods')]
        self.assertEqual([parse_qs(page.query).get("limit") for page in pages], [["100"]])
        self.assertEqual([parse_qs(page.query).get("continue") for page in pages], [None])

    def test_CC_001_explicit_file_beats_competing_environment(self):
        self.env.update({
            "KUBERNETES_AXI_ORIGIN": self.api.origin, "KUBERNETES_AXI_AUTH": "token",
            "KUBERNETES_AXI_CERTIFICATE_AUTHORITY": self.api.ca,
            "KUBERNETES_AXI_TOKEN": "synthetic-competing-token+/=",
        })
        result = self.run_cli("--profile", "selected", "get", "pods")
        self.assertEqual(result.returncode, 0, result.stdout)
        output = self.decode_output(result.stdout)
        self.assertEqual(output["source"], "file:selected")
        self.assertEqual({identity for _, identity in self.api.requests}, {"synthetic-selected-token+/="})

    def test_CC_002_partial_environment_fails_before_network(self):
        self.env["KUBERNETES_AXI_ORIGIN"] = self.api.origin
        self.expect_error("CONFIG_INVALID", "get", "pods")

    def test_CC_002_inline_secret_fails_before_network(self):
        self.profile["token"] = "synthetic-selected-token+/="
        self.save_profile()
        self.expect_error("CONFIG_INVALID", "get", "pods")

    def test_CC_002_invalid_secret_reference_fails_before_network(self):
        self.profile["token"] = {"env": "invalid name"}
        self.save_profile()
        self.expect_error("CONFIG_INVALID", "get", "pods")

    def test_CC_002_secret_argv_fails_before_network(self):
        self.expect_error("USAGE", "get", "pods", "--token=synthetic-selected-token+/=")

    def test_CC_003_environment_identity(self):
        self.env.update({
            "KUBERNETES_AXI_ORIGIN": self.api.origin, "KUBERNETES_AXI_AUTH": "token",
            "KUBERNETES_AXI_CERTIFICATE_AUTHORITY": self.api.ca, "KUBERNETES_AXI_NAMESPACE": "kube-system",
            "KUBERNETES_AXI_TOKEN": "synthetic-competing-token+/=",
        })
        self.assertEqual(self.read_pods()["source"], "environment")
        self.assertEqual({identity for _, identity in self.api.requests}, {"synthetic-competing-token+/="})

    def test_CC_003_protected_file_identity(self):
        secret = self.home / "secret"
        secret.write_text("\ufeffsynthetic-selected-token+/=\n")
        secret.chmod(0o400)
        self.profile["token"] = {"file": str(secret)}
        self.save_profile()
        self.assertEqual(self.read_pods()["pods"][0]["name"], "resource-008")
        self.assertEqual({identity for _, identity in self.api.requests}, {"synthetic-selected-token+/="})

    def test_CC_003_certificate_identity(self):
        self.profile.update({"auth": "certificate", "clientCertificate": (self.root / "client.crt").read_text(), "privateKey": {"file": str(self.root / "client.key")}})
        del self.profile["token"]
        (self.root / "client.key").chmod(0o600)
        self.save_profile()
        self.assertEqual(self.read_pods()["pods"][0]["phase"], "Running")
        self.assertEqual({identity for _, identity in self.api.requests}, {"certificate"})

    def test_CC_003_secret_forms_redacted(self):
        secret = self.env["SELECTED_TOKEN"]
        forms = [secret, json.dumps(secret)[1:-1], quote(secret, safe="~()*!.'-"), base64.b64encode(secret.encode()).decode()]
        self.api.echo = "|".join(forms)
        output = self.read_pods()
        self.assertEqual(output["pods"][0]["name"], "|".join(["[REDACTED]"] * len(forms)))

    def test_CC_007_missing_authentication_does_not_prompt(self):
        del self.env["SELECTED_TOKEN"]
        self.expect_error("AUTH_REQUIRED", "get", "pods")

    def test_AC_BIN_001_competing_path_binary_is_ignored(self):
        decoy = self.home / ("kubectl.exe" if os.name == "nt" else "kubectl")
        decoy.write_text("invalid executable canary")
        decoy.chmod(0o700)
        self.env["PATH"] = str(self.home) + os.pathsep + self.env["PATH"]
        pins = json.loads((PACKAGE / "kubectl-pins.json").read_text())
        output = self.read_pods()
        self.assertEqual(output["kubectlVersion"], "v1.32.2")
        key = "win32-x64" if os.name == "nt" else "linux-x64"
        self.assertEqual(output["kubectlSha256"], pins["binaries"][key]["sha256"])

    def test_AC_BIN_001_tampered_binary_is_rejected(self):
        modules = self.home / "node_modules"
        shutil.copytree(PACKAGE.parent.parent, modules)
        damaged = modules / "@knowttl/kubernetes-axi"
        key = "kubectl-windows-amd64.exe" if os.name == "nt" else "kubectl-linux-amd64"
        with (damaged / "vendor" / key).open("ab") as binary:
            binary.write(b"tampered")
        self.expect_error("BINARY_INTEGRITY", "get", "pods", package=damaged)

    def test_AC_BIN_001_incompatible_server_is_rejected(self):
        self.api.server_minor = "34"
        result = self.run_cli("get", "pods")
        self.assertEqual(self.decode_output(result.stdout)["error"]["code"], "BINARY_INCOMPATIBLE")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual({path.split("?")[0] for path, _ in self.api.requests}, {"/version"})

    def test_untrusted_tls_is_not_bypassed(self):
        self.profile["certificateAuthority"] = (self.root / "client.crt").read_text()
        self.save_profile()
        self.expect_error("UPSTREAM_FAILED", "get", "pods")

    def test_unknown_flag_is_rejected_before_network(self):
        self.expect_error("USAGE", "get", "pods", "--namespce", "kube-system")

    def test_upstream_denial_is_not_empty_success(self):
        self.api.status = 403
        result = self.run_cli("get", "pods")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.decode_output(result.stdout)["error"]["code"], "ACCESS_DENIED")

    def test_default_output_is_compact_toon(self):
        result = self.run_cli("get", "pods")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("pods[1]{name,namespace,phase}:\n  resource-008,kube-system,Running\n", result.stdout)
        self.assertIn("continue: opaque-page-020\n", result.stdout)
