# Bridson 泊松圆盘采样后端（仅 API + CLI）

在矩形内做二维 **Bridson 泊松圆盘采样**，生成彼此保持至少距离 `r` 的空间分散点集，并提供邻域拒绝原因解释、独立距离核验与 JSON/CSV 导出。

- 语言/运行时：TypeScript + Node.js（要求 Node ≥ 22.5，开发环境为 Node 25）
- 数据库：**Node 内置 `node:sqlite`**，无任何原生编译依赖，无需 better-sqlite3
- 仅后端：HTTP JSON API 与命令行，不含渲染、地图投影、道路规划或三角剖分
- 纯本地运行：不使用 Docker / WSL / 付费服务 / 外部在线 API / 外部随机服务，数据全部保存在项目内 `data/`

## 快速开始（Windows PowerShell）

```powershell
npm install
npm run build       # 编译到 dist/
npm test            # 构建并运行全部测试
npm run demo        # 固定种子演示：正常点集 / 极小预算部分生成 / 注入过近点对
npm start           # 启动 HTTP API，默认自动选择空闲端口
```

也可以直接用 CLI：

```powershell
node dist/src/cli.js help
node dist/src/cli.js generate --width=100 --height=80 --r=10 --k=30 --seed=demo-2026
node dist/src/cli.js list
node dist/src/cli.js get 1
node dist/src/cli.js points 1 --format=csv
node dist/src/cli.js rejects 1
node dist/src/cli.js near 1 --x=50 --y=40 --radius=15
node dist/src/cli.js verify 1
node dist/src/cli.js export 1 --kind=points --out=points.csv
node dist/src/cli.js serve --port=8080   # 指定端口；--port=0 或不传则自动选空闲端口
```

`verify` / `verify-file` 发现问题时退出码为 `2`；参数/用法错误为 `1`。

数据目录可用环境变量覆盖：`$env:BRIDSON_DATA_DIR="E:\some\dir"`。

## 算法说明

### 采样过程（严格的 Bridson 活动列表 + 网格邻域拒绝）

1. 辅助网格边长 `cell = r / sqrt(2)`，保证每个网格单元至多容纳 1 个已接受点。
2. 初始点由同一个 PRNG 在 `[0,width) × [0,height)` 内均匀取两个分量生成；**初始点必然合法**。
3. 活动列表为 FIFO 队列，选择规则 `fifo_front`：总是取队首活动点作为锚点。
4. 每次在锚点的圆环 `[r, 2r)` 内生成一个候选：
   - 角度 `theta = 2π·u1`（均匀）
   - 半径 `rho = r·sqrt(1 + 3·u2)`（对**圆环面积**均匀，不是对半径均匀）
5. 候选先做矩形边界检查，再检查以候选所在格为中心的 **5×5（±2 格）全部邻居**；任一点距离平方 `< r²` 即拒绝。不是只查同格或四个正交邻居。
6. 合格候选加入点集与活动列表**队尾**；锚点连续 `k` 次候选都失败时才从队首移除。
7. 活动列表耗尽即结束。

明确**不是**“全矩形盲目均匀撒点 + 全点对过滤”的冒充实现。

### 浮点容差策略

- 接受判定就是朴素比较 `dist2 >= r*r`，接受距离**等于** `r` 的点（如 `(0,0)` 与 `(6,8)`、`r=10`，平方距离恰好 100）。
- 不使用任何人为放大的 epsilon 来“放宽”距离，避免掩盖真实过近点。
- 误差仅来自 IEEE-754 double 的正常舍入（平方、三角函数、开方）；验证接口输出实际最小点对距离与 `r` 供人工判断。

### 随机性与可复现性

- PRNG 版本固定记录为 `mulberry32-v1`：字符串种子先经 FNV-1a 32 位散列，再由 mulberry32 产生 `[0,1)` 序列。
- 初始点与所有候选共用同一个 PRNG 实例，调用顺序固定（初始点 2 次，之后每候选 2 次）。
- 同 `prngVersion` + 同参数（`width/height/r/k/seed`）+ 同活动点选择规则，产生**完全相同的点序列**（测试已校验同进程重复与重启后读取一致）。
- 升级算法必须提升版本号。

## 预算与部分生成

可通过请求体 `limits` 或 CLI 参数配置（默认值见 `src/validate.ts`）：

