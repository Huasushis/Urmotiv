# 已部署站点：启动、停止和故障恢复

这是当前 `ssh kk` 生产环境的操作入口；首次安装新服务器看[部署指南](deployment.md)。生产目录为 `/root/urmotiv-production-20260919`，Compose 项目名为 `urmotiv-production`。普通启停使用已经安装的镜像，不下载源码、不构建、不迁移、不重新导入题库。

## 服务器重启后，先执行这三步

```bash
ssh kk
sudo systemctl start urmotiv-production
sudo /root/urmotiv-production-20260919/urmotivctl check
```

成功时八个容器均为 running，数据库、API、后台任务、检索服务检查正常。然后浏览器打开站点登录；容器正常不代表公网隧道一定正常。

## 日常操作

在 `kk` 上执行：

| 操作 | 命令 |
| --- | --- |
| 启动整套服务 | `sudo systemctl start urmotiv-production` |
| 完整重启 | `sudo systemctl restart urmotiv-production` |
| 停止整套服务，保留数据 | `sudo systemctl stop urmotiv-production` |
| 容器和应用健康状态 | `sudo /root/urmotiv-production-20260919/urmotivctl status` |
| 开机自动启动 | `sudo systemctl enable urmotiv-production` |
| 取消开机自动启动 | `sudo systemctl disable urmotiv-production` |
| 查看最近启动过程 | `sudo journalctl -u urmotiv-production -n 80 --no-pager` |

systemd 的 active 表示启动命令已经完成，不代替应用健康检查；检查业务服务应运行 `urmotivctl check`。如果 unit 显示 active 而有人手动停了容器，可执行 `urmotivctl start` 补启动，或执行完整 restart。

没有 systemd 的主机，可在生产目录执行 `./urmotivctl start`、`stop`、`restart`、`status`、`check`。脚本与 `fermata-maintenance.mjs` 须放在一起。不要混用其他目录的 compose 文件。

停止和重启会先暂停 Fermata 领取新题，等待在途请求结束，再停后台任务、网页和 API，最后停止数据服务。默认最多等待一小时；超时会报错并保留服务，不强杀正常模型请求。此时可用 `./urmotivctl start` 恢复领取，或等任务结束再操作。管理员原先关闭的 Fermata 不会被脚本擅自开启。临时修改等待秒数可用 `URMOTIV_DRAIN_TIMEOUT=7200 ./urmotivctl restart`。

## 哪些文件必须保留

| 位置 | 内容 |
| --- | --- |
| `compose.yaml`、`nginx.conf` | 服务和网页代理配置 |
| `urmotiv.env`、`fermata.env`、`anklang.env` | 私有连接凭据和加密主密钥 |
| `fermata-data/` | 审题配置及配套 `settings.json.key`，必须一起保留 |
| Docker 的 `urmotiv-production_*` 数据卷 | PostgreSQL、附件对象、队列、检索数据、备份配置 |
| `urmotivctl`、`fermata-maintenance.mjs` | 日常启停与任务排空 |
| `/etc/systemd/system/urmotiv-production.service` | 生产应用开机启动 |

密码、注册、SMTP 和插件配置还存放在数据库/加密配置中，不只是 env。环境文件不能用 shell `source` 加载；不要把 `docker compose config` 的完整结果或私有日志上传公开 issue。

## 网页打不开的检查顺序

1. `systemctl is-active docker urmotiv-containerd urmotiv-production`。Docker 未运行先启动 Docker；应用失败查看上面的 journal。
2. `./urmotivctl status`。端口均为本机回环：网页 8080、API 3000、Worker 3010、Fermata 8720、Anklang 8730、PostgreSQL 15432、Redis 16379、MinIO 19000。
3. `curl --noproxy '*' --fail http://127.0.0.1:8080/api/v1/health/ready`。本机成功但公网失败时检查 Cloudflare 隧道，别反复重建数据库。
4. 本机失败时用 `docker compose --env-file urmotiv.env logs --tail=50 api worker web` 在服务器私下查看错误，不把原始题目、密钥或个人信息复制到公开位置。

