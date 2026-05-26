module.exports = {
  apps : [{
    name   : "bot-ppob",
    script : "./bot.js",
    watch  : false,
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
      BOT_TOKEN: "TOKEN_ASLI_DISINI",
      // ... env vars lainnya
    },
    // Restart otomatis jika memori tembus 500MB (indikasi memory leak)
    max_memory_restart: "500M",
    // Restart otomatis jika crash
    autorestart: true 
  }]
}

