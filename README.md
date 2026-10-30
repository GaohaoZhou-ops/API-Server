# API Server

一个可以自行部署的文档平台。使用方在独立目录中按 `api-docs/v1` 协议编写 Markdown 和 OpenAPI JSON，即可校验、发布和切换文档版本。

平台代码和虚构示例可公开。业务源码、内部文档、真实接口定义、凭据和运行数据应保存在使用方自己的私有目录或私有仓库中。本工程不读取业务源码、不生成源码快照，也不提供业务压缩包发布入口。

## 快速启动

运行环境：Linux、Node.js 20 或更新版本、Python 3.10 或更新版本。

```bash
git clone git@github.com:GaohaoZhou-ops/API-Server.git
cd API-Server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
export API_DOCS_PYTHON="$PWD/.venv/bin/python"
npm run setup
npm run credentials
npm start
```

打开 `http://127.0.0.1:8787`。`setup` 生成独立的阅读密码与管理员密码，并发布虚构示例；重复执行不重置已有密码。`credentials` 只在本机终端显示密码，请勿将输出提交到 Git。管理员密码用于管理面板，阅读密码没有管理权限。

不需要 npm 依赖安装。浏览器库随仓库提供并附带上游许可；Python 依赖单独安装。

## 发布自己的文档

先把示例复制到**仓库以外的独立文档目录**，再编写公开指南与公开接口。不要把业务工程根目录交给发布器。

```bash
cp -R examples/hello-docs ../my-public-docs
# 编辑 ../my-public-docs/docs.json、guides/*.md 与 openapi.json
npm run docs:check -- ../my-public-docs
npm run docs:publish -- ../my-public-docs
```

发布后刷新页面即可看到新版本，无需重启服务。新的内容必须使用新的 `revision`；对同一版本重复发布相同内容可安全重试，并将其设为默认版本。已有版本的不同内容会被拒绝。

[文档包协议](docs/protocol.md) 包含字段约定、限制和 Markdown-only 示例；[JSON Schema](schemas/docs-v1.schema.json) 可用于编辑器提示。所有 HTTP API 操作都必须显式设置 `x-audience: "public"`，只写使用方可以知道的公开契约。

## 平台功能

- Markdown 指南、OpenAPI 参考、数据模型、调用示例、搜索、版本切换和 API 差异对比。
- 明暗主题、移动端目录、表格和基本 Mermaid 流程图。
- 阅读与管理权限分离；公司、部门和版本授权；申请人独立密码。
- 管理员审批访问申请、生成/查看密码，并发送授权邮件。
- 留言反馈和最多 5 张截图；向管理员发送正文及原图附件。
- HTML 与纯文本邮件、访问记录、邮件队列和管理审计。

SMTP 默认关闭。填写 `var/config/email.yaml` 后启用，支持验证证书的 SMTPS 或 STARTTLS。邮箱示例见 [配置模板](config/email.yaml.example)。未配置邮件时可以阅读、管理文档和保存反馈；“授权并发送密码”需要完整邮件配置。

## 运行数据与发布边界

| 位置 | 内容 | 是否进入公开仓库 |
| --- | --- | --- |
| 平台代码、`web/`、`scripts/` | 文档服务实现 | 是 |
| `examples/hello-docs/` | 虚构演示文档 | 是 |
| `var/config/` | 访问密码、部门权限、SMTP 凭据 | 否 |
| `var/state/` | 申请、留言、截图、邮件与访问记录 | 否 |
| `var/content/` | 通过校验后生成的文档版本 | 否 |
| 仓库外的业务源码和内部资料 | 使用方私有资产 | 否 |

`.gitignore` 隔离本机数据，`.public-files.json` 明确列出可提交的平台文件。公开仓库审计会拒绝清单外文件、链接、压缩包、私有运行路径及常见凭据格式；CI 和可选的本地 pre-push hook 执行同样的检查。

```bash
git config core.hooksPath .githooks
npm run audit:public
npm test
```

新增平台文件时应审阅内容后，显式更新 `.public-files.json`。Git 忽略规则及关键词扫描不能判断一段文字是否属于商业秘密；发布前仍须审阅所写文档。服务端不会自动读取、推断或复制业务实现。详细边界见 [安全说明](SECURITY.md)。

部署、环境变量、备份和固定域名入口配置见 [运维说明](docs/deployment.md)。
