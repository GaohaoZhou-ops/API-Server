# 文档包协议 api-docs/v1

发布输入是一个独立目录，文件清单由 `docs.json` 唯一决定。根目录只允许 `docs.json`、可选的 `openapi.json` 和 `guides/` 下显式声明的 Markdown 文件。隐藏文件、`.git`、业务源码、压缩包、构建产物和未声明文档都会使整包校验失败。

```text
my-public-docs/
  docs.json
  openapi.json
  guides/
    quickstart.md
```

最小的纯 Markdown 文档包：

```json
{
  "protocol": "api-docs/v1",
  "visibility": "public",
  "revision": "1.0.0",
  "productVersion": "1.0.0",
  "publishedAt": "2026-10-30T00:00:00Z",
  "site": {
    "name": "My Docs",
    "title": "公开使用指南",
    "description": "介绍公开功能和使用方式。"
  },
  "guides": [
    {"id": "quickstart", "title": "快速开始", "group": "开始使用", "file": "guides/quickstart.md"}
  ]
}
```

`visibility: public` 表示内容经过公开审阅，不代表关闭站点的登录或部门权限。发布者明确将整个包中的文字、示例、组件和接口契约视为可公开内容。

## 字段

| 字段 | 约定 |
| --- | --- |
| `protocol` | 固定为 `api-docs/v1` |
| `visibility` | 固定为 `public` |
| `revision` | 1–64 位，字母/数字开头，之后允许字母、数字、点、横线；不能包含 `..`；发布后不可变 |
| `productVersion` | 产品公开版本文字，1–64 字符，与文档修订可独立 |
| `publishedAt` | 带时区的 ISO 8601 时间，例如 `2026-10-30T08:00:00+08:00` |
| `site` | `name`、`title`（各 1–120 字符）和 `description`（1–2000 字符） |
| `guides` | 最多 100 篇；按数组顺序显示，按 `group` 分组 |
| `guides[].id` | 小写字母开头，之后允许小写字母、数字、横线，最多 64 位；不可重复 |
| `guides[].file` | `guides/name.md`，文件名只允许字母、数字、横线、下划线，且字母/数字开头；不可重复 |
| `guides[].title/group` | 必填，分别最多 120/80 字符 |
| `guides[].description` | 可选，最多 1000 字符 |
| `openapi` | 可选，唯一允许值为 `openapi.json` |
| `changes` | 可选，必含 `title`；可含 `added/changed/compatibility/validation` 字符串数组，每组最多 50 项 |

保留页面 ID：`overview`、`reference`、`catalog`、`models`、`changelog`、`feedback`、`admin`、`compare`。

至少提供一篇指南或一个 OpenAPI 文件。未知字段直接拒绝，不能用扩展字段携带内部路径、源码索引或构建信息。

## Markdown

支持标题、列表、表格、代码块、HTTP(S) 外链及已声明指南间的相对链接，例如 `[快速开始](quickstart.md)`。`#guide-id` 可跳转指南，`#标题` 可定位当前文档标题。代码块提供语法高亮与复制。

原始 HTML 转义显示，JavaScript 链接不执行；不抓取或显示外部图片，不加载用户脚本、样式、插件或远程内容。`mermaid` 代码块仅支持基本 `flowchart/graph` 节点和箭头；不支持的图表语法保留为代码。留言截图是独立的私有反馈功能，不属于文档发布输入。

## OpenAPI 子集

接受 OpenAPI 3.0.x / 3.1.x JSON。接口操作必须有唯一 `operationId`、`responses` 和 `x-audience: "public"`：

```json
{
  "get": {
    "x-audience": "public",
    "operationId": "getStatus",
    "summary": "读取公开状态",
    "responses": {"200": {"description": "成功"}}
  }
}
```

支持 `info`、`servers`、`tags`、`paths`、`security`，以及 `components` 下的 `schemas`、`parameters`、`headers`、`requestBodies`、`responses`、`examples`、`securitySchemes`。支持常用对象/数组字段、组合模型、JSON 示例、Bearer/API Key/OAuth 安全方案等；完整字段白名单由 `document-protocol.mjs` 定义。

仅支持完整本地组件引用，例如 `#/components/schemas/Status`。外部 URL/文件 `$ref`、`externalValue`、源码扩展、未知 `x-*` 字段、callbacks、webhooks、links 和 XML 扩展不支持。将所需的公开模型直接写入该 OpenAPI 文件。OpenAPI 文档中的所有组件和示例也会公开，请删除未准备公开的定义。

校验器限制可发布内容，并非完整的 OpenAPI 规范认证器。业务契约的正确性仍应由使用方在自己的环境中验证。

## 大小、完整性与发布

- 包内文件总计最多 8 MiB；单篇 Markdown 最多 512 KiB；OpenAPI 最多 4 MiB；清单最多 64 KiB。
- 文本必须是 UTF-8；拒绝二进制内容、符号链接、硬链接和超过 40 层的 JSON。
- 检查常见私钥、访问令牌及明显的硬编码凭据。示例统一使用 `YOUR_API_TOKEN` 等占位符。
- 编译结果只有经过校验的清单、Markdown 和 OpenAPI；不会复制输入目录或添加业务源码。
- 发布器与管理员删除操作共用锁，以原子更新的版本目录索引控制可见性。文件写完后才切换默认版本。
- 服务端每次读取文档时验证结构和 SHA-256。校验值用于发现损坏和不一致，不是抵御拥有服务器写权限者的签名。
- 同一 `revision` 的不同内容被拒绝；同一内容可重复发布。管理员面板可删除旧版本，至少保留一版。

发布只写本机私有 `var/content/`，不会自动提交或推送使用方文档到公开 GitHub 仓库。
