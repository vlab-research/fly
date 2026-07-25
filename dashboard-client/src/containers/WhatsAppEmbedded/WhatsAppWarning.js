import React from 'react';
import { Alert } from 'antd';

const WhatsAppWarning = () => (
  <Alert
    type="warning"
    message="Temporary Demonstration"
    description="This WhatsApp Business Account connection is a temporary demonstration for Meta App Review. This feature may change or be removed in future updates."
    closable
    style={{ marginBottom: '20px' }}
  />
);

export default WhatsAppWarning;
