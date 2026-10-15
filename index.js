// Entry point for Discord bot hosting panels (Pterodactyl and the like),
// which run one JavaScript file with plain `node`. Node 24 runs the
// TypeScript source directly, so there is no build step. Docker and the
// systemd unit run the bundled dist/bot.js instead.
import './src/index.ts';