| 预算 | 默认 | 含义 |
|---|---|---|
| `maxGridCells` | 2,000,000 | 辅助网格总格数；**创建前**检查，超限直接报 `GRID_LIMIT_EXCEEDED`（例如 `r` 相对矩形过小） |
| `maxPoints` | 50,000 | 已接受点数达到即停止，状态标记 `partial`，原因 `point_budget` |
| `maxAttempts` | 2,000,000 | 候选尝试总数达到即停止，`partial` / `attempt_budget` |
| `maxExplanations` | 2,000 | 持久化的拒绝明细条数上限；**截短只影响解释记录，绝不影响采样**，并在结果中标记 `explanationTruncated` |

- 达到任何预算都只会得到 `status="partial"`，**不能说矩形已被填满**。
- 即使活动列表耗尽（`completed` / `active_list_exhausted`），也只表示“该算法本次结束”，**不宣称最大点数、无空隙或最优覆盖**。
- 采样过程中抛错不会写库；失败不会覆盖已有成功点集。

## HTTP API

仅监听 `127.0.0.1`。

| 方法/路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `POST /api/runs` | 生成点集（请求体含 `width,height,r,k,seed`，可选 `limits`） |
| `GET /api/runs` | 点集列表 |
| `GET /api/runs/:id` | 读取参数、状态、点表、拒绝汇总（`?format=csv` 导出点） |
| `GET /api/runs/:id/points?format=csv` | 仅点表（JSON/CSV） |
| `GET /api/runs/:id/rejects?format=csv` | 拒绝明细与分类（`out_of_bounds` / `too_close`） |
| `GET /api/runs/:id/near?x=&y=&radius=` | 查询某点半径内邻居与最近点距离 |
| `GET /api/runs/:id/export?kind=points\|rejects` | CSV 导出 |
| `POST /api/verify` | 独立验证任意点集，或传 `runId` 从库中取点验证 |

生成示例：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/api/runs -ContentType 'application/json' `
  -Body '{"width":100,"height":80,"r":10,"k":30,"seed":"demo-2026"}'
```

验证请求：

```json
{ "width": 100, "height": 80, "r": 10,
  "points": [ {"x":1,"y":1}, {"x":2,"y":1} ] }
```

### 错误码

| code | HTTP | 场景 |
|---|---|---|
| `VALIDATION_ERROR` | 400/413/422 | 参数非法、JSON 非法、请求体过大 |
| `GRID_LIMIT_EXCEEDED` | 422 | 辅助网格规模超过 `maxGridCells` |
| `NOT_FOUND` | 404 | 点集/路由不存在 |
| `INTERNAL_ERROR` | 500 | 未预期内部错误 |

## 独立核验

`POST /api/verify` 与 `cli verify` 不信任任何“由本服务生成”的标记，始终独立执行：

1. 边界：左闭右开 `[0,width) × [0,height)`，右上边界点判越界；
2. 重复点：坐标完全相同；
3. 最小距离：**全点对 O(n²)** 检查，`dist < r` 判违规、`dist == r` 接受；
4. 返回实际最小点对距离、问题清单（最多 100 条）与问题总数，并持久化核验结果。

测试用小结果的独立全点对距离与采样器的网格邻域判定交叉核对；并包含“跨网格边界但距离 < r”的注入用例，防止只查同格/正交邻居的漏判。

## 项目结构

```
src/
  prng.ts       PRNG（mulberry32-v1）与字符串种子散列
  types.ts      类型定义
  errors.ts     错误码
  validate.ts   参数/预算校验
  sampler.ts    Bridson 采样器（活动列表、辅助网格、5×5 邻域拒绝）+ 全点对核对
  verify.ts     独立验证与最近邻查询
  db.ts         SQLite 持久化（runs/points/rejects/verifications）
  exporters.ts  JSON/CSV
  server.ts     HTTP API 与空闲端口选择
  cli.ts        命令行
  demo.ts       固定脚本演示
tests/          node:test 测试（算法、边界、预算、持久化、HTTP 端到端）
data/           运行后生成，bridson.sqlite（WAL 模式）
```

## 覆盖能力边界

- 泊松圆盘采样给出的是**随机分散**点集，满足所有已接受点两两距离 ≥ `r`。
- 它**不保证**点数量最大、不保证覆盖每个区域、不产生数学上无空隙的最优排列。
- 结果只对本次参数、种子与 PRNG 版本负责；预算截断时结果明确标记为 `partial`。
