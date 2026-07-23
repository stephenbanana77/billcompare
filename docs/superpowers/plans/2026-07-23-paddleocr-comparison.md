# PaddleOCR 与视觉 LLM 对比实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有结算单 Demo 中加入本地 PaddleOCR，使用同一 PDF 并行生成纯视觉 LLM 与 OCR+LLM 结果，并以字段、明细、坐标证据和勾稽结果判断哪条链路更可靠。

**Architecture:** PaddleOCR 运行在独立 Python 环境中，通过常驻 JSONL 子进程向 NestJS 返回逐字文本、置信度和多边形坐标。后端把 OCR 证据与现有视觉结果标准化后交给比较与规则引擎，不允许 OCR 或第二次模型结果静默覆盖首轮值。React 页面展示方法对比、冲突和可点击原图证据。

**Tech Stack:** PaddleOCR PP-OCRv6、Python 3.12、NestJS、React、TypeScript、Jest、Playwright

---

## 文件结构

- `tools/paddleocr/worker.py`：常驻 OCR JSONL 工作进程，只负责图像识别和标准化坐标输出。
- `tools/paddleocr/check_env.py`：检测 Paddle、PaddleOCR 和 GPU 状态。
- `scripts/setup-paddleocr-windows.ps1`：创建项目独立环境并安装 GPU/CPU 依赖。
- `server/modules/reconciliation/ocr/ocr.types.ts`：OCR 页面、文本框和运行状态类型。
- `server/modules/reconciliation/ocr/paddle-ocr.service.ts`：管理 Python 子进程、超时、重启和错误转换。
- `server/modules/reconciliation/recognition-comparison.ts`：纯函数，比较视觉与 OCR 证据并产生通过/冲突/缺失。
- `shared/reconciliation.ts`：共享 OCR、比较和证据坐标类型。
- `client/src/components/reconciliation/EvidenceViewer.tsx`：PDF 页面和坐标框选查看器。
- `client/src/components/reconciliation/MethodComparison.tsx`：两种方法的字段级对比。
- `client/src/pages/BillRecognitionPage.tsx`：编排上传、OCR、视觉识别、异常门禁和证据查看。
- `test/unit/recognition-comparison.spec.ts`：比较与门禁规则测试。
- `server/modules/reconciliation/ocr/paddle-ocr.service.spec.ts`：进程协议、超时和异常测试。

### Task 1: 固化 OCR 输出协议

**Files:**
- Modify: `shared/reconciliation.ts`
- Create: `server/modules/reconciliation/ocr/ocr.types.ts`
- Test: `test/unit/recognition-comparison.spec.ts`

- [ ] **Step 1: 写失败测试，要求每个 OCR 文本框包含页码、文字、分数和四点坐标**

```ts
expect(normalizeOcrBox({ page: 1, text: '5,650.47', score: 0.98, polygon: [[1,2],[3,2],[3,4],[1,4]] }))
  .toEqual(expect.objectContaining({ page: 1, text: '5,650.47', polygon: expect.any(Array) }));
```

- [ ] **Step 2: 运行 `npm test -- --runInBand test/unit/recognition-comparison.spec.ts`，确认因函数不存在而失败**
- [ ] **Step 3: 定义 `OcrTextBox`、`OcrPageResult`、`RecognitionComparisonItem` 和 `EvidenceRegion`**
- [ ] **Step 4: 实现输入校验，拒绝空文字、非法分数和越界坐标**
- [ ] **Step 5: 重跑测试并提交 `feat: define OCR evidence protocol`**

### Task 2: 改造 PaddleOCR Skill 为坐标工作进程

**Files:**
- Create: `tools/paddleocr/worker.py`
- Create: `tools/paddleocr/check_env.py`
- Create: `scripts/setup-paddleocr-windows.ps1`

- [ ] **Step 1: 为工作进程协议写输入输出样例测试**

```json
{"id":"job-1","images":["D:/tmp/page-1.png"]}
{"id":"job-1","ok":true,"pages":[{"page":1,"width":2480,"height":3508,"boxes":[]}]}
```

- [ ] **Step 2: 运行协议测试，确认缺少工作进程而失败**
- [ ] **Step 3: 从 Paddle 结果读取 `rec_texts`、`rec_scores` 和 `rec_polys`，输出像素坐标，不只输出纯文本**
- [ ] **Step 4: 进程启动时只加载一次 PP-OCRv6 server 模型，逐行读取 JSON 请求并逐行响应**
- [ ] **Step 5: 添加 GPU 检测；GPU 初始化失败时记录原因并自动回退 CPU，不改变输出协议**
- [ ] **Step 6: 在独立环境中安装依赖并用 `SHAD64结算单-202605.pdf` 的渲染页验证坐标输出**
- [ ] **Step 7: 提交 `feat: add persistent PaddleOCR worker`**

### Task 3: NestJS OCR 适配器

**Files:**
- Create: `server/modules/reconciliation/ocr/paddle-ocr.service.ts`
- Create: `server/modules/reconciliation/ocr/paddle-ocr.service.spec.ts`
- Modify: `server/modules/reconciliation/reconciliation.module.ts`

