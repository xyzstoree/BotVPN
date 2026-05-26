module.exports = {
  apps: [
    {
      name: "sellvpn",
      script: "app.js",
      cwd: "/root/BotVPN",
      instances: 1,
      autorestart: true,
      watch: false
    }
  ],
};
