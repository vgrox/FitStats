ALTER TABLE sync_state ADD COLUMN last_successful_insert_count INTEGER
  CHECK (last_successful_insert_count >= 0);
