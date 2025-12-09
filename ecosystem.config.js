module.exports = {
  apps: [
    {
      name: "whatsapp-bot",
      script: "bot.js",
      watch: false,
      env: {
        TZ: "America/Argentina/Cordoba",
        LOG_LEVEL: "info"
      }
    }
  ]
}

