ALTER TABLE chatroach.states ADD COLUMN message_pointer TIMESTAMPTZ AS (FLOOR((state_json->>'pointer')::INT/1000)::INT::TIMESTAMPTZ) STORED;
