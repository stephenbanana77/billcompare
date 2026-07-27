# 商场结算对账工作台

面向财务团队的全栈对账应用，覆盖商场结算单与 ERP/POS 文件导入、字段映射、规则计算、分项比对、异常处置和操作留痕。

## 当前能力

- Excel/CSV 商场账单与 ERP 文件本地解析
- 不同列名自动识别与手工字段映射
- 扣点、固定活动费、账期和差异容忍值规则
- 销售额、退款、扣点、活动费、实结金额五项比对
- 异常分级、处理人、处理记录和任务状态闭环
- 规则库与历史任务规则快照隔离
- 开发库真实持久化，应用初始不预置业务数据

## 目录说明

- `client/`：React 工作台和文件导入解析
- `server/`：NestJS API、计算逻辑和数据库访问
- `shared/`：前后端共享业务类型
- `migrations/`：开发库建表脚本
- `../mall-reconciliation-sample-data/`：外置模拟数据，不参与应用构建

## 本地启动

首次安装依赖：

```powershell
npm install
```

Windows 推荐入口：

```powershell
npm run dev:windows
```

打开：`http://127.0.0.1:5173/app/app_17a7d7fdmvg/`

macOS/Linux 可使用官方入口：

```bash
npm run dev
```

## 验证命令

```powershell
npm run eslint
npm run stylelint
npm run type:check:client
npm run type:check:server
```

生产构建在 Windows 上可分别执行：

```powershell
$env:NODE_ENV = "production"
npx nest build
npx vite build --config vite.config.ts
```

## 数据边界

应用不会自动加载模拟数据。外置样例必须由用户在导入向导中主动选择；测试任务可在任务详情页删除，相关比对、异常和日志会同步清理。
