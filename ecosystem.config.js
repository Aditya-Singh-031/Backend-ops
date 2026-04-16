module.exports = {
  apps: [
    // 1. The Node.js Main API Gateway
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
    },
    // 2. The Python AI Parser Microservice
    {
      name: "backend-ops-python",
      script: "uvicorn",
      args: "api.main:app --host 127.0.0.1 --port 8000",
      cwd: "/home/azureuser/projects/backend-ops/python-parser",
      interpreter: "python3", // Or the path to your python venv, e.g., "/usr/bin/python3"
      env: {
        // PM2 will inject variables here if needed, but it will also read the .env
      },
      autorestart: true,
      max_memory_restart: "1G", // Python AI tasks need more RAM
      out_file: "~/.pm2/logs/backend-python-out.log",
      error_file: "~/.pm2/logs/backend-python-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    }
  ],
};