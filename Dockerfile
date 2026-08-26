# Builds from this fork's own PHP source (COPY . below), not a downloaded
# WordPress release tarball — this is what makes a PR's diff to this repo
# actually reflected in the image APIA tests, same reasoning as gitea's own
# bundled Dockerfile building from its own checkout.
FROM php:8.3-apache

RUN apt-get update && apt-get install -y \
        libzip-dev libpng-dev libjpeg-dev libfreetype6-dev libonig-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" mysqli gd zip exif \
    && a2enmod rewrite \
    && rm -rf /var/lib/apt/lists/*

COPY . /var/www/html/

# wp-config.php is gitignored (would contain secrets) — generated at
# container startup from env vars instead, see docker-entrypoint.sh.
RUN rm -f /var/www/html/wp-config.php \
    && chown -R www-data:www-data /var/www/html

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["apache2-foreground"]
