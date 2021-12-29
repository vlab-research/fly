ALTER TABLE chatroach.states ADD CONSTRAINT valid_state_json CHECK (state_json ? 'state');
ALTER TABLE chatroach.states ADD CONSTRAINT fk_facebook_page_id FOREIGN KEY (pageid) REFERENCES chatroach.credentials(facebook_page_id) ON DELETE CASCADE;
