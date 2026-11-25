#!/usr/bin/env bash
set -euo pipefail
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d mybot_portal <<'SQL'
GRANT USAGE ON SCHEMA public TO mybot_portal_api,mybot_portal_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO mybot_portal_api,mybot_portal_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO mybot_portal_api,mybot_portal_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE mybot_portal_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO mybot_portal_api,mybot_portal_worker;
SQL
