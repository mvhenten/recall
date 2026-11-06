-- The board, which is the other paradigm to the bus. `Mailbox.publish` hands a message to the
-- sockets open at that moment and keeps nothing, so a host that was not listening never sees one;
-- a board message waits until a session picks it up, and expires a week on so an unread one cannot
-- haunt the fleet forever. The rows live here rather than in the Durable Object because the
-- dashboard lists and posts them, and D1 is what every other dashboard view reads.
--
-- `scope` and `target` are the whole address, in the vocabulary `recall send` already resolves: a
-- post to the fleet is addressed to the account, one to a host to its device id, one to a session
-- to its session id. One pair rather than three columns that are each empty two thirds of the
-- time, and reading a session's board is one lookup over the three pairs it answers to. The fleet's
-- target is the account itself, which the CHECK holds the column to rather than leaving a fleet row
-- that names a host representable.
CREATE TABLE board_messages (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('fleet', 'host', 'session')),
  target TEXT NOT NULL CHECK (scope <> 'fleet' OR target = user_id),
  from_device_id TEXT NOT NULL,
  from_host TEXT NOT NULL,
  from_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

-- The pickup, which is the acknowledgement. One row per message, and the primary key is the whole
-- of the single-taker guarantee: two sessions booting together both insert, SQLite gives the row to
-- one of them, and the other is handed nothing. A message with no row here is still waiting.
CREATE TABLE board_pickups (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  host TEXT NOT NULL,
  picked_up_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
) WITHOUT ROWID;

-- What a pickup walks: the addresses one session answers to, oldest first.
CREATE INDEX board_by_address ON board_messages (user_id, scope, target, created_at, message_id);

-- What the dashboard lists, newest first.
CREATE INDEX board_by_posted ON board_messages (user_id, created_at DESC, message_id DESC);
