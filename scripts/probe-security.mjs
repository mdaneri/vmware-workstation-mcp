// Safe discovery only: never select a VM or load credential profiles.
import { Workstation } from '../src/workstation.mjs';
import { HardwareManager } from '../src/hardware.mjs';
import { SecurityManager } from '../src/security.mjs';
const backend = new Workstation();
const hardware = new HardwareManager({ backend });
console.log(JSON.stringify(await new SecurityManager({ backend, hardware }).capabilities(), null, 2));
