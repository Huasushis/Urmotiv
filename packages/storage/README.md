# @urmotiv/storage

这个包提供统一的文件存储接口。本地开发把文件写入 `.data/storage`，生产环境使用兼容 S3 的对象存储。
对象存储是专门保存大文件的服务，数据库只记录文件编号、大小、校验值和内部位置。

## 文件生命周期

1. `stage` 把文件写入临时区。临时区是尚未被题目或任务正式引用的位置。
2. 写入过程中逐块计算文件大小和 SHA-256。SHA-256 是用于确认文件内容没有变化的固定长度校验值。
3. 调用方完成内容类型、安全和业务检查后调用 `publish`，文件才进入正式区。
4. 任一步失败都调用 `discard`；实现本身也会清理写入失败留下的临时文件。

内部文件位置只使用系统生成的 UUID，也就是随机且格式固定的编号。`originalName` 只用于页面显示，不能包含 `/`、
`\\`、控制字符或 `..`，也从不参与磁盘路径或 S3 对象位置计算。同名文件因此不会互相覆盖。

```ts
import { createReadStream } from "node:fs";
import { LocalFileStorage } from "@urmotiv/storage";

const storage = new LocalFileStorage({
  rootDirectory: ".data/storage",
  limits: {
    maxBytes: 128 * 1024 * 1024,
    allowedMediaTypes: ["application/zip"]
  }
});

const staged = await storage.stage({
  originalName: "problem.zip",
  mediaType: "application/zip",
  content: createReadStream("/private/input/problem.zip")
});

const stored = await storage.publish(staged);
```

`stage` 按数据流写入，不把整个文件放进内存。这里的类型限制检查调用方声明的媒体类型；ZIP 条目、图片真实格式、
扩展名和文件头的组合检查仍由上传入口或 `@urmotiv/problem-package` 完成。
`StagedFile` 是服务端内部记录，不能返回给浏览器后再原样接收并发布；上传入口应把临时记录保存在受控数据库中，并在发布前
重新检查当前用户、文件用途和所属题目。

## S3

生产环境使用 AWS 官方 JavaScript 客户端创建 `S3Client`，再传给 `S3FileStorage`：

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { S3FileStorage } from "@urmotiv/storage";

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "",
    secretAccessKey: process.env.S3_SECRET_KEY ?? ""
  }
});

const storage = new S3FileStorage({
  client,
  bucket: process.env.S3_BUCKET ?? "",
  limits: { maxBytes: 128 * 1024 * 1024 }
});
```

真实代码应在创建客户端前检查必填环境字段。包没有“公开网址”方法。API 必须先检查当前用户对题目和文件类别的权限，
再转发内容或生成由 API 控制的短期下载方式；不能把 `storageKey` 返回给浏览器当作权限控制。

## 错误与清理

`StorageError.code` 是稳定错误编号，错误信息不包含原文件内容、内部路径、密钥或 S3 返回的原始响应。底层错误只保存在
`cause` 中，调用方不得把它直接写入用户响应或普通日志。S3 发布使用“复制到正式区后删除临时对象”的顺序；任一步失败会
尽力删除两边对象，并且数据库只有在 `publish` 成功后才能保存正式记录。
