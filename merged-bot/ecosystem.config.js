module.exports = {
  apps: [
    {
      name: 'xyzstore-bot',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      // Logging — gabungkan stdout & stderr
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
