## 阅读文档

在左侧选择指南或 API 参考，在右上角切换版本和深浅主题。

文档包使用 `docs.json` 声明公开内容。指南由 Markdown 编写，API 定义使用 OpenAPI JSON。这里的示例均为虚构数据。

## 调用公开接口

从服务提供方获取 API 地址与独立的 API 凭据。文档平台的访问密码仅用于登录文档平台。

```bash
curl --request GET 'https://api.example.com/v1/status' \
  --header 'Authorization: Bearer YOUR_API_TOKEN'
```

| 字段 | 含义 |
| --- | --- |
| status | 服务运行状态 |
| version | 服务的公开版本号 |

## 接入步骤

```mermaid
flowchart LR
  A[获取 API 凭据] --> B[阅读接口定义]
  B --> C[替换示例地址]
  C --> D[调用公开接口]
```

更多说明见 [接口鉴权](authentication.md)。
