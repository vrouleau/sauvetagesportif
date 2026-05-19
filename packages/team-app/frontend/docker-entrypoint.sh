#!/bin/sh
# Substitute runtime env vars into the built index.html
sed -i "s|%%TURNSTILE_SITE_KEY%%|${TURNSTILE_SITE_KEY:-}|g" /usr/share/nginx/html/index.html
sed -i "s|%%SUPPORT_EMAIL%%|${SUPPORT_EMAIL:-}|g" /usr/share/nginx/html/index.html
exec "$@"
