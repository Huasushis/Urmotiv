# Hydro 格式依据与许可证说明

本目录的 TypeScript 代码由 Urmotiv 独立编写，用来读写 Hydro 可接受的题目包布局；没有包含 Hydro 源代码或任何 Hydro 题目、测试数据、附件。

格式依据：Hydro 官方仓库 <https://github.com/hydro-dev/Hydro>，提交 `591dbd31c00ac54aa0381a85eed375c25f6bd829`（2026-07-25）。核对文件：

- `packages/hydrooj/src/model/problem.ts`
- `packages/ui-default/components/zipDownloader/index.ts`
- `packages/common/types.ts`

该固定提交的根 [`LICENSE`](https://github.com/hydro-dev/Hydro/blob/591dbd31c00ac54aa0381a85eed375c25f6bd829/LICENSE) 和 [`package.json`](https://github.com/hydro-dev/Hydro/blob/591dbd31c00ac54aa0381a85eed375c25f6bd829/package.json) 均声明 `AGPL-3.0-only`。该许可证适用于 Hydro 本身；本目录并不重新发布 Hydro。若后续有人复制、修改或分发 Hydro 代码，必须另行遵守其许可证与来源说明。

本目录的自动化测试只使用人工构造的合成夹具，不含 Hydro 或协会题目，也不构成与真实 Hydro 部署互操作的证据。格式支持、测试证据和内容授权的完整边界见 [OJ 题目包兼容性文档](../../docs/oj-compatibility.md)。
