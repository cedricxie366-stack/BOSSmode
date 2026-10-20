# BOSSmode 0.2.0-preview.3 · 先审查，再回复

这次更新让负责人在回复前先检查：有没有讲清对你意味着什么，有没有没解释的黑话，以及技术细节是否过多。

## 对你有什么变化

- 进展、提问和最终答复都要求先检查实际草稿，发现问题先改写，再发送通过检查的文字。
- 默认通俗表达。你明确说自己熟悉某类技术后，才有限增加相关细节，不把一点基础当作什么都懂。
- 说“简单一点”即可恢复通俗表达。成功保存的偏好可在新对话读取；软件不允许保存时，会说明未保存，不绕过权限。
- 原有项目和安装标识不变，不需要重做产品。更新后建议新开对话以加载新规则。

这是预览版。表达检查可能漏检，不是独立事实认证，也不能强制拦住宿主的所有输出。此次做了实际 Codex 合成对话、共享服务和 DSH 干净安装检查，没有重跑完整 DSH 模型与界面流程，也不代表真实用户满意度已通过。详细范围见仓库中的 `release/reply-review-validation.json`。

## 下载与安装

- `builder-mode-0.2.0-preview.3.tgz`：DSH 可安装的插件包。
- `builder-mode-source-preview.tar.gz`：双宿主完整源码和安装说明，通常优先选这个。
- `builder-mode-local-preview.tar.gz`：Codex 精简运行包，不包含开发测试脚本。
- `SHA256SUMS.txt`：用于核对下载文件是否完整。

支持范围仍限已测 Apple 芯片 Mac、Node 24、Codex CLI 0.154.0、DSH 0.2.1-rc.2。模型服务需使用者自己的访问权限与额度。旧版本仍保留。

---

## English

This preview adds actual pre-send wording checks for progress updates, questions and final replies. The lead reviews practical meaning, unnecessary detail, risks and uncertainty; the local checker flags known jargon and excessive technical language.

Plain language is the default. Only an explicit statement of relevant technical background permits limited detail in that area. Users can return to plain language at any time. Successfully saved preferences survive a new conversation; denied saves are disclosed and host permissions are never bypassed.

Existing project data and installation identifiers remain unchanged. Start a new conversation after updating to load the new instructions.

Limits: this is a review workflow, not a universal output interceptor or independent factual certification. Native Codex synthetic dialogue, shared-service checks and clean DSH installation were exercised; this iteration does not repeat the full DSH model/UI journey or certify real user comprehension. See `release/reply-review-validation.json`.

The source archive supports both hosts. The `.tgz` is the DSH-installable package; the local runtime archive is the smaller Codex bundle. Previously tested platform scope and Apache-2.0 licensing are unchanged.
