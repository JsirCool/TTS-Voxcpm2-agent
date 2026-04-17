# Archived Fly Deployment / 已归档的 Fly 部署方案

This directory preserves the old Fly.io production deployment files that used to ship with this repository.

本目录保留了仓库旧版的 Fly.io 生产部署文件，供历史追溯和未来参考使用。

## Status / 当前状态

- Archived: yes
- Supported: no
- Recommended for new setups: no

These files are no longer part of the active product path. The repository is now maintained as a local-only toolchain built around:

- `start-local-stack.bat`
- local Docker Compose infrastructure
- local `voxcpm-svc`
- local `whisperx-svc`
- local FastAPI + Next.js development services

这些文件已经不属于当前的官方使用路径。当前仓库只支持本地运行方案：

- `start-local-stack.bat`
- 本地 Docker Compose 基础设施
- 本地 `voxcpm-svc`
- 本地 `whisperx-svc`
- 本地 FastAPI + Next.js 服务

## Archived Files / 归档内容

- `deploy.yml`: old GitHub Actions workflow that ran `flyctl deploy`
- `fly.toml`: old Fly application config
- `Dockerfile.fly`: old single-container production image
- `Caddyfile`: old reverse proxy config for the Fly container
- `start.sh`: old container entrypoint
- `supervisord.conf`: old multi-process runtime config

## Why It Was Archived / 归档原因

The project no longer promises cloud hosting out of the box. Keeping these files active created confusion for new users because GitHub pushes could trigger a Fly deployment that was no longer part of the supported workflow.

这个项目不再默认承诺云端托管能力。继续保留这些文件为“活配置”会误导新用户，以为推送 GitHub 后还需要配置 Fly，而这已经不是当前支持的工作流。
