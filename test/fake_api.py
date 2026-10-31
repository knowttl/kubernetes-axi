"""Synthetic discovery and TLS identities; retained responses supply version and pods."""
import copy
import http.server
import json
from pathlib import Path
import ssl
import subprocess
import threading
from urllib.parse import urlsplit


class FakeAPI:
    def __init__(self, directory, pack, negative_control=False):
        self.directory = Path(directory)
        self.version = json.loads((pack / "fixtures/P-001.json").read_text())["body"]
        self.pods = json.loads((pack / "fixtures/P-006.json").read_text())["body"]
        if negative_control:
            self.pods["items"][0]["metadata"]["name"] = "deliberately-wrong-pod"
        self.requests = []
        self.tokens = {"synthetic-selected-token+/=", "synthetic-competing-token+/="}
        self.status = 200
        self.echo = None
        self.server_minor = "32"
        self._openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=synthetic-ca")
        self._openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost")
        self._openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-copy_extensions", "copy")
        self._openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=synthetic-client")
        self._openssl("x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "1")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.directory / "server.crt", self.directory / "server.key")
        context.load_verify_locations(self.directory / "ca.crt")
        context.verify_mode = ssl.CERT_OPTIONAL
        api = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                bearer = self.headers.get("Authorization", "").removeprefix("Bearer ")
                certificate = self.connection.getpeercert()
                subject = certificate.get("subject", ()) if certificate else ()
                identity = "certificate" if (("commonName", "synthetic-client"),) in subject else bearer
                api.requests.append((self.path, identity))
                if identity != "certificate" and bearer not in api.tokens:
                    return self.send_json(401, {"kind": "Status", "apiVersion": "v1", "reason": "Unauthorized", "message": "Unauthorized", "code": 401})
                if api.status != 200:
                    return self.send_json(api.status, {"kind": "Status", "apiVersion": "v1", "reason": "Forbidden", "message": "Forbidden", "code": api.status})
                route = urlsplit(self.path).path
                # These three discovery envelopes are new synthetic variants.
                routes = {
                    "/api": {"kind": "APIVersions", "apiVersion": "v1", "versions": ["v1"], "serverAddressByClientCIDRs": []},
                    "/apis": {"kind": "APIGroupList", "apiVersion": "v1", "groups": []},
                    "/api/v1": {"kind": "APIResourceList", "apiVersion": "v1", "groupVersion": "v1", "resources": [
                        {"name": "pods", "singularName": "pod", "namespaced": True, "kind": "Pod", "verbs": ["get", "list"]}
                    ]},
                }
                if route == "/version":
                    version = copy.deepcopy(api.version)
                    version["minor"] = api.server_minor
                    return self.send_json(200, version)
                if route == "/api/v1/namespaces/kube-system/pods":
                    pods = copy.deepcopy(api.pods)
                    if api.echo is not None:
                        pods["metadata"]["continue"] = api.echo
                    return self.send_json(200, pods)
                if route in routes:
                    return self.send_json(200, routes[route])
                self.send_json(404, {"kind": "Status", "apiVersion": "v1", "reason": "NotFound", "code": 404})

            def send_json(self, status, body):
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"https://127.0.0.1:{self.server.server_port}"
        self.ca = (self.directory / "ca.crt").read_text()

    def _openssl(self, *args):
        subprocess.run(["openssl", *args], cwd=self.directory, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
