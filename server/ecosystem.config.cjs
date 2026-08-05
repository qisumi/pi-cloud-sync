/**
 * pm2 生态配置文件
 *
 * 使用：
 *   npm run build                     # 首次部署需要构建
 *   pm2 start ecosystem.config.cjs    # 或 npm run pm2:start
 *   pm2 save                          # 保存进程列表，开机自启（配合 pm2 startup）
 *
 * 注意：
 * - 使用 fork 模式（单进程）：SQLite 写库为单写者，cluster 多进程会互相争锁。
 * - 环境变量来自 .env（若存在）；也可以直接用 shell 环境或本文件 env 块。
 * - 日志输出到 ./logs/。
 */
module.exports = {
  apps: [
    {
      name: "pi-cloud-sync",
      script: "dist/index.js",
      cwd: __dirname,
      interpreter: "node",
      // fork 模式：单进程，保证 SQLite 单写者
      exec_mode: "fork",
      instances: 1,
      // 崩溃自动重启
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      // 内存保护：超过 512MB 自动重启
      max_memory_restart: "512M",
      // 监听 .env（存在时自动加载）
      env_file: ".env",
      env: {
        NODE_ENV: "production",
        SYNC_HOST: "0.0.0.0",
        SYNC_PORT: "8787",
        SYNC_DATA_DIR: "./data",
      },
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      time: true,
    },
  ],
};
