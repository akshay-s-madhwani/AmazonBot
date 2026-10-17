const path = require('node:path');
module.exports = {
  apps: [
    {
      name: 'bot-manager', cwd: path.join(__dirname, 'bot'),
      script: 'dist/manager.js', instances: 1, exec_mode: 'fork',
      autorestart: true, restart_delay: 3000, kill_timeout: 15000,
      shutdown_with_message: true, time: true,
    },
    {
      name: 'deploy-webhook', cwd: path.join(__dirname, 'bot'),
      script: 'dist/deployment/webhook.js', instances: 1, exec_mode: 'fork',
      autorestart: true, restart_delay: 10000, kill_timeout: 30000,
      shutdown_with_message: true, time: true,
    },
  ],
};
