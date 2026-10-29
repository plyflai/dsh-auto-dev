# 内外网隔离原则

> 一句话：内网优化功能不能让内网地址暴露给外网用户

## 适用范围

| 维度 | 范围 |
|------|------|
| 语言 | 通用 |
| 平台 | 通用（尤其是云服务场景） |

## 问题

为了提升性能或节省成本，服务器内部使用内网地址访问存储/数据库/其他服务。但如果不小心把内网地址暴露给了外网用户，用户将无法访问。

**典型场景**：
- 云存储（OSS/S3）开启内网访问后，签名 URL 包含内网地址
- 数据库连接串使用内网地址，但配置文件被前端读取
- 微服务之间使用内网域名，但错误地返回给客户端

## 方案（概念层）

```
┌─────────────────────────────────────────────────────────────┐
│                        服务器内部                            │
│                                                             │
│   [业务逻辑] ──内网地址──> [存储/服务]                        │
│       │                                                     │
│       │ 生成外部访问链接时                                    │
│       ▼                                                     │
│   [地址转换层]                                               │
│       │                                                     │
│       │ 替换为公网地址/自定义域名                             │
│       ▼                                                     │
│   [返回给用户]                                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**关键**：在"返回给用户"之前，必须有一个**地址转换层**，确保：
1. 内网地址被替换为公网地址
2. 覆盖所有可能的内网地址格式

## 关键决策点

- **转换时机**：在最后返回给用户之前转换，而不是在生成时就用公网地址
  - 原因：服务器内部仍需使用内网地址以保持性能优势
  
- **转换覆盖度**：必须覆盖所有可能的地址格式
  - 公网格式：`xxx.oss-cn-hangzhou.aliyuncs.com`
  - 内网格式：`xxx.oss-cn-hangzhou-internal.aliyuncs.com`
  - VPC 格式：`xxx.oss-cn-hangzhou.internal.aliyuncs.com`（某些云服务）

## 边界条件

- **不适用**：纯内部系统（无外网用户访问）
- **特殊处理**：如果用户也在同一内网（如企业内部应用），可能需要根据用户网络环境返回不同地址

## 检查清单

**新增内网优化功能时**：
- [ ] 列出所有会生成 URL/地址的地方
- [ ] 检查每个地方是否有地址转换逻辑
- [ ] 转换逻辑是否覆盖所有内网地址格式（公网、内网、VPC）
- [ ] 是否有端到端测试：从用户视角访问生成的 URL

**代码审查时**：
- [ ] 搜索代码中的 `internal`、`vpc`、`private` 等关键词
- [ ] 检查这些地址是否会被返回给用户

## 示例

### 错误示例

```javascript
// 开启内网访问
const ossClient = new OSS({ internal: true });

// 生成签名 URL（包含内网地址）
let url = ossClient.signatureUrl(objectKey);

// ❌ 错误：只替换了公网格式
const publicDomain = `${bucket}.${region}.aliyuncs.com`;
url = url.replace(publicDomain, customDomain);
// 内网格式 xxx-internal.aliyuncs.com 未被替换！
```

### 正确示例

```javascript
// ✅ 正确：同时替换公网和内网格式
const publicDomain = `${bucket}.${region}.aliyuncs.com`;
const internalDomain = `${bucket}.${region}-internal.aliyuncs.com`;
url = url.replace(publicDomain, customDomain);
url = url.replace(internalDomain, customDomain);
```

---
*标签*: `内网优化`, `地址转换`, `云存储`, `OSS`, `S3`, `签名URL`, `安全`
