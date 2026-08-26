#!/bin/bash
# Generates wp-config.php from wp-config-sample.php (both committed in this
# repo) at container startup, filling in DB connection details from env vars
# and generating real random secret keys locally — avoids depending on an
# external network call to the WordPress.org secret-key API during CI runs.
set -euo pipefail

WP_CONFIG=/var/www/html/wp-config.php

if [ ! -f "$WP_CONFIG" ]; then
  cp /var/www/html/wp-config-sample.php "$WP_CONFIG"

  sed -i "s/database_name_here/${WORDPRESS_DB_NAME:-wordpress}/" "$WP_CONFIG"
  sed -i "s/username_here/${WORDPRESS_DB_USER:-wordpress}/" "$WP_CONFIG"
  sed -i "s/password_here/${WORDPRESS_DB_PASSWORD:-wordpress}/" "$WP_CONFIG"
  sed -i "s/localhost/${WORDPRESS_DB_HOST:-mysql}/" "$WP_CONFIG"

  # Each of the 8 placeholder keys gets its own random 64-char value —
  # sed -i with an escaped random string, one occurrence at a time so
  # each key gets a genuinely different value, not all 8 the same.
  for KEY in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY \
             AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do
    VALUE=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 64)
    php -r "
      \$file = '$WP_CONFIG';
      \$content = file_get_contents(\$file);
      \$content = preg_replace(
        \"/define\\( '$KEY',\\s+'put your unique phrase here' \\);/\",
        \"define( '$KEY', '$VALUE' );\",
        \$content, 1
      );
      file_put_contents(\$file, \$content);
    "
  done

  chown www-data:www-data "$WP_CONFIG"
fi

echo "wp-config ready, starting apache"
exec docker-php-entrypoint "$@"
