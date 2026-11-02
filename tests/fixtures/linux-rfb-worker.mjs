// Test double, never an actual VMware binary. Its executable is a private copy of Node
// named vmware-vmx so the production /proc socket/exe/argv inspection runs unmodified.
import { createServer, keysyms } from 'rfb2';
const connections = new Set();
let changed = false;
const server = createServer({ width: 16, height: 12, password: 'TestVNC1', version: '3.8', name: 'Linux integration test double' }, connection => {
  connections.add(connection);
  connection.on('close', () => connections.delete(connection));
  connection.on('error', () => {});
  connection.on('key', event => {
    if (event.down && event.keysym === keysyms.F2) changed = true;
    process.send({ kind: 'key', ...event });
  });
  connection.on('pointer', event => process.send({ kind: 'pointer', ...event }));
  connection.on('updateRequest', () => {
    const data = Buffer.alloc(16 * 12 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(changed ? [255, 0, 0, 0] : [0, 0, 255, 0], i);
    connection.sendUpdate([{ type: 'pixels', x: 0, y: 0, width: 16, height: 12, data }]);
  });
});
server.listen(0, '127.0.0.1', () => process.send({ kind: 'ready', port: server.address().port }));
process.on('disconnect', () => { for (const connection of connections) connection.destroy(); server.close(); });
