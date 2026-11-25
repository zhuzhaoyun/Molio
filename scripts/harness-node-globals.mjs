import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only free CommonJS globals receive these bindings. ESM sources can declare their own.
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = dirname(__filename);
