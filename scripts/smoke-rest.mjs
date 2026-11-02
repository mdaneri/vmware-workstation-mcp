import { Credentials } from '../src/credentials.mjs';
import { Workstation } from '../src/workstation.mjs';
import { RestClient, restOperations } from '../src/rest.mjs';
const credentials = new Credentials();
const rest = new RestClient({ credentials, backend: new Workstation() });
try {
  for (const name of ['getAllVMs', 'getAllNetworks']) {
    const result = await rest.execute(restOperations.find(o => o.id === name), {});
    console.log(JSON.stringify({ operation: name, status: result.status, data: result.data }));
  }
} catch (error) { console.error(credentials.redact(error.message)); process.exitCode = 1; }
