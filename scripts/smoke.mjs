import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const client = new Client({ name: 'vmware-read-only-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 123);
  console.log(`MCP connected; discovered ${tools.length} tools.`);
  const capabilities = await client.callTool({ name: 'workstation_capabilities', arguments: {} });
  assert.ok(!capabilities.isError, JSON.stringify(capabilities));
  const coverage = JSON.parse(capabilities.content[0].text);
  assert.deepEqual(coverage.unimplementedInstalledCommands, []);
  assert.deepEqual(coverage.catalogCommandsMissingFromInstalledHelp, []);
  console.log(JSON.stringify({ vmrunVersion: coverage.vmrunVersion, vmrunCommands: coverage.vmrunCommands.length, restOperations: coverage.restOperations.length, missing: coverage.unimplementedInstalledCommands }));
  for (const name of ['workstation_status', 'list_vms']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.ok(!result.isError, JSON.stringify(result));
    const data = JSON.parse(result.content[0].text);
    console.log(name === 'list_vms' ? JSON.stringify({ tool: name, inventoryCount: data.vms.length, runningCount: data.vms.filter(v => v.running).length, warnings: data.warnings }) : JSON.stringify({ tool: name, ...data }));
    if (name === 'list_vms') {
      const running = data.vms.find(vm => vm.running && vm.exists);
      if (running) {
        for (const tool of ['get_vm_details', 'list_snapshots', 'get_guest_ip', 'vmrun_check_tools_state']) {
          const inspection = await client.callTool({ name: tool, arguments: { vmx: running.vmx } });
          // Tools/IP support varies per guest. Report it without changing the VM.
          console.log(JSON.stringify({ tool, isError: !!inspection.isError, result: JSON.parse(JSON.stringify(inspection.content)) }));
          if (!['get_guest_ip'].includes(tool)) assert.ok(!inspection.isError);
        }
      }
    }
  }
  const networks = await client.callTool({ name: 'vmrun_list_host_networks', arguments: {} });
  assert.ok(!networks.isError, JSON.stringify(networks));
  console.log('Host network listing succeeded.');
  const invalid = await client.callTool({ name: 'vm_power', arguments: { vmx: 'relative.vmx', action: 'start' } });
  assert.equal(invalid.isError, true);
  console.log('Invalid VM target rejected before execution. No VM changes were made.');
} finally {
  await client.close();
}
