# Deployment (Archived) / 部署说明（已归档）

This repository is no longer maintained as a Fly.io deployment target.

这个仓库现在不再维护 Fly.io 线上部署方案。

## Current Supported Mode / 当前支持方式

The only supported setup is local operation:

- `start-local-stack.bat`
- local Docker Compose infra for Postgres / MinIO / Prefect
- local `voxcpm-svc`
- local `whisperx-svc`
- local API and Web services

当前唯一官方支持的使用方式是本地运行：

- `start-local-stack.bat`
- 本地 Docker Compose 基础设施（Postgres / MinIO / Prefect）
- 本地 `voxcpm-svc`
- 本地 `whisperx-svc`
- 本地 API 与 Web 服务

## What Changed / 变化说明

The old Fly-specific files have been archived and are no longer active:

- GitHub Actions auto deploy workflow
- `fly.toml`
- single-container production `Dockerfile`
- Caddy / supervisor / startup scripts used by that container

旧的 Fly 专用文件已经整体归档，不再作为当前仓库的活配置：

- GitHub Actions 自动部署工作流
- `fly.toml`
- 单容器生产 `Dockerfile`
- 该容器使用的 Caddy / supervisor / 启动脚本

Archived copies are kept here:

- [`docs/archive/fly-deployment/`](archive/fly-deployment/)

归档文件统一保存在：

- [`docs/archive/fly-deployment/`](archive/fly-deployment/)

## No Longer Required / 不再需要

New users do not need to configure any of the following:

- `flyctl`
- `FLY_API_TOKEN`
- Fly app names
- Tigris buckets
- Fly Postgres

新用户现在不需要再配置以下内容：

- `flyctl`
- `FLY_API_TOKEN`
- Fly 应用名
- Tigris bucket
- Fly Postgres

## Recommendation / 建议

If you want to use this project, follow the local setup guides instead:

- [`../README.md`](../README.md)
- [`../WINDOWS-START.md`](../WINDOWS-START.md)

如果你要实际使用这个项目，请直接阅读本地启动文档：

- [`../README.md`](../README.md)
- [`../WINDOWS-START.md`](../WINDOWS-START.md)
