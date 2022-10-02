-- Swap out our key constraint for one on user/entity/key
DROP INDEX chatroach.credentials_entity_key_key CASCADE;
ALTER TABLE chatroach.credentials ADD CONSTRAINT unique_entity_key_per_user UNIQUE(userid, entity, KEY);

-- Add these columns to campaigns
ALTER TABLE chatroach.campaigns ADD COLUMN credentials_key VARCHAR;
ALTER TABLE chatroach.campaigns ADD COLUMN credentials_entity VARCHAR DEFAULT 'facebook_ad_user';

-- Create foreign key constraint with credentials
CREATE index ON chatroach.campaigns (userid, credentials_entity, credentials_key);
ALTER TABLE chatroach.campaigns ADD CONSTRAINT credentials_key_exists FOREIGN KEY (userid, credentials_entity, credentials_key) REFERENCES chatroach.credentials (userid, entity, KEY);
