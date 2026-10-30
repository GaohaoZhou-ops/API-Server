# 部署与运维

平台运行在 Linux，支持普通用户运行。Node.js 负责 HTTP，Python 负责原子配置、权限、SQLite 和邮件。无需 root 权限，不依赖某个云厂商目录。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `API_DOCS_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `API_DOCS_PORT` | `8787` | HTTP 端口 |
| `API_DOCS_CONFIG` | `<项目>/var/config` | 私有配置目录；管理员面板要求目录形式 |
| `API_DOCS_STATE` | `<项目>/var/state` | 数据库、截图、队列、锁、私有密钥 |
| `API_DOCS_CONTENT_ROOT` | `<项目>/var/content` | 发布后文档和版本目录索引 |
| `API_DOCS_PYTHON` | `/usr/bin/python3` | 安装了 PyYAML 的 Python 解释器 |

启动、发布、配置命令必须使用一致的配置、状态和内容路径。`setup` 不覆盖已配置密码；保留整个 `var/` 可以在更新平台代码后保留授权与记录。平台不会自动发送邮件，直到管理员在配置中启用 SMTP；测试发信也需要显式运行测试命令。

## 固定域名与后台运行

使用自己的反向代理或已配置的 Cloudflare Tunnel，将固定域名转发到 `http://127.0.0.1:8787`。域名、隧道凭据和 Cloudflare 配置应存放在仓库外。平台不创建临时域名，不管理或上传隧道令牌。

反向代理须保留原始 Host，并正确设置 `X-Forwarded-Proto: https`；后端仅允许受信任代理访问。默认只监听回环地址。Cloudflare 访客 IP 只在本机回环连接时读取 `CF-Connecting-IP`；普通代理部署会记录直接连接地址。

可用 systemd 管理进程。下面示例假设服务代码位于 `/opt/api-server`，已创建 `docs` 用户并让其拥有运行目录，且已完成 `npm run setup`。按安装位置修改解释器路径。

```ini
[Unit]
Description=API documentation portal
After=network.target

[Service]
User=docs
WorkingDirectory=/opt/api-server
Environment=API_DOCS_PYTHON=/opt/api-server/.venv/bin/python
ExecStart=/usr/bin/node /opt/api-server/docs-server.mjs
Restart=on-failure
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

健康检查：`curl --fail http://127.0.0.1:8787/healthz`。进程锁阻止同一状态目录启动两个服务。重启时读取原有密码，内存会话失效后需重新登录。

## 邮件

编辑 `var/config/email.yaml`，设置收发地址、SMTP 主机、端口、TLS 模式、账号、密码和固定 `access_url`。保存后下一次通知生效。`smtp_security` 仅支持 `ssl`（通常 465）或 `starttls`（通常 587），验证 TLS 证书，不允许明文 SMTP。

```bash
"$API_DOCS_PYTHON" scripts/visit_email.py status
# 此命令会实际向配置的管理员邮箱发信：
"$API_DOCS_PYTHON" scripts/visit_email.py test
```

留言邮件包含完整正文和最多 5 张原始截图；单张最多 5 MiB、合计最多 15 MiB。登录与改密邮件含普通阅读码，申请人授权邮件含该申请人的独立密码，收件邮箱应受控。后台失败和状态可在管理面板或私有状态目录中检查。

## 备份与更新

停服后备份 `var/config/`、`var/state/`、`var/content/`，包括独立申请密码的加密密钥及 SQLite 文件。缺失密钥会导致旧密码无法查看。备份永不放入公开仓库。

更新平台前运行测试并备份；保留 `var/`，拉取平台代码后重启服务。文档更新只需发布新修订并刷新页面。删除旧文档会留在私有 `.deleted` 目录中用于运维恢复，不经 HTTP 提供。