- [ ] **Step 1: 写失败测试，覆盖成功响应、90 秒超时、进程退出和请求 ID 不匹配**
- [ ] **Step 2: 运行 `npm test -- --runInBand server/modules/reconciliation/ocr/paddle-ocr.service.spec.ts` 并确认失败**
- [ ] **Step 3: 实现单例子进程、请求队列、按 ID 解析响应和自动重启**
- [ ] **Step 4: 限制单任务页数和图片大小，错误信息不包含文件内容或密钥**
- [ ] **Step 5: 重跑测试并提交 `feat: integrate PaddleOCR worker`**

### Task 4: OCR 与视觉结果的确定性比较

**Files:**
- Create: `server/modules/reconciliation/recognition-comparison.ts`
- Modify: `test/unit/recognition-comparison.spec.ts`

- [ ] **Step 1: 写失败测试，覆盖金额逗号标准化、日期标准化、完全一致、冲突、OCR 缺失和视觉缺失**

```ts
expect(compareValue('5,650.47', '5650.47')).toMatchObject({ status: 'confirmed' });
expect(compareValue('5,650.47', '5,650.41')).toMatchObject({ status: 'conflict' });
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现金额、日期、编号和普通文本的类型化标准化，编号禁止转数值**
- [ ] **Step 4: 对全部关键字段强制比较，不使用模型自报置信度决定是否比较**
- [ ] **Step 5: 任一 `conflict` 或 `missing` 生成阻断项；`confirmed` 不覆盖原值**
- [ ] **Step 6: 重跑测试并提交 `feat: compare OCR and vision evidence`**

### Task 5: 明细完整性审计

**Files:**
- Create: `server/modules/reconciliation/detail-integrity.ts`
- Create: `test/unit/detail-integrity.spec.ts`

- [ ] **Step 1: 写失败测试，覆盖业务行、小计、合计、空区域、重复行和缺失合计**
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现行分类和指纹去重，保留原始行序及 OCR 坐标**
- [ ] **Step 4: 区分 `empty_region` 与 `recognition_failed`，后者必须阻断**
- [ ] **Step 5: 比较业务行合计、打印小计和汇总字段，输出可解释异常**
- [ ] **Step 6: 重跑测试并提交 `feat: audit settlement detail completeness`**

### Task 6: 后端并行识别接口

**Files:**
- Modify: `server/modules/reconciliation/reconciliation.controller.ts`
- Modify: `server/modules/reconciliation/vision-extraction.service.ts`
- Modify: `shared/reconciliation.ts`

- [ ] **Step 1: 写控制器失败测试，要求一个任务返回 `vision`、`ocr`、`comparison`、`integrity` 和 `blockingIssues`**
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 新增比较接口，视觉调用与 OCR 并行执行，单路失败也返回明确状态**
- [ ] **Step 4: 将全部关键字段送入独立复读，不再只处理低于 90% 的字段**
- [ ] **Step 5: 只有无阻断项且规则全部通过时返回 `confirmable: true`**
- [ ] **Step 6: 重跑全部后端测试并提交 `feat: orchestrate OCR vision comparison`**

### Task 7: 对比与原图证据界面

**Files:**
- Create: `client/src/components/reconciliation/EvidenceViewer.tsx`
- Create: `client/src/components/reconciliation/MethodComparison.tsx`
- Modify: `client/src/pages/BillRecognitionPage.tsx`
- Modify: `client/src/index.css`

- [ ] **Step 1: 写组件测试，要求冲突显示两边值且确认按钮禁用**
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 增加“综合结果 / 方法对比”视图，按字段展示视觉值、OCR 原文和比较状态**
- [ ] **Step 4: 点击字段时打开对应 PDF 页并按坐标框选 OCR 证据**
- [ ] **Step 5: 增加异常队列，正常字段无需逐项确认；冲突字段允许人工录入并要求修改原因**
- [ ] **Step 6: 修改后重新运行勾稽与门禁，存在阻断项时确认按钮保持禁用**
- [ ] **Step 7: 桌面和移动端截图检查无重叠、表格可横向滚动、文字不溢出**
- [ ] **Step 8: 提交 `feat: add reviewable OCR vision comparison UI`**

### Task 8: 真实样本对比与验收报告

**Files:**
- Create: `scripts/evaluate-settlement-recognition.ts`
- Create: `docs/recognition-comparison-SHAD64.md`

- [ ] **Step 1: 建立 SHAD64 人工真值，只保存业务字段和值，不写入生产识别代码**
- [ ] **Step 2: 对同一 PDF 各运行至少三次纯视觉与 OCR+视觉，记录字段准确、明细完整、冲突和耗时**
- [ ] **Step 3: 生成字段级差异报告和方法统计，不以单次结果下结论**
- [ ] **Step 4: 运行 `npm test -- --runInBand`、`npm run type:check` 和真实 Playwright 上传测试**
- [ ] **Step 5: 确认 API Key 未进入前端构建产物或日志**
- [ ] **Step 6: 提交 `test: evaluate OCR vision settlement recognition`**
