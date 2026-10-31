import { connect } from 'node:net';

// Only kubectl invokes this shim. Its stdout is the private ExecCredential pipe.
const socket = connect(process.argv[2]!);
let response = '';
socket.setEncoding('utf8');
socket.setTimeout(10_000, () => socket.destroy());
socket.on('connect', () => socket.end(JSON.stringify({ info: process.env.KUBERNETES_EXEC_INFO })));
socket.on('data', chunk => { response += chunk; if (response.length > 1024 * 1024) socket.destroy(); });
socket.on('error', () => { process.exitCode = 1; });
socket.on('end', () => {
  if (response) process.stdout.write(response);
  else process.exitCode = 1;
});
