# P0 拆分计划

## 一、拆分 server.js（2217 行 → 目标 < 500 行）

### 现状
`server.js` 同时承担：Express 路由、推理编排、资产管理、训练接口、日志设置、文件上传。

### 拆分方案
新建 `lib/server/` 目录，把 `server.js` 拆成以下模块：

| 新模块 | 职责 | 来源 |
|---|---|---|
| `lib/server/app.js` | Express app 初始化、中间件注册、路由挂载 | server.js 顶部 |
| `lib/server/routes/synthesis.js` | 推理编排路由 | server.js 中的 synthesis 相关路由 |
| `lib/server/routes/assets.js` | 资产管理路由 | server.js 中的 assets 相关路由 |
| `lib/server/routes/training.js` | 训练接口路由 | server.js 中的 training 相关路由 |
| `lib/server/routes/generate.js` | 生成路由 | server.js 中的 generate 相关路由 |
| `lib/server/middleware/` | 中间件（日志、CORS、错误处理等） | server.js 中的 middleware |
| `lib/server/utils.js` | 工具函数 | server.js 中的工具函数 |

### 硬性验收
- `server.js` 只保留：require、app 初始化、路由挂载、listen（目标 < 200 行）
- 全量测试 `node tools/run_tests.cjs`：2382 pass / 0 fail 不变
- 语法检查通过
- 逐文件拆分，每拆一个模块提交一次

### 注意事项
- ⛔ 不要改任何路由路径、请求处理逻辑
- ⛔ 不要用脚本按行号区间批量移动；逐段 patch
- ⛔ 不要引入新依赖
- ⛔ 拆完后 server.js 的 require 顺序要正确（不能有循环依赖）

---

## 二、拆分 lib/engines/profile.js（1334 行 → 目标 < 500 行）

### 现状
`profile.js` 同时承担：profile 解析、参数 schema 派生、校验逻辑。

### 拆分方案
新建 `lib/engines/profile/` 目录，把 `profile.js` 拆成以下模块：

| 新模块 | 职责 | 来源 |
|---|---|---|
| `lib/engines/profile/resolve.js` | profile 解析入口 | profile.js 主要逻辑 |
| `lib/engines/profile/paramSchema.js` | 参数 schema 派生 | profile.js 中的 paramSchema 相关函数 |
| `lib/engines/profile/validate.js` | profile 校验逻辑 | profile.js 中的 validate 相关函数 |
| `lib/engines/profile/legacy.js` | 旧版本兼容逻辑 | profile.js 中的 legacy 相关函数 |

### 硬性验收
- `profile.js` 只保留：require、导出（目标 < 100 行）
- 全量测试 `node tools/run_tests.cjs`：2382 pass / 0 fail 不变
- 语法检查通过
- 逐文件拆分，每拆一个模块提交一次

### 注意事项
- ⛔ 不要改任何函数签名、返回值
- ⛔ 不要用脚本按行号区间批量移动；逐段 patch
- ⛔ 不要引入新依赖
- ⛔ 拆完后 profile.js 的 require 顺序要正确（不能有循环依赖）
- ⛔ 外部引用 profile.js 的地方不用改（profile.js 保持原导出接口）

---

## 三、通用纪律

- ⛔ 不要 push、不要建分支
- ⛔ 每拆一个模块做一次原子化提交
- ⛔ 提交前用 git diff --cached --name-only 核对
- ⛔ 全量测试必须通过
- ⛔ 代码骨架必须一致（剥掉注释和空行后，代码逻辑不变）
- ⛔ 不改任何字符串字面量（包括用户可见文案）
