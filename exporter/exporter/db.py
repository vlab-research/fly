from .log import log
from sqlalchemy import create_engine

def setup_database_connection(db_url):
    log.info("setting up database connection")
    try:
        engine   = create_engine(db_url, pool_recycle=3600, pool_pre_ping=True)
        return engine.connect()
    except Exception as e:
        log.fatal("database connection failed")
        log.fatal(e)
        raise e
