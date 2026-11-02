// Executed by Node in automated tests instead of the optional native OVF Tool.
import fs from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
await fs.appendFile(process.env.OVF_TEST_CALLS, JSON.stringify(args) + '\n');
if (process.env.OVF_TEST_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.OVF_TEST_DELAY)));
const target = args.find(arg => arg.startsWith('--targetType='))?.split('=')[1];
const record = (type, payload) => console.log(`${type}\n${payload.split('\n').map(line => '+ ' + line).join('\n')}\n`);
if (target && process.env.OVF_TEST_FAIL_TRANSFER) { await fs.writeFile(args.at(-1), 'partial'); record('ERROR', '<Errors><Error>transfer failed</Error></Errors>'); record('RESULT', 'ERROR'); process.exit(1); }
if (process.env.OVF_TEST_FAIL) { record('ERROR', '<Errors><Error>test conversion failure</Error></Errors>'); record('RESULT', 'ERROR'); process.exit(1); }
if (process.env.OVF_TEST_NO_RESULT) process.exit(0);
if (!target) record('PROBE', '<probeResult><productInfo><name>Fixture</name></productInfo><sizes><flat>1024</flat></sizes><vms><vm id="vm"><virtualHardwares><virtualHardware><numberOfCpus>1</numberOfCpus><memory>268435456</memory><disks><disk><capacity>1024</capacity></disk></disks><nics><nic><network>Lab</network></nic></nics></virtualHardware></virtualHardwares></vm></vms><networks><network><name>Lab</name></network></networks><properties><property><key>password</key><value>never-return-default</value></property></properties><deploymentOptions><deploymentOption><id>small</id></deploymentOption></deploymentOptions></probeResult>');
else {
  let output = args.at(-1);
  if (target === 'VMX') {
    output = path.join(path.dirname(output), 'nested', 'machine.vmx');
    await fs.mkdir(path.dirname(output), { recursive: true });
  }
  await fs.writeFile(output, target === 'VMX' ? '.encoding = "UTF-8"\nmemsize = "256"\n' : 'fixture appliance');
  record('PROGRESS', '50\n100'); record('TARGET_ID', output);
  for (const argument of args.filter(arg => arg.startsWith('--prop:'))) console.log(argument);
}
record('RESULT', 'SUCCESS');
