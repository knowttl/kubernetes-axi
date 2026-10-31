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
    pack = args.pack.resolve()
    for relative, expected in HASHES.items():
        actual = hashlib.sha256((pack / relative).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"fixture digest mismatch: {relative}")
    report = {
        "task": args.target if args.command == "task" else None,
        "mode": "offline", "nativeOS": platform.system(), "fixtureHashes": HASHES,
        "artiumRevision": None,
        "pending": ["B1.2 real local Artium public path", "B1.3 native platform stage gate"],
    }
    if args.artium is not None:
        report["artiumRevision"] = subprocess.run(
            ["git", "-C", str(args.artium.resolve()), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout.strip()
    if args.command == "task" and args.target != "B1.1":
        report.update(outcome="pending", prerequisite="Only B1.1 is implemented.")
        print(json.dumps(report, indent=2))
        return 2
    npm = "npm.cmd" if os.name == "nt" else "npm"
    for executable in [npm, "openssl"]:
        if shutil.which(executable) is None:
            raise PendingPrerequisite(f"{executable} is required for offline package verification.")
    with tempfile.TemporaryDirectory(prefix="kubernetes-axi-verify-") as temporary:
        directory = Path(temporary)
        packed = run_npm(
            npm, "pack", "--offline", "--json", "--pack-destination", str(directory),
            cwd=ROOT,
        )
        package = directory / json.loads(packed.stdout)[0]["filename"]
        report["packageSha256"] = hashlib.sha256(package.read_bytes()).hexdigest()
        prefix = directory / "installed"
        run_npm(
            npm, "install", "--prefix", str(prefix), "--offline", "--json", "--ignore-scripts", "--no-audit", "--no-fund", str(package),
        )
        b11.PACKAGE = prefix / "node_modules/@knowttl/kubernetes-axi"
        b11.PACK = pack
        b11.NEGATIVE_CONTROL = args.negative_control
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(b11.PackagedRead)
        result = unittest.TextTestRunner(verbosity=2, resultclass=Results).run(suite)
        report["cases"] = result.cases
        report["kubectlPins"] = json.loads((b11.PACKAGE / "kubectl-pins.json").read_text())
        passed = result.wasSuccessful() and result.testsRun > 0
        report["outcome"] = "pass" if passed else "failure"
        if args.command != "task" and passed:
            report["outcome"] = "pending"
            report["prerequisite"] = "Stage and release gates require tasks beyond B1.1; pending is not pass."
        print(json.dumps(report, indent=2))
        return 0 if report["outcome"] == "pass" else 2 if report["outcome"] == "pending" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["task", "gate", "release"])
    parser.add_argument("target", nargs="?", help="B1.1, stage number, or release identifier")
    parser.add_argument("--mode", choices=["offline"], required=True)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--artium", type=Path, help="Optional checkout revision to record; Artium is a B1.2 prerequisite")
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
