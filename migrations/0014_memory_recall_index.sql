-- Memory, most recalled. The name breaks the tie so the keyset cursor walks a total order.
CREATE INDEX memories_by_recall_count ON memories (user_id, recall_count DESC, name);
