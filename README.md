# Bridson 泊松圆盘采样后端（API + CLI）

在矩形内生成二维泊松圆盘采样点集：任意两点欧氏距离至少为 `r`。纯本地运行，
技术栈为 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生编译依赖），
不依赖 Docker、WSL 或任何外部在线服务。

## 环境要求

- Windows 本地，Node.js >= 22.5（内置 `node:sqlite`；开发环境为 Node 25）
- 安装依赖：`npm install`

## 常用命令

```bash
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试（17 个）
npm start         # 启动 API 服务（默认自动选择空闲端口，--port N 指定端口）
npm run demo      # 演示：正常生成 / 极小预算部分生成 / 注入过近点对校验
node dist/cli.js  # CLI 帮助
```

CLI 示例：

```bash
node dist/cli.js generate --width 100 --height 80 --r 5 --k 30 --seed 42
node dist/cli.js list
node dist/cli.js points --run 1 --limit 20      # 点表
node dist/cli.js nearest --run 1                # 最近点距
node dist/cli.js nearby --run 1 --x 50 --y 40   # 某点附近距离
node dist/cli.js explain --run 1                # 接受/拒绝分类摘要与明细
node dist/cli.js validate --file candidate.json # 独立校验任意候选点集
node dist/cli.js export --run 1 --format csv    # 导出 json 或 csv
```

## HTTP API

默认监听 `127.0.0.1`，端口默认由系统分配空闲端口（`--port` 可指定）。

- `POST /api/samples` 生成点集。请求体：
  `{ "width": 100, "height": 80, "r": 5, "k": 30, "seed": 42,
     "maxPoints": ..., "maxAttempts": ..., "maxGridCells": ..., "maxExplain": ... }`
- `GET /api/runs` 历史运行列表
- `GET /api/runs/:id/points` 读取点集
- `GET /api/runs/:id/nearby?x=..&y=..&limit=..` 查询某点附近点及距离
- `GET /api/runs/:id/explain` 接受/拒绝原因摘要与明细
- `GET /api/runs/:id/export?format=json|csv` 导出
- `POST /api/validate` 独立校验任意候选点集：
  `{ "width": 100, "height": 80, "r": 5, "points": [{"x":1,"y":2}, ...] }`

错误响应统一为 `{ "error": { "code": "...", "message": "..." } }`，错误码包括
`INVALID_WIDTH / INVALID_HEIGHT / INVALID_R / INVALID_K / INVALID_SEED / INVALID_BUDGET /
GRID_BUDGET_EXCEEDED / INVALID_JSON / INVALID_QUERY / INVALID_FORMAT / RUN_NOT_FOUND / NOT_FOUND`。

## 算法与可复现性

- **Bridson 活动列表法**：从矩形内一个合法初始点开始，维护活动点列表；每次按固定规则
  `lifo-v1`（取列表末尾）选活动点，在其周围 `[r, 2r)` 圆环内生成候选；候选在矩形内且与
  附近已接受点距离合格才加入点集与活动列表；某活动点连续 `k` 次尝试失败才移出活动列表。
- **辅助网格**：边长 `r/√2`，每格最多一个点；邻域拒绝检查覆盖 5×5 邻域（距离 `r` 的
  全部相关网格），不只看同格或四个正交邻居。
- **候选分布**：角度 `2πu₁` 均匀；半径 `r·√(1+3u₂)`，即按圆环面积均匀。
- **随机性**：唯一随机源是公开版本的确定性 PRNG `mulberry32@1`（初始点与候选共用）。
  同版本、同种子、同参数得到完全相同的点序列；参数、种子、RNG 版本、活动点选择规则
  均随每次运行存入 SQLite。
- **坐标范围**：左闭右开矩形 `[0,width) × [0,height)`，普通欧氏距离，无周期边界。

## 浮点容差策略

距离平方与 `r²` 比较时使用相对容差 `eps = 1e-9 · r²`：`distSq < r² - eps` 判为过近拒绝，
否则（含恰好等于边界）接受。容差只吸收浮点舍入（相对量级 1e-9），不会掩盖真实过近点。

## 预算与覆盖能力的边界

- 可配置预算：`maxPoints`（点数）、`maxAttempts`（总尝试次数）、`maxGridCells`（网格规模）、
  `maxExplain`（解释明细条数）。达到预算时运行标记为 `partial`（部分生成），不宣称填满矩形。
- 即使活动列表耗尽（`complete`），也只表示算法本次正常结束，不宣称获得最大点数或
  数学上无空隙的最优排列。
- 解释明细截短只影响解释输出，不影响采样本身；生成失败（参数非法、网格预算超限）
  不会写入或覆盖已有成功点集。
- 独立校验接口（`POST /api/validate` 与 `validatePointSet`）使用全点对 O(n²) 距离检查，
  独立检查边界、重复点与最小距离，不信任任何"本服务生成"标记。

## 数据存储

所有数据保存在项目目录 `data/poisson.db`（可用环境变量 `POISSON_DATA_DIR` 覆盖），
包含运行参数、点序列、状态与原因、接受/拒绝摘要、解释明细和校验记录。

## 项目结构

- `src/rng.ts` 确定性 PRNG（mulberry32@1）
- `src/sampler.ts` Bridson 采样核心（活动列表 + 网格邻域拒绝 + 预算）
- `src/validate.ts` 独立全点对校验
- `src/db.ts` SQLite 持久化
- `src/server.ts` HTTP API
- `src/cli.ts` 命令行
- `src/demo.ts` 演示脚本
- `test/` 测试（确定性、窄矩形、r 大于边长、边界距离、非法尺寸、重复点、
  右上边界排除、预算部分生成、环形半径范围、解释截短、SQLite 往返、API 端到端）

## 已知限制

- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning），接口未来可能调整。
- 独立校验为 O(n²)，适合核验中小规模点集；超大规模点集校验会较慢。
- 仅做采样与距离核验：不做地图投影、道路规划、三角剖分、最优覆盖证明，也不渲染图片。
