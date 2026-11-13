import { z } from 'zod';

// Zod selects its parser when a schema is created. Import this before modules
// that declare schemas so the packaged entrypoints use interpreted validation.
z.config({ jitless: true });
