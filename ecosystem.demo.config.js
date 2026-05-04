module.exports = {
  apps: [
    {
      name: "backend-ops-demo",
      script: "src/server.js",
      cwd: "/home/azureuser/projects/backend-ops-demo",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: 5005,
      },
      autorestart: true,
      max_memory_restart: "500M",
      out_file: "~/.pm2/logs/backend-ops-demo-out.log",
      error_file: "~/.pm2/logs/backend-ops-demo-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
