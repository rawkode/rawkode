import m0000 from './20260910101158_initial/migration.sql';
import m0001 from './20260910215603_contact_entity_outbox/migration.sql';
import m0002 from './20260910221844_projection_quarantine/migration.sql';
import m0003 from './20260910222124_projection_quarantine_index/migration.sql';

  export default {
    migrations: {
      "20260910101158_initial": m0000,
"20260910215603_contact_entity_outbox": m0001,
"20260910221844_projection_quarantine": m0002,
"20260910222124_projection_quarantine_index": m0003
}
  }
  