## 2026-10-03：systemd 接错容器存储

这次不是需要重新导入数据：旧 containerd 存储位于 `/var/lib/docker/containerd/daemon`，systemd 的 Docker 却连接 `/run/containerd/containerd.sock`，使用 `/var/lib/containerd`。因此 `docker ps -a` 还能列出记录，而 `docker inspect` 和镜像查询报不存在，日志有 `RW layer ... not found`。

已为这台机器安装 `urmotiv-containerd.service`，显式使用旧数据目录和 `/run/urmotiv-containerd/containerd.sock`；Docker 的 drop-in `docker.service.d/urmotiv-managed-containerd.conf` 固定连接该 socket。原容器和镜像因此恢复。配置副本与修改前元数据备份放在生产目录。后续升级 Docker 要保留这条连接关系，不要同时启动两个运行时读写同一个存储目录。

核对命令：

```bash
systemctl show docker -p ExecStart
systemctl status urmotiv-containerd --no-pager
docker image inspect urmotiv-final-20260828-api:latest --format '{{.Id}}'
```

这是这台服务器已有存储的兼容修复，不是新部署通用步骤。不要在其他 Docker 主机直接套用这些路径。没有修改 Windows/WSL 启动设置，也未测试整机重启；systemd 服务只会在 Linux 实例实际启动之后工作。

对应配置源文件也保存在 [`deploy/compat/`](../deploy/compat/)：`urmotiv-containerd.service` 安装到 `/etc/systemd/system/`，`docker-managed-containerd.conf` 安装到 `/etc/systemd/system/docker.service.d/urmotiv-managed-containerd.conf`，`urmotiv-containerd.toml` 位于生产目录。恢复这些配置前必须确认还是上述旧存储、且没有别的项目依赖当前 Docker；正常启停不需要重复安装它们。

## 从备份恢复数据，和重启不是一回事

服务意外停止时先用 start，**不要导入旧备份、运行 bootstrap、编号迁移或历史导入脚本**。这些会把当前站点带回旧状态或重复写入数据。

网页正常时，完整备份/恢复入口为「管理 → 系统 → 备份与恢复」，仅 root 直接登录可用，使用独立的备份密码。先在隔离环境做恢复预检，再决定是否替换生产。独立 Fermata/Anklang 配置也要备份。

只有服务器上的 `.dump` 时，它只包含 PostgreSQL，不含附件对象；不能称为完整恢复。完整灾难恢复需要同一时点的数据库、MinIO 附件、Fermata/Anklang 数据与加密密钥，以及对应版本镜像。替换生产前停写、另存当前现场，在隔离数据库恢复并核对文件，再切换；不要用九月迁移快照覆盖之后的投稿。

`docker compose down -v`、`docker volume prune`、手工删除 Docker 数据目录都不是恢复命令。日常脚本不提供删除卷的选项。

## 安装或更新管理脚本

仓库 `deploy/` 内有 `urmotivctl`、`fermata-maintenance.mjs` 和 `urmotiv-production.service`。将前两者复制到实际生产目录，给脚本执行权限；unit 中的部署路径按实际位置核对后安装：

```bash
sudo install -m 755 urmotivctl /root/urmotiv-production-20260919/urmotivctl
sudo install -m 644 fermata-maintenance.mjs /root/urmotiv-production-20260919/fermata-maintenance.mjs
sudo install -m 644 urmotiv-production.service /etc/systemd/system/urmotiv-production.service
sudo systemctl daemon-reload
sudo systemctl enable --now urmotiv-production
```

脚本只支持已初始化且包含八项服务的生产 Compose。首次部署、构建新版本、数据库迁移是另外的操作，见[部署指南](deployment.md)。
