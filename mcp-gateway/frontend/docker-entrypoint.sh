#!/bin/sh
set -e

# Generate runtime JS env config.
# The frontend reads window.__env__ before falling back to import.meta.env.
# Keycloak values are public (PKCE, no client secret in the browser) so they
# are safe to expose here.
cat > /usr/share/nginx/html/env-config.js <<EOF
window.__env__ = {
  VITE_API_URL: "${VITE_API_URL:-/api}",
  VITE_KEYCLOAK_URL: "${VITE_KEYCLOAK_URL:-https://your-keycloak.example.com}",
  VITE_KEYCLOAK_REALM: "${VITE_KEYCLOAK_REALM:-your-realm}",
  VITE_KEYCLOAK_CLIENT_ID: "${VITE_KEYCLOAK_CLIENT_ID:-mcp-gateway}"
};
EOF

# Generate nginx config — substitute only GATEWAY_UPSTREAM so that nginx
# variables like $host, $remote_addr, etc. are left intact.
export GATEWAY_UPSTREAM="${GATEWAY_UPSTREAM:-http://gateway:8000}"
envsubst '${GATEWAY_UPSTREAM}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
