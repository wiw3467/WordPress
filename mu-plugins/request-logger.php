<?php
/**
 * Plugin Name: Lightweight Request Logger
 * Description: Logs basic request timing to disk for observability.
 *
 * Auto-loads as a must-use plugin, same as basic-auth.php — no
 * activation step needed.
 */

add_action( 'init', function () {
	$line = sprintf(
		"[%s] %s %s\n",
		gmdate( 'Y-m-d H:i:s' ),
		$_SERVER['REQUEST_METHOD'] ?? 'GET',
		$_SERVER['REQUEST_URI'] ?? '/'
	);
	file_put_contents( WP_CONTENT_DIR . '/request.log', $line, FILE_APPEND | LOCK_EX );
}, 1 );
