// A native stream test double, not VMware. Tests copy Node to vmware-vmx[.exe]
// so production pipe PID and /proc ownership checks run without special hooks.
import net from 'node:net';
const endpoint = process.argv[2];
const clients = new Set();
const server = net.createServer(client => {
  clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
  client.on('data', bytes => client.write(bytes));
});
server.listen(endpoint, () => process.send({ ready: true }));
process.on('disconnect', () => { for (const client of clients) client.destroy(); server.close(); });
