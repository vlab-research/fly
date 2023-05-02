import os

import logging
# logging config

APP_NAME=os.getenv('APP_NAME', 'exporter')
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(APP_NAME)
