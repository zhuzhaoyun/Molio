import { openDatabase, closeDatabase } from '../apps/daemon/src/core/db.js';
import { backfillConversationVaults } from '../apps/daemon/src/scripts/backfill-conversation-vaults.js';

const db = openDatabase();
backfillConversationVaults(db);
closeDatabase();
console.log('backfill-conversation-vaults: done');