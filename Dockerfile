# Builds from this fork's own PHP source (COPY . below), not a downloaded
# WordPress release tarball — this is what makes a PR's diff to this repo
# actually reflected in the image APIA tests, same reasoning as gitea's own
# bundled Dockerfile building from its own checkout.
FROM php:8.3-apache

RUN apt-get update && apt-get install -y \
        libzip-dev libpng-dev libjpeg-dev libfreetype6-dev libonig-dev \
        libmemcached-dev zlib1g-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" mysqli gd zip exif \
    && pecl install memcache && docker-php-ext-enable memcache \
    && a2enmod rewrite \
    && rm -rf /var/lib/apt/lists/*

COPY . /var/www/html/

# mu-plugins auto-load with no activation step — CI-only Basic Auth for
# REST API writes, see mu-plugins/basic-auth.php for why.
COPY mu-plugins/basic-auth.php /var/www/html/wp-content/mu-plugins/basic-auth.php

# object-cache.php is a WordPress "drop-in", not a plugin — it must live
# directly in wp-content/ to auto-load, unlike mu-plugins/. This is the real,
# official Automattic/wp-memcached drop-in (used on WordPress.com), wiring
# the memcached pod up as WP's actual object cache — previously deployed but
# never connected to anything. Needs the memcached_servers global defined,
# see docker-entrypoint.sh.
COPY drop-ins/object-cache.php /var/www/html/wp-content/object-cache.php

# wp-config.php is gitignored (would contain secrets) — generated at
# container startup from env vars instead, see docker-entrypoint.sh.
RUN rm -f /var/www/html/wp-config.php \
    && chown -R www-data:www-data /var/www/html

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["apache2-foreground"]
