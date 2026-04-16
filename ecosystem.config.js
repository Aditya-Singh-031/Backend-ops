module.exports = {
  apps: [
    {
      name: "backend-ops-node",
      script: "src/server.js",
      cwd: "/home/azureuser/projects/backend-ops",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: 5003,
      },
      autorestart: true,
      max_memory_restart: "500M",
      out_file: "~/.pm2/logs/backend-node-out.log",
      error_file: "~/.pm2/logs/backend-node-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    }
  ],
};