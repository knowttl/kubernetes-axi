#!/usr/bin/env python3
"""Cross-platform public verification front door. No live modes are implemented."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "test"))
import b11  # noqa: E402

HASHES = {
    "fixtures/P-001.json": "5bb68b565b647ad87f70eead7b04f53392dbbd200e64eb5f9a435328ec4bdb63",
    "fixtures/P-006.json": "22ab7c898cedb6ae531887333fd28d56718d12ccb8f782bdd01573f0750ccf94",
    "docs/credential-standard-v2.txt": "f72fe2f0c6e39ec2cbdd143bd2eb5b432d58e134214059883ad61579d13690df",
}


class PendingPrerequisite(Exception):
    pass


def run_npm(npm, *args, **kwargs):
    try:
        return subprocess.run([npm, *args], check=True, capture_output=True, text=True, timeout=120, **kwargs)
    except FileNotFoundError as error:
        raise PendingPrerequisite("npm is required for offline package verification.") from error
    except subprocess.CalledProcessError as error:
        try:
            code = json.loads(error.stdout).get("error", {}).get("code")
        except (ValueError, AttributeError):
            code = None
        if code == "ENOTCACHED":
            raise PendingPrerequisite("Populate the offline npm dependency cache before verification.") from error
        raise


class Results(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = []

    def record(self, test, outcome):
        variant = test.id().rsplit(".", 1)[-1].removeprefix("test_")
        case = next((case for case in ["AC-BIN-001", "AC-001", "AC-006", "CC-001", "CC-002", "CC-003", "CC-007"] if variant.startswith(case.replace("-", "_"))), "B1.1-regression")
        self.cases.append({
            "task": "B1.1", "case": case, "variant": variant,
            "operation": "OP-001" if case == "AC-001" else "OP-006",
            "publicPath": "installed standalone CLI", "nativeOS": platform.system(),
            "apiVariant": "verified TLS loopback fake; retained envelopes and synthetic discovery",
            "outcome": outcome,
        })

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "pass")

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.record(test, "failure")

    def addError(self, test, error):
        super().addError(test, error)
        self.record(test, "failure")


def run(args):
    if platform.system() == "Linux" and not args.network_isolated:
        # The namespace has no uplink. Every descendant, including native kubectl,
        # inherits this boundary; a JavaScript transport mock cannot provide it.
        for executable in ["unshare", "ip"]:
            if shutil.which(executable) is None:
                raise PendingPrerequisite(f"{executable} is required for isolated offline Linux verification.")
        isolated = subprocess.run([
            "unshare", "--user", "--map-root-user", "--net", "--",
            sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--network-isolated",
        ], check=False, capture_output=True, text=True)
        if isolated.stderr.startswith("unshare:"):
            raise PendingPrerequisite("Permission to create an isolated user and network namespace is required.")
        sys.stdout.write(isolated.stdout)
        sys.stderr.write(isolated.stderr)
        return isolated.returncode
    if args.network_isolated:
        links = subprocess.run(["ip", "-json", "link", "show"], check=True, capture_output=True, text=True, timeout=10)
        if [link["ifname"] for link in json.loads(links.stdout)] != ["lo"]:
            raise ValueError("offline verification requires a loopback-only network namespace")
        subprocess.run(["ip", "link", "set", "lo", "up"], check=True, capture_output=True, timeout=10)
    pack = args.pack.resolve()
    if args.command == "task" and args.target in ("B2.1", "B2.2", "B2.3", "B2.4", "B3.1", "B3.2"):
        private = subprocess.run(["node", str(ROOT / "test/private-files.ts")], cwd=ROOT, timeout=30)
        if private.returncode:
            return private.returncode
        result = subprocess.run(
            ["unshare", "--user", "--map-root-user", "--net", "--", "sh", "-c",
             'ip link set lo up && exec node "$1" --pack "$2"', "verify-b2-b3", str(ROOT / "test/b2.ts"), str(pack)],
            cwd=ROOT, timeout=300,
        )
        if result.returncode or args.artium is None:
            return result.returncode
        return subprocess.run([
            sys.executable, str(Path(__file__).resolve()), "task", "B1.2", "--mode", "offline",
            "--pack", str(pack), "--artium", str(args.artium.resolve()), "--network-isolated",
        ], cwd=ROOT, timeout=180).returncode
    for relative, expected in HASHES.items():
        actual = hashlib.sha256((pack / relative).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"fixture digest mismatch: {relative}")
    report = {
        "task": args.target if args.command == "task" else None,
        "mode": "offline", "nativeOS": platform.system(), "nativePlatform": platform.platform(), "fixtureHashes": HASHES,
        "artiumRevision": None,
        "pending": ["B1.3 native Windows execution and ACL conformance"],
        "networkIsolation": "Linux network namespace, loopback only" if args.network_isolated else "native platform",
        "artium": {"outcome": "skipped", "reason": "Real Artium journeys are opt-in; supply --artium <frozen-checkout>."},
    }
    if args.artium is not None:
        report["artiumRevision"] = subprocess.run(
            ["git", "-C", str(args.artium.resolve()), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        archive = subprocess.run(["git", "-C", str(args.artium.resolve()), "archive", report["artiumRevision"]],
                                 check=True, capture_output=True, timeout=30).stdout
        report["artiumSourceArchiveSha256"] = hashlib.sha256(archive).hexdigest()
        report["artiumWorkingTreeDirty"] = bool(subprocess.run(
            ["git", "-C", str(args.artium.resolve()), "status", "--porcelain", "--untracked-files=no"],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout)
    if args.command == "task" and args.target not in ["B1.1", "B1.2", "B1.3"]:
        report.update(outcome="pending", prerequisite="Only B1.1, B1.2 and the Linux portion of B1.3 are implemented.")
        print(json.dumps(report, indent=2))
        return 2
    npm = "npm.cmd" if os.name == "nt" else "npm"
    for executable in [npm, "openssl"]:
        if shutil.which(executable) is None:
            raise PendingPrerequisite(f"{executable} is required for offline package verification.")
    with tempfile.TemporaryDirectory(prefix="kubernetes-axi-verify-") as temporary:
        directory = Path(temporary)
        packed = run_npm(
            npm, "pack", "--prefer-offline", "--json", "--pack-destination", str(directory),
            cwd=ROOT,
        )
        package = directory / json.loads(packed.stdout)[0]["filename"]
        report["packageSha256"] = hashlib.sha256(package.read_bytes()).hexdigest()
        prefix = directory / "installed"
        run_npm(
            npm, "install", "--prefer-offline", "--prefix", str(prefix), "--json", "--ignore-scripts", "--no-audit", "--no-fund", str(package),
        )
        b11.PACKAGE = prefix / "node_modules/@knowttl/kubernetes-axi"
        b11.PACK = pack
        b11.NEGATIVE_CONTROL = args.negative_control
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(b11.PackagedRead)
        result = unittest.TextTestRunner(verbosity=2, resultclass=Results).run(suite)
        report["cases"] = result.cases
        report["kubectlPins"] = json.loads((b11.PACKAGE / "kubectl-pins.json").read_text())
        passed = result.wasSuccessful() and result.testsRun > 0
        report["nativeStandalone"] = {"os": platform.system(), "outcome": "pass" if passed else "failure"}
        if passed and args.artium is not None:
            hosted = subprocess.run([
                "node", str(ROOT / "test/b12.ts"), str(args.artium.resolve()), str(pack), report["packageSha256"], str(b11.PACKAGE),
            ], cwd=args.artium.resolve(), capture_output=True, text=True, timeout=120)
            if hosted.returncode:
                sys.stderr.write(hosted.stderr)
                report["artium"] = {"outcome": "failure"}
                passed = False
            else:
                report["artium"] = json.loads(hosted.stdout)
        elif args.artium is None:
            sys.stderr.write("Artium journeys skipped: supply --artium <frozen-checkout> to opt in.\n")
        report["outcome"] = "pass" if passed else "failure"
        if passed and args.artium is None and (args.command != "task" or args.target != "B1.1"):
            report.update(outcome="pending", prerequisite="A frozen Artium checkout is required for B1.2 and the hosted Linux gate.")
        elif passed and (args.command != "task" or args.target == "B1.3"):
            report["outcome"] = "pending"
            report["prerequisite"] = "Native Windows is pending; Linux and WSL evidence cannot complete B1.3."
            if args.command == "release" or (args.command == "gate" and args.target != "1"):
                report["pending"].append("Stages beyond B1 are unimplemented")
        print(json.dumps(report, indent=2))
        return 0 if report["outcome"] == "pass" else 2 if report["outcome"] == "pending" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["task", "gate", "release"])
    parser.add_argument("target", nargs="?", help="B1.1, stage number, or release identifier")
    parser.add_argument("--mode", choices=["offline"], required=True)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--artium", type=Path, help="Opt in to real local Artium journeys using a frozen checkout with built dependencies")
    parser.add_argument("--network-isolated", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--negative-control", action="store_true", help="Corrupt the fake pod name; verification must fail")
    args = parser.parse_args()
    try:
        return run(args)
    except PendingPrerequisite as error:
        print(json.dumps({"outcome": "pending", "mode": "offline", "prerequisite": str(error)}))
        return 2
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Dependency output can include local paths; retain only the failure class.
        print(json.dumps({"outcome": "failure", "mode": "offline", "error": type(error).__name__, "message": "Check fixture hashes, cached package dependencies, pinned binaries and local test prerequisites."}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